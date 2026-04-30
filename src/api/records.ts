import Elysia, { t } from "elysia";
import type { AuthContext } from "../core/rules.ts";
import { verifyAuthToken } from "../core/sec.ts";
import { getCollection } from "../core/collections.ts";
import {
  createRecord,
  deleteRecord,
  getRecord,
  listRecords,
  ReadOnlyCollectionError,
  RestrictError,
  updateRecord,
} from "../core/records.ts";
import { ValidationError } from "../core/validate.ts";
import { runWithHookRequest } from "../core/hooks.ts";
import { checkRule, recordListRule } from "./_rules.ts";
import {
  getHistoryAt,
  listRecordHistory,
  type HistoryListResponse,
} from "../core/record-history.ts";
import { parseFields } from "../core/collections.ts";
import { parseVectorParam, topK, VectorParseError } from "../core/vector.ts";
import { timeFor } from "../core/perf-metrics.ts";

function readOnlyResponse(set: { status?: number | string }, err: ReadOnlyCollectionError) {
  set.status = 405;
  return { error: err.message, code: 405 };
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
  return `W/"${u}"`;
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
  for (const tag of requested) {
    if (tag === "*") return null;
    if (tag === current) return null;
    // Allow a strong-form quoted updated_at (`"123"`) to match the server's
    // weak form (`W/"123"`) — RFC 7232 says weak compare is safe for
    // PATCH/DELETE in this scenario, so we accept either.
    if (`W/${tag}` === current) return null;
    if (tag === current.replace(/^W\//, "")) return null;
  }
  return { currentEtag: current };
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
    const token = request.headers.get("authorization")?.replace("Bearer ", "");
    if (!token) return null;
    // Centralized verifier — fixes N-1 admin-token-bypass. Accepts user or
    // admin (records API serves both); checks signature, audience, expiry,
    // issuer, jti revocation, and password_reset_at.
    const ctx = await verifyAuthToken(token, jwtSecret);
    if (!ctx || (ctx.type !== "user" && ctx.type !== "admin")) return null;
    const out: AuthContext = { id: ctx.id, type: ctx.type };
    if (ctx.email) out.email = ctx.email;
    return out;
  });
}

export function makeRecordsPlugin(jwtSecret: string) {
  return new Elysia({ name: "records" })
    .get(
      "/api/:collection",
      async ({ params, query, request, set }) => {
        const col = await timeFor(request, "collection_load", () => getCollection(params.collection));
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        const auth = await getAuthContext(request, jwtSecret);

        // null = public; "" = admin only; expression rule → applied as filter
        recordListRule(request, col.name, col.list_rule, auth);
        if (col.list_rule === "") {
          if (auth?.type !== "admin") { set.status = 403; return { error: "Forbidden", code: 403 }; }
        }

        const opts: import("../core/records.ts").ListOptions = {
          page: query.page ? parseInt(query.page) : 1,
          perPage: query.perPage ? parseInt(query.perPage) : 30,
          auth,
        };
        if (query.filter) opts.filter = query.filter;
        if (query.sort) opts.sort = query.sort;
        if (query.expand) opts.expand = query.expand;
        if (query.fields) opts.fields = query.fields;
        if (query.skipTotal === "1" || query.skipTotal === "true") opts.skipTotal = true;
        // Apply expression rule as access filter (admins bypass)
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
          const MAX_CANDIDATES = 10_000;
          const candidatePage = await listRecords(params.collection, {
            ...opts,
            page: 1,
            perPage: MAX_CANDIDATES,
            skipTotal: true,
          });

          const candidates = candidatePage.data
            .map((r) => {
              const v = r[query.nearVectorField as string];
              return Array.isArray(v) ? { id: r.id as string, vector: v as number[], record: r } : null;
            })
            .filter((x): x is { id: string; vector: number[]; record: typeof candidatePage.data[number] } => x !== null);

          const limit = query.nearLimit ? Math.max(1, Math.min(1000, parseInt(query.nearLimit))) : 10;
          const ranked = topK({
            query: queryVec,
            candidates: candidates.map((c) => ({ id: c.id, vector: c.vector })),
            limit,
            ...(query.nearMinScore ? { minScore: parseFloat(query.nearMinScore) } : {}),
          });
          const byId = new Map(candidates.map((c) => [c.id, c.record]));
          const data = ranked
            .map((m) => {
              const rec = byId.get(m.id);
              if (!rec) return null;
              return { ...rec, _score: m.score };
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

        return await timeFor(request, "db_exec", () => listRecords(params.collection, opts));
      },
      {
        query: t.Object({
          page: t.Optional(t.String()),
          perPage: t.Optional(t.String()),
          filter: t.Optional(t.String()),
          sort: t.Optional(t.String()),
          expand: t.Optional(t.String()),
          fields: t.Optional(t.String()),
          skipTotal: t.Optional(t.String()),
          nearVector: t.Optional(t.String()),
          nearVectorField: t.Optional(t.String()),
          nearLimit: t.Optional(t.String()),
          nearMinScore: t.Optional(t.String()),
        }),
      }
    )
    .get("/api/:collection/:id", async ({ params, request, set }) => {
      const col = await timeFor(request, "collection_load", () => getCollection(params.collection));
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      const auth = await getAuthContext(request, jwtSecret);
      const record = await timeFor(request, "db_exec", () => getRecord(params.collection, params.id));
      if (!record) { set.status = 404; return { error: "Record not found", code: 404 }; }
      if (!checkRule(request, "view_rule", col.name, col.view_rule, auth, record as unknown as Record<string, unknown>)) {
        set.status = 403;
        return { error: "Forbidden", code: 403 };
      }
      const etag = recordEtag(record as unknown as Record<string, unknown>);
      if (etag) set.headers["ETag"] = etag;
      // Honor If-None-Match for cheap conditional GETs.
      const inm = request.headers.get("if-none-match");
      if (etag && inm && parseIfMatch(inm).some((t) => t === etag || t === "*")) {
        set.status = 304;
        return null;
      }
      return { data: record };
    })
    .post(
      "/api/:collection",
      async ({ params, body, request, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        const auth = await getAuthContext(request, jwtSecret);
        // For create, rule evaluates against the incoming body
        if (!checkRule(request, "create_rule", col.name, col.create_rule, auth, (body ?? {}) as Record<string, unknown>)) {
          set.status = 403;
          return { error: "Forbidden", code: 403 };
        }
        try {
          const record = await runWithHookRequest(request, () =>
            createRecord(params.collection, body as Record<string, unknown>, auth)
          );
          return { data: record };
        } catch (e) {
          if (e instanceof ValidationError) return validationResponse(set, e);
          if (e instanceof ReadOnlyCollectionError) return readOnlyResponse(set, e);
          throw e;
        }
      },
      { body: t.Any() }
    )
    .patch(
      "/api/:collection/:id",
      async ({ params, body, request, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        const auth = await getAuthContext(request, jwtSecret);
        const existing = await getRecord(params.collection, params.id);
        if (!existing) { set.status = 404; return { error: "Record not found", code: 404 }; }
        if (!checkRule(request, "update_rule", col.name, col.update_rule, auth, existing as unknown as Record<string, unknown>)) {
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
          const record = await runWithHookRequest(request, () =>
            updateRecord(params.collection, params.id, body as Record<string, unknown>, auth)
          );
          const etag = recordEtag(record as unknown as Record<string, unknown>);
          if (etag) set.headers["ETag"] = etag;
          return { data: record };
        } catch (e) {
          if (e instanceof ValidationError) return validationResponse(set, e);
          if (e instanceof ReadOnlyCollectionError) return readOnlyResponse(set, e);
          throw e;
        }
      },
      { body: t.Any() }
    )
    .delete("/api/:collection/:id", async ({ params, request, set }) => {
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      const auth = await getAuthContext(request, jwtSecret);
      const existing = await getRecord(params.collection, params.id);
      if (!existing) { set.status = 404; return { error: "Record not found", code: 404 }; }
      if (!checkRule(request, "delete_rule", col.name, col.delete_rule, auth, existing as unknown as Record<string, unknown>)) {
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
        await runWithHookRequest(request, () =>
          deleteRecord(params.collection, params.id, auth)
        );
      } catch (e) {
        if (e instanceof ValidationError) return validationResponse(set, e);
        if (e instanceof ReadOnlyCollectionError) return readOnlyResponse(set, e);
        if (e instanceof RestrictError) {
          set.status = 409;
          return { error: e.message, code: 409, details: e.details };
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

    .get("/api/:collection/:id/history", async ({ params, query, request, set }) => {
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
      const out: HistoryListResponse = await listRecordHistory(
        params.collection,
        params.id,
        { perPage, page },
      );
      return { data: out };
    })

    .post("/api/:collection/:id/restore", async ({ params, query, request, set }) => {
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
        throw e;
      }
    });
}
