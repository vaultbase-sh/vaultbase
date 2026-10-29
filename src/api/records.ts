import Elysia, { t } from "elysia";
import type { AuthContext } from "../core/rules.ts";
import type { RequestContextLike } from "../core/filter.ts";
import { accessFor, dataPrincipal, headerBearer, verifyAuthToken } from "../core/sec.ts";
import { ensureSingletonRecord, getCollection } from "../core/collections.ts";
import {
  createRecord,
  deleteRecord,
  getRecord,
  listRecords,
  shapeRecords,
  ReadOnlyCollectionError,
  SingletonRecordError,
  FilterError,
  AccessRuleError,
  clientPaging,
  CascadeForbiddenError,
  PreconditionFailedError,
  RecordBusyError,
  RestrictError,
  updateRecord,
} from "../core/records.ts";
import { ValidationError } from "../core/validate.ts";
import { runWithHookRequest } from "../core/hooks.ts";
import { cascadeRuleCheck, checkRule, recordListRule, buildRequestContext, checkUpdateRule } from "./_rules.ts";
import {
  getHistoryAt,
  listRecordHistory,
  type HistoryListResponse,
} from "../core/record-history.ts";
import { parseFields } from "../core/collections.ts";
import { parseVectorParam, VectorParseError } from "../core/vector.ts";
import { searchVectors } from "../core/vector-search.ts";
import { aggregateRecords, type AggregateOptions } from "../core/aggregate.ts";
import { timeFor } from "../core/perf-metrics.ts";

function readOnlyResponse(set: { status?: number | string }, err: ReadOnlyCollectionError | SingletonRecordError) {
  set.status = 405;
  return { error: err.message, code: 405 };
}

/**
 * Map list-query failures to HTTP: bad user filter → 400; access rule that
 * can't be evaluated → 403 (fail closed). Rule details stay in the server
 * log, not the response. Returns null for anything else.
 */
function listErrorResponse(set: { status?: number | string }, e: unknown) {
  if (e instanceof FilterError) {
    set.status = 400;
    return { error: e.message, code: 400 };
  }
  if (e instanceof AccessRuleError) {
    process.stderr.write(`[records] ${e.message}\n`);
    set.status = 403;
    return { error: "Forbidden", code: 403 };
  }
  return null;
}

/**
 * Compute a record's ETag from its `updated_at` (unix-seconds). Wrapped in
 * weak-ETag form (`W/`) because we don't byte-hash the response — two
 * representations of the same record (different field projections, expand,
 * etc.) get the same tag, which weak ETags allow.
 */
function recordEtag(record: Record<string, unknown> | null | undefined): string | null {
  if (!record) return null;
  // The API surface exposes `updated` (records-core's `rowToMetaAsync`); the
  // raw row uses `updated_at`. Accept either so we can call this with both.
  const u = record["updated"] ?? record["updated_at"];
  if (typeof u !== "number" && typeof u !== "string") return null;
  // updated is whole seconds, so it alone can't tell apart two writes in the
  // same second. Add a hash of the record's content. Callers pass the full
  // record (never a projection) so GET and PATCH/DELETE agree.
  return `W/"${u}-${Bun.hash(JSON.stringify(record)).toString(36)}"`;
}

/** The pre-0.12.1 tag (`W/"<updated>"`), still accepted on If-Match. */
function legacyEtag(record: Record<string, unknown>): string | null {
  const u = record["updated"] ?? record["updated_at"];
  return typeof u === "number" || typeof u === "string" ? `W/"${u}"` : null;
}

/**
 * Parse an `If-Match` / `If-None-Match` header into its individual tags.
 * Accepts the wildcard `*` and quoted strong/weak ETags. Tokens are returned
 * verbatim (with their `W/` prefix preserved); compare via string equality.
 */
function parseIfMatch(header: string): string[] {
  const out: string[] = [];
  // Handle commas, ws, quotes, optional W/ prefix.
  const re = /\s*(?:(W\/)?("(?:[^"\\]|\\.)*")|\*)\s*(?:,|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) {
    if (m[2]) out.push(`${m[1] ? "W/" : ""}${m[2]}`);
    else out.push("*");
  }
  return out;
}

/**
 * Returns `null` when the request's `If-Match` is satisfied (or absent), or a
 * `{ currentEtag }` envelope when the precondition failed and the caller
 * should respond 412. `*` matches any existing record.
 */
function ifMatchFails(request: Request, existing: Record<string, unknown>): { currentEtag: string } | null {
  const header = request.headers.get("if-match");
  if (!header) return null;
  const requested = parseIfMatch(header);
  if (requested.length === 0) return null;
  const current = recordEtag(existing) ?? `W/""`;
  // Clients built before the content hash was added may still send the bare
  // updated_at tag; honour it (with its old whole-second precision).
  const legacy = legacyEtag(existing);
  for (const tag of requested) {
    if (tag === "*") return null;
    // Accept the strong form (`"…"`) for the server's weak tag too — RFC 7232
    // weak compare is safe for PATCH/DELETE here.
    const weak = tag.startsWith("W/") ? tag : `W/${tag}`;
    if (weak === current) return null;
    if (legacy && weak === legacy) return null;
  }
  return { currentEtag: current };
}

/** Non-admin writes validate relation fields as the caller (see WriteGuard). */
function relationsAs(auth: AuthContext | null, request?: Request): { relationsAs?: { auth: AuthContext | null; request?: RequestContextLike | null } } {
  return auth?.type === "admin" ? {} : { relationsAs: { auth, ...(request ? { request: buildRequestContext(request) } : {}) } };
}

/**
 * True when If-Match names specific versions. `*` only asks that the record
 * exists, so it doesn't pin the write to the version that was read.
 */
function ifMatchPinsVersion(request: Request): boolean {
  const header = request.headers.get("if-match");
  return !!header && parseIfMatch(header).some((t) => t !== "*");
}

/** 412 for a write whose If-Match stopped holding while it ran. */
async function preconditionResponse(
  set: { status?: number | string; headers: Record<string, string | number> },
  collection: string,
  id: string,
) {
  set.status = 412;
  const current = recordEtag(await getRecord(collection, id) as unknown as Record<string, unknown> | null);
  if (current) set.headers["ETag"] = current;
  return { error: "Precondition Failed: record was modified", code: 412 };
}

function validationResponse(set: { status?: number | string }, err: ValidationError) {
  set.status = 422;
  return { error: "Validation failed", code: 422, details: err.details };
}

async function getAuthContext(
  request: Request,
  jwtSecret: string
): Promise<AuthContext | null> {
  return await timeFor(request, "auth_verify", async () => {
    const token = headerBearer(request);
    if (!token) return null;
    // Centralized verifier — fixes N-1 admin-token-bypass. Accepts user or
    // admin (records API serves both); checks signature, audience, expiry,
    // issuer, jti revocation, and password_reset_at.
    // API tokens act within their scopes (see `dataPrincipal`).
    const ctx = await verifyAuthToken(token, jwtSecret);
    return dataPrincipal(ctx, accessFor(request));
  });
}

export function makeRecordsPlugin(jwtSecret: string) {
  /** One record by id, under its view rule, with an ETag and If-None-Match. */
  async function getOne(collection: string, id: string, request: Request, set: { status?: number | string; headers: Record<string, string | number> }) {
    const col = await timeFor(request, "collection_load", () => getCollection(collection));
    if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
    const auth = await getAuthContext(request, jwtSecret);
    const record = await timeFor(request, "db_exec", () => getRecord(collection, id));
    if (!record) { set.status = 404; return { error: "Record not found", code: 404 }; }
    if (!checkRule(request, "view_rule", col.name, col.view_rule, auth, record as unknown as Record<string, unknown>)) {
      set.status = 403;
      return { error: "Forbidden", code: 403 };
    }
    // The ETag is of the full record, whatever expand / fields return, so
    // it matches what PATCH and DELETE compare against.
    const etag = recordEtag(record as unknown as Record<string, unknown>);
    if (etag) set.headers["ETag"] = etag;
    // Honor If-None-Match for cheap conditional GETs.
    const inm = request.headers.get("if-none-match");
    if (etag && inm && parseIfMatch(inm).some((t) => t === etag || t === "*")) {
      set.status = 304;
      return null;
    }
    // expand / fields as on a list.
    const q = new URL(request.url).searchParams;
    const expand = q.get("expand") ?? undefined;
    const fields = q.get("fields") ?? undefined;
    const exclude = q.get("exclude") ?? undefined;
    if (!expand && !fields && !exclude) return { data: record };
    const [shaped] = await timeFor(request, "db_exec", () =>
      shapeRecords(col, [record], { expand, fields, exclude, auth, request: buildRequestContext(request) }));
    return { data: shaped };
  }

  /** Update one record by id, under its update rule, with If-Match. */
  async function patchOne(collection: string, id: string, body: unknown, request: Request, set: { status?: number | string; headers: Record<string, string | number> }) {
    const col = await timeFor(request, "collection_load", () => getCollection(collection));
    if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
    const auth = await getAuthContext(request, jwtSecret);
    const existing = await timeFor(request, "db_exec", () => getRecord(collection, id));
    if (!existing) { set.status = 404; return { error: "Record not found", code: 404 }; }
    if (!timeFor(request, "rule_compile", () => checkUpdateRule(
      request, col.name, col.update_rule, auth,
      existing as unknown as Record<string, unknown>,
      (body ?? {}) as Record<string, unknown>,
    ))) {
      set.status = 403;
      return { error: "Forbidden", code: 403 };
    }
    const ifMatch = ifMatchFails(request, existing as unknown as Record<string, unknown>);
    if (ifMatch) {
      set.status = 412;
      set.headers["ETag"] = ifMatch.currentEtag;
      return { error: "Precondition Failed: record was modified", code: 412 };
    }
    try {
      // With If-Match, the write itself re-checks that the record is
      // still the one the precondition was checked against.
      const guard = {
        ...relationsAs(auth, request),
        ...(ifMatchPinsVersion(request) ? { ifUnchanged: existing as unknown as Record<string, unknown> } : {}),
      };
      const record = await timeFor(request, "record_write", () => runWithHookRequest(request, () =>
        updateRecord(collection, id, body as Record<string, unknown>, auth, guard)
      ));
      const etag = recordEtag(record as unknown as Record<string, unknown>);
      if (etag) set.headers["ETag"] = etag;
      return { data: record };
    } catch (e) {
      if (e instanceof ValidationError) return validationResponse(set, e);
      if (e instanceof ReadOnlyCollectionError) return readOnlyResponse(set, e);
      if (e instanceof PreconditionFailedError) return await preconditionResponse(set, collection, id);
      if (e instanceof RecordBusyError) { set.status = 409; return { error: e.message, code: 409 }; }
      throw e;
    }
  }

  return new Elysia({ name: "records" })
    .get(
      "/:collection",
      async ({ params, query, request, set }) => {
        const col = await timeFor(request, "collection_load", () => getCollection(params.collection));
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        // A singleton answers its path with its one record, not a list.
        if (col.type === "singleton") return getOne(col.name, await ensureSingletonRecord(col.name), request, set);
        const auth = await getAuthContext(request, jwtSecret);

        // null = public; "" = admin only; expression rule → applied as filter
        recordListRule(request, col.name, col.list_rule, auth);
        if (col.list_rule === "") {
          if (auth?.type !== "admin") { set.status = 403; return { error: "Forbidden", code: 403 }; }
        }

        const opts: import("../core/records.ts").ListOptions = {
          ...clientPaging(query.page, query.perPage),
          auth,
        };
        if (query.filter) opts.filter = query.filter;
        if (query.sort) opts.sort = query.sort;
        if (query.expand) opts.expand = query.expand;
        if (query.fields) opts.fields = query.fields;
        if (query.exclude) opts.exclude = query.exclude;
        if (query.search) opts.search = query.search;
        if (query.skipTotal === "1" || query.skipTotal === "true") opts.skipTotal = true;
        // Apply expression rule as access filter (admins bypass)
        // Rules see the request: the list rule here, and the related
        // collections' view rules when expanding.
        opts.request = buildRequestContext(request);
        if (col.list_rule && col.list_rule !== "" && auth?.type !== "admin") {
          opts.accessRule = col.list_rule;
        }

        // ── Vector similarity search ───────────────────────────────────────
        // When `nearVector` + `nearVectorField` are present, fetch a filtered
        // candidate set (with `filter` / list_rule still applied so we never
        // rank rows the caller can't see) and re-order by cosine similarity.
        // The caller paginates the *ranked* page in-process, so we pull a
        // larger working set and slice — this is fine up to ~50K candidates;
        // beyond that, switch to sqlite-vec.
        if (query.nearVector && query.nearVectorField) {
          const fields = parseFields(col.fields);
          const vecField = fields.find((f) => f.name === query.nearVectorField && f.type === "vector");
          if (!vecField) {
            set.status = 422;
            return { error: `nearVectorField '${query.nearVectorField}' is not a vector field on '${col.name}'`, code: 422 };
          }
          let queryVec: number[];
          try { queryVec = parseVectorParam(query.nearVector); }
          catch (e) {
            if (e instanceof VectorParseError) {
              set.status = 422;
              return { error: e.message, code: 422 };
            }
            throw e;
          }
          const dims = vecField.options?.dimensions ?? queryVec.length;
          if (queryVec.length !== dims) {
            set.status = 422;
            return { error: `nearVector length ${queryVec.length} does not match field dimensions ${dims}`, code: 422 };
          }

          // Pull a working window. We can't ORDER BY similarity in SQL (yet),
          // so the safe approach is to fetch up to MAX_CANDIDATES rows under
          // the existing access scope and rank in-process.
          // Rank from the parsed-vector cache (see core/vector-search.ts), then
          // load full records for the top K only, through listRecords so
          // fields / expand / the access rule apply exactly as on a list.
          const nearLimit = parseInt(query.nearLimit ?? "", 10);
          const limit = Number.isFinite(nearLimit) ? Math.max(1, Math.min(1000, nearLimit)) : 10;
          const minScore = query.nearMinScore ? parseFloat(query.nearMinScore) : undefined;
          let ranked: Array<{ id: string; score: number }>;
          const loaded: Array<Awaited<ReturnType<typeof listRecords>>["data"][number]> = [];
          try {
            ranked = await searchVectors(col, vecField.name, queryVec, {
              ...(opts.filter !== undefined ? { filter: opts.filter } : {}),
              ...(opts.accessRule !== undefined ? { accessRule: opts.accessRule } : {}),
              ...(opts.request !== undefined ? { request: opts.request } : {}),
              ...(opts.search !== undefined ? { search: opts.search } : {}),
              auth: opts.auth ?? null,
              limit,
              ...(minScore !== undefined && Number.isFinite(minScore) ? { minScore } : {}),
            });
            // Load by id in chunks: the filter parser caps an expression at
            // 50 operands, so one `id = … || …` for more than 25 matches was
            // refused with 400. The ranking already applied the caller's
            // filter; listRecords still applies the access rule.
            const ID_CHUNK = 20;
            for (let i = 0; i < ranked.length; i += ID_CHUNK) {
              const idFilter = ranked.slice(i, i + ID_CHUNK).map((m) => `id = "${m.id.replace(/["\\]/g, "\\$&")}"`).join(" || ");
              const chunk = await listRecords(params.collection, {
                ...opts,
                filter: idFilter,
                page: 1,
                perPage: ID_CHUNK,
                skipTotal: true,
              });
              loaded.push(...chunk.data);
            }
          } catch (e) {
            const r = listErrorResponse(set, e);
            if (r) return r;
            throw e;
          }
          const byId = new Map(loaded.map((r) => [r.id, r]));
          const data = ranked
            .map((m) => {
              const rec = byId.get(m.id);
              return rec ? { ...rec, _score: m.score } : null;
            })
            .filter(Boolean);
          return {
            data,
            page: 1,
            perPage: data.length,
            totalItems: data.length,
            totalPages: 1,
          };
        }

        try {
          return await timeFor(request, "db_exec", () => listRecords(params.collection, opts));
        } catch (e) {
          const r = listErrorResponse(set, e);
          if (r) return r;
          throw e;
        }
      },
      {
        query: t.Object({
          page: t.Optional(t.String()),
          perPage: t.Optional(t.String()),
          filter: t.Optional(t.String()),
          sort: t.Optional(t.String()),
          expand: t.Optional(t.String()),
          fields: t.Optional(t.String()),
          exclude: t.Optional(t.String()),
          skipTotal: t.Optional(t.String()),
          search: t.Optional(t.String()),
          nearVector: t.Optional(t.String()),
          nearVectorField: t.Optional(t.String()),
          nearLimit: t.Optional(t.String()),
          nearMinScore: t.Optional(t.String()),
        }),
      }
    )
    // Aggregates over the rows a list would return. Record ids are UUIDs, so
    // the static `_aggregate` segment never shadows a record.
    .get(
      "/:collection/_aggregate",
      async ({ params, query, request, set }) => {
        const col = await timeFor(request, "collection_load", () => getCollection(params.collection));
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        const auth = await getAuthContext(request, jwtSecret);
        recordListRule(request, col.name, col.list_rule, auth);
        if (col.list_rule === "" && auth?.type !== "admin") {
          set.status = 403; return { error: "Forbidden", code: 403 };
        }
        const opts: AggregateOptions = { auth };
        if (query.agg) opts.agg = query.agg;
        if (query.groupBy) opts.groupBy = query.groupBy;
        if (query.filter) opts.filter = query.filter;
        if (query.search) opts.search = query.search;
        if (query.sort) opts.sort = query.sort;
        if (query.limit) opts.limit = Number(query.limit);
        if (col.list_rule && auth?.type !== "admin") {
          opts.accessRule = col.list_rule;
          opts.request = buildRequestContext(request);
        }
        try {
          return await timeFor(request, "db_exec", () => aggregateRecords(col, opts));
        } catch (e) {
          const r = listErrorResponse(set, e);
          if (r) return r;
          throw e;
        }
      },
      {
        query: t.Object({
          agg: t.Optional(t.String()),
          groupBy: t.Optional(t.String()),
          filter: t.Optional(t.String()),
          search: t.Optional(t.String()),
          sort: t.Optional(t.String()),
          limit: t.Optional(t.String()),
        }),
      }
    )
    .get("/:collection/:id", async ({ params, request, set }) => getOne(params.collection, params.id, request, set))
    .post(
      "/:collection",
      async ({ params, body, request, set }) => {
        const col = await timeFor(request, "collection_load", () => getCollection(params.collection));
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type === "singleton") return readOnlyResponse(set, new SingletonRecordError(col.name, "create"));
        const auth = await getAuthContext(request, jwtSecret);
        // For create, rule evaluates against the incoming body
        // The body is what the rule is about on a create — without it
        // `@request.body.role:isset = false` passes unconditionally.
        if (!timeFor(request, "rule_compile", () => checkRule(
          request, "create_rule", col.name, col.create_rule, auth,
          (body ?? {}) as Record<string, unknown>,
          buildRequestContext(request, (body ?? {}) as Record<string, unknown>, null),
        ))) {
          set.status = 403;
          return { error: "Forbidden", code: 403 };
        }
        try {
          const record = await timeFor(request, "record_write", () => runWithHookRequest(request, () =>
            createRecord(params.collection, body as Record<string, unknown>, auth, relationsAs(auth, request))
          ));
          return { data: record };
        } catch (e) {
          if (e instanceof ValidationError) return validationResponse(set, e);
          if (e instanceof ReadOnlyCollectionError || e instanceof SingletonRecordError) return readOnlyResponse(set, e);
          throw e;
        }
      },
      { body: t.Any() }
    )
    .patch(
      "/:collection/:id",
      async ({ params, body, request, set }) => patchOne(params.collection, params.id, body, request, set),
      { body: t.Any() }
    )
    // A singleton's one record: PATCH the collection path itself.
    .patch(
      "/:collection",
      async ({ params, body, request, set }) => {
        const col = await timeFor(request, "collection_load", () => getCollection(params.collection));
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "singleton") {
          set.status = 405;
          return { error: `Update a record with PATCH /api/v1/${col.name}/<id>; only a singleton collection is updated at its own path`, code: 405 };
        }
        return patchOne(col.name, await ensureSingletonRecord(col.name), body, request, set);
      },
      { body: t.Any() }
    )
    .delete("/:collection/:id", async ({ params, request, set }) => {
      const col = await timeFor(request, "collection_load", () => getCollection(params.collection));
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (col.type === "singleton") return readOnlyResponse(set, new SingletonRecordError(col.name, "delete"));
      const auth = await getAuthContext(request, jwtSecret);
      const existing = await timeFor(request, "db_exec", () => getRecord(params.collection, params.id));
      if (!existing) { set.status = 404; return { error: "Record not found", code: 404 }; }
      if (!timeFor(request, "rule_compile", () =>
        checkRule(request, "delete_rule", col.name, col.delete_rule, auth, existing as unknown as Record<string, unknown>),
      )) {
        set.status = 403;
        return { error: "Forbidden", code: 403 };
      }
      const ifMatch = ifMatchFails(request, existing as unknown as Record<string, unknown>);
      if (ifMatch) {
        set.status = 412;
        set.headers["ETag"] = ifMatch.currentEtag;
        return { error: "Precondition Failed: record was modified", code: 412 };
      }
      try {
        const cascadeAllowed = cascadeRuleCheck(request, auth);
        const guard = {
          ...(ifMatchPinsVersion(request) ? { ifUnchanged: existing as unknown as Record<string, unknown> } : {}),
          ...(cascadeAllowed ? { cascadeAllowed } : {}),
        };
        await timeFor(request, "record_write", () => runWithHookRequest(request, () =>
          deleteRecord(params.collection, params.id, auth, guard)
        ));
      } catch (e) {
        if (e instanceof ValidationError) return validationResponse(set, e);
        if (e instanceof ReadOnlyCollectionError || e instanceof SingletonRecordError) return readOnlyResponse(set, e);
        if (e instanceof PreconditionFailedError) return await preconditionResponse(set, params.collection, params.id);
        if (e instanceof RecordBusyError) { set.status = 409; return { error: e.message, code: 409 }; }
        // Generic on purpose: naming the child collection would tell the
        // caller that related records they can't see exist.
        if (e instanceof CascadeForbiddenError) { set.status = 403; return { error: "Forbidden", code: 403 }; }
        if (e instanceof RestrictError) {
          set.status = 409;
          // Admins get the referencing collections; anyone else a generic
          // answer, since those may be collections they can't see.
          return auth?.type === "admin"
            ? { error: e.message, code: 409, details: e.details }
            : { error: "Cannot delete: the record is referenced by other records", code: 409 };
        }
        throw e;
      }
      return { data: null };
    })

    // ── Record history ──────────────────────────────────────────────────────
    //
    // Both endpoints inherit the parent record's `view_rule` for read access:
    // if you can view the live record, you can read its history. Restore is
    // admin-only — restoring overwrites someone else's edit.

    .get("/:collection/:id/history", async ({ params, query, request, set }) => {
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (col.history_enabled !== 1) {
        set.status = 404;
        return { error: "history is not enabled for this collection", code: 404 };
      }
      const auth = await getAuthContext(request, jwtSecret);
      const existing = await getRecord(params.collection, params.id);
      // Allow listing history rows even after a delete — gate purely on view_rule
      // against the most recent snapshot.
      const recordForRule = (existing ?? (
        await getHistoryAt(params.collection, params.id, Math.floor(Date.now() / 1000))
      )?.snapshot) as Record<string, unknown> | undefined;
      if (!recordForRule) {
        set.status = 404;
        return { error: "Record not found", code: 404 };
      }
      if (!checkRule(request, "view_rule", col.name, col.view_rule, auth, recordForRule)) {
        set.status = 403;
        return { error: "Forbidden", code: 403 };
      }
      const perPage = query.perPage ? parseInt(String(query.perPage), 10) : 50;
      const page = query.page ? parseInt(String(query.page), 10) : 1;
      // Admins see every version. Anyone else sees a version only if the view
      // rule passes against that version as it stood: passing it against the
      // record as it is *now* let a new owner read everything the previous
      // owner wrote. Who made each change is only shown when it was the
      // caller.
      const isAdminCaller = auth?.type === "admin";
      const out: HistoryListResponse = await listRecordHistory(
        params.collection,
        params.id,
        isAdminCaller ? { perPage, page } : {
          perPage, page,
          visible: (e) => checkRule(request, "view_rule", col.name, col.view_rule, auth, e.snapshot),
        },
      );
      if (!isAdminCaller) {
        for (const e of out.data) if (e.actor_id !== (auth?.id ?? null)) e.actor_id = null;
      }
      return { data: out };
    })

    .post("/:collection/:id/restore", async ({ params, query, request, set }) => {
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (col.history_enabled !== 1) {
        set.status = 404;
        return { error: "history is not enabled for this collection", code: 404 };
      }
      const auth = await getAuthContext(request, jwtSecret);
      if (auth?.type !== "admin") {
        set.status = 403;
        return { error: "restore is admin-only", code: 403 };
      }
      const atRaw = query.at;
      if (!atRaw) {
        set.status = 422;
        return { error: "?at=<unix-seconds> is required", code: 422 };
      }
      const at = parseInt(String(atRaw), 10);
      if (!Number.isFinite(at) || at <= 0) {
        set.status = 422;
        return { error: "?at must be a positive unix-seconds integer", code: 422 };
      }
      const entry = await getHistoryAt(params.collection, params.id, at);
      if (!entry) {
        set.status = 404;
        return { error: "no history entry at-or-before that timestamp", code: 404 };
      }

      // Filter out fields managed by records-core (id / created_at / updated_at /
      // file metadata) before passing to update — these are either immutable or
      // get re-set on write.
      const snap = { ...entry.snapshot };
      delete snap["id"];
      delete snap["created_at"];
      delete snap["updated_at"];

      const live = await getRecord(params.collection, params.id);
      if (!live) {
        // V1: restoring a deleted record is not supported because `createRecord`
        // mints its own id. Callers can `POST /api/:collection` with the
        // snapshot body to recreate, accepting that they'll get a new id.
        set.status = 409;
        return { error: "record was deleted; restore-from-deleted is not supported in v1", code: 409 };
      }

      try {
        const result = await runWithHookRequest(request, () =>
          updateRecord(params.collection, params.id, snap, auth),
        );
        return { data: result };
      } catch (e) {
        if (e instanceof ValidationError) return validationResponse(set, e);
        if (e instanceof ReadOnlyCollectionError) return readOnlyResponse(set, e);
        if (e instanceof RecordBusyError) { set.status = 409; return { error: e.message, code: 409 }; }
        throw e;
      }
    });
}
