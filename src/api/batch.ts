import { discardTableReports, flushTableReports } from "../core/table-writes.ts";
import Elysia, { t } from "elysia";
import { db } from "../db/index.ts";
import { getCollection } from "../core/collections.ts";
import { withExclusiveWrite } from "../core/write-gate.ts";
import { AccessRuleError, CascadeForbiddenError, clientPaging, RecordNotFoundError, createRecord, deleteRecord, FilterError, getRecord, hiddenFrom, listRecords, ReadOnlyCollectionError, RecordBusyError, RestrictError, shapeRecords, SingletonRecordError, updateRecord } from "../core/records.ts";
import { bodyForRules, ValidationError } from "../core/validate.ts";
import { cascadeRuleCheck, checkRule, checkRuleOrThrow, recordListRule, RuleDeniedError, buildRequestContext, checkUpdateRule } from "./_rules.ts";
import type { AuthContext } from "../core/rules.ts";
import type { Collection } from "../db/schema.ts";
import { dataPrincipal, headerBearer, peerAddress, verifyAuthToken, type VerifiedAuth } from "../core/sec.ts";
import { batchOpsRateLimit, MAX_BATCH_OPS } from "./ratelimit.ts";
import { normalizeApiPath } from "../core/api-paths.ts";
import { parseViewParams, viewParamsFromUrl } from "../core/view-params.ts";
import { invalidToken } from "./forbidden.ts";

interface BatchRequest {
  method: string;
  url: string;
  body?: unknown;
}

interface BatchResult {
  status: number;
  body: unknown;
}

const MAX_BATCH = MAX_BATCH_OPS;

/** An op of a write batch that answered with an error: the whole batch rolls back. */
class BatchOpError extends Error {
  constructor(readonly result: BatchResult) {
    super("batch op failed");
  }
}

async function extractAuth(request: Request, jwtSecret: string): Promise<VerifiedAuth | null> {
  const token = headerBearer(request);
  if (!token) return null;
  // Centralized verifier — fixes N-1 admin-token-bypass. The principal is
  // resolved per op, so an API token's scopes apply to each one.
  return await verifyAuthToken(token, jwtSecret);
}

function principalFor(ctx: VerifiedAuth | null, op: ParsedOp): AuthContext | null {
  return dataPrincipal(ctx, op.kind === "list" || op.kind === "get" ? "read" : "write");
}

interface ParsedOp {
  kind: "create" | "list" | "get" | "update" | "delete";
  collection: string;
  id?: string;
  query?: URLSearchParams;
}

function parseOp(method: string, urlStr: string): ParsedOp | { error: string } {
  let url: URL;
  try {
    url = new URL(urlStr, "http://internal/");
  } catch {
    return { error: `Invalid url: ${urlStr}` };
  }
  // Accept both versioned (`/api/v1/<collection>...`) and legacy
  // (`/api/<collection>...`) op URLs in batch payloads.
  const path = normalizeApiPath(url.pathname);
  const m = path.match(/^\/api\/([^/]+)(?:\/([^/]+))?\/?$/);
  if (!m) return { error: `Unsupported url: ${urlStr}` };
  const [, collection, id] = m;
  if (!collection || ["admin", "auth", "files", "collections", "health", "batch", "custom"].includes(collection)) {
    return { error: `Unsupported collection in batch: ${collection}` };
  }
  const M = method.toUpperCase();
  if (!id) {
    if (M === "POST") return { kind: "create", collection, query: url.searchParams };
    if (M === "GET")  return { kind: "list",   collection, query: url.searchParams };
    return { error: `Unsupported method ${M} for ${urlStr}` };
  }
  if (M === "GET")    return { kind: "get",    collection, id, query: url.searchParams };
  if (M === "PATCH")  return { kind: "update", collection, id };
  if (M === "PUT")    return { kind: "update", collection, id };
  if (M === "DELETE") return { kind: "delete", collection, id };
  return { error: `Unsupported method ${M} for ${urlStr}` };
}

/** The rule that gates an op (a singleton is listed under its view rule). */
function ruleFor(col: Collection, kind: ParsedOp["kind"]): string | null {
  switch (kind) {
    case "create": return col.create_rule;
    case "list": return col.type === "singleton" ? col.view_rule : col.list_rule;
    case "get": return col.view_rule;
    case "update": return col.update_rule;
    case "delete": return col.delete_rule;
  }
}

/**
 * A written record goes back only to a caller who may view it: the update
 * or create rule letting them write it doesn't let them read it.
 */
function canView(request: Request, col: Collection, auth: AuthContext | null, rec: unknown): boolean {
  return auth?.type === "admin" || checkRule(request, "view_rule", col.name, col.view_rule, auth, rec as Record<string, unknown>);
}

async function dispatchOp(
  request: Request,
  op: ParsedOp,
  body: unknown,
  auth: AuthContext | null
): Promise<BatchResult> {
  // Per-op rule enforcement — same checks the records HTTP layer runs.
  const col = await getCollection(op.collection);
  if (!col) return { status: 404, body: { error: `Collection '${op.collection}' not found`, code: 404 } };
  // As on the REST routes: a hidden collection answers a non-admin as if it
  // didn't exist, before the singleton and view-parameter refusals below
  // name its type.
  if (hiddenFrom(col, auth, ruleFor(col, op.kind))) {
    return { status: 404, body: { error: `Collection '${op.collection}' not found`, code: 404 } };
  }
  if (col.type === "singleton" && (op.kind === "create" || op.kind === "delete")) {
    throw new SingletonRecordError(col.name, op.kind);
  }
  // A view with parameters is read directly: here its rules would see the
  // batch request's own URL, not the read's parameters (view-params.ts).
  if (col.type === "view" && parseViewParams(col.view_params).length > 0) {
    return { status: 400, body: { error: `'${col.name}' takes parameters: read it with GET /api/v1/${col.name}, not in a batch`, code: 400 } };
  }
  switch (op.kind) {
    case "create": {
      const ruleBody = bodyForRules(col, body);
      checkRuleOrThrow(
        request, "create_rule", col.name, col.create_rule, auth,
        ruleBody,
        buildRequestContext(request, ruleBody, null),
      );
      const rec = await createRecord(op.collection, body as Record<string, unknown>, auth, auth?.type === "admin" ? {} : { relationsAs: { auth, request: buildRequestContext(request) } });
      return { status: 201, body: canView(request, col, auth, rec) ? rec : null };
    }
    case "list": {
      // A singleton's one record is read under its view rule, as on the
      // REST path; listing it under the list rule served what view denies.
      const listRule = col.type === "singleton" ? col.view_rule : col.list_rule;
      const allowed = recordListRule(request, col.name, listRule, auth);
      if (!allowed) throw new RuleDeniedError("list_rule");
      const q = op.query ?? new URLSearchParams();
      const opts: Parameters<typeof listRecords>[1] = { ...clientPaging(q.get("page"), q.get("perPage")) };
      if (q.get("filter"))  opts.filter = q.get("filter")!;
      if (q.get("sort"))    opts.sort = q.get("sort")!;
      if (q.get("expand"))  opts.expand = q.get("expand")!;
      if (q.get("fields"))  opts.fields = q.get("fields")!;
      if (q.get("exclude")) opts.exclude = q.get("exclude")!;
      if (q.get("skipTotal") === "1") opts.skipTotal = true;
      opts.auth = auth;
      // Rules see the request, as on the REST list: the list rule here, and
      // the related collections' view rules when expanding.
      opts.request = buildRequestContext(request);
      // Apply expression rule as access filter (admins bypass)
      if (listRule && listRule !== "" && auth?.type !== "admin") {
        opts.accessRule = listRule;
      }
      const result = await listRecords(op.collection, opts);
      return { status: 200, body: result };
    }
    case "get": {
      const rec = await getRecord(op.collection, op.id!);
      if (!rec) return { status: 404, body: { error: "Record not found", code: 404 } };
      checkRuleOrThrow(request, "view_rule", col.name, col.view_rule, auth, rec as unknown as Record<string, unknown>);
      const q = op.query ?? new URLSearchParams();
      const expand = q.get("expand") ?? undefined, fields = q.get("fields") ?? undefined, exclude = q.get("exclude") ?? undefined;
      if (!expand && !fields && !exclude) return { status: 200, body: rec };
      const [shaped] = await shapeRecords(col, [rec], { expand, fields, exclude, auth, request: buildRequestContext(request) });
      return { status: 200, body: shaped };
    }
    case "update": {
      const existing = await getRecord(op.collection, op.id!);
      if (!existing) return { status: 404, body: { error: "Record not found", code: 404 } };
      if (!checkUpdateRule(
        request, col.name, col.update_rule, auth,
        existing as unknown as Record<string, unknown>,
        bodyForRules(col, body),
      )) {
        throw new RuleDeniedError("update_rule");
      }
      const rec = await updateRecord(op.collection, op.id!, body as Record<string, unknown>, auth, auth?.type === "admin" ? {} : { relationsAs: { auth, request: buildRequestContext(request) } });
      return { status: 200, body: canView(request, col, auth, rec) ? rec : null };
    }
    case "delete": {
      const existing = await getRecord(op.collection, op.id!);
      if (!existing) return { status: 404, body: { error: "Record not found", code: 404 } };
      checkRuleOrThrow(request, "delete_rule", col.name, col.delete_rule, auth, existing as unknown as Record<string, unknown>);
      const cascadeAllowed = cascadeRuleCheck(request, auth);
      await deleteRecord(op.collection, op.id!, auth, cascadeAllowed ? { cascadeAllowed } : {});
      return { status: 204, body: null };
    }
  }
}

/** Map an error thrown by request `at` of a batch to its response. */
function batchError(e: unknown, at: number, auth: VerifiedAuth | null, set: { status?: number | string }): { error: string; code: number; details?: unknown } {
  if (e instanceof BatchOpError) {
    set.status = e.result.status;
    const b = e.result.body as { error?: string } | null;
    return { error: `Batch failed at request ${at}: ${b?.error ?? "failed"}`, code: e.result.status };
  }
  if (e instanceof RuleDeniedError) {
    set.status = 403;
    return { error: `Batch failed at request ${at}: forbidden by ${e.ruleName}`, code: 403 };
  }
  if (e instanceof ValidationError) {
    set.status = 422;
    return { error: `Batch failed at request ${at}: ${e.message}`, code: 422, details: e.details };
  }
  if (e instanceof CascadeForbiddenError) {
    set.status = 403;
    return { error: `Batch failed at request ${at}: forbidden`, code: 403 };
  }
  if (e instanceof RestrictError) {
    set.status = 409;
    // As on DELETE /:collection/:id: only admins learn which
    // collections still reference the record.
    return auth?.type === "admin"
      ? { error: `Batch failed at request ${at}: ${e.message}`, code: 409, details: e.details }
      : { error: `Batch failed at request ${at}: the record is referenced by other records`, code: 409 };
  }
  if (e instanceof RecordBusyError) {
    set.status = 409;
    return { error: `Batch failed at request ${at}: ${e.message}`, code: 409 };
  }
  if (e instanceof ReadOnlyCollectionError || e instanceof SingletonRecordError) {
    set.status = 405;
    return { error: `Batch failed at request ${at}: ${e.message}`, code: 405 };
  }
  if (e instanceof RecordNotFoundError) {
    set.status = 404;
    return { error: `Batch failed at request ${at}: ${e.message}`, code: 404 };
  }
  if (e instanceof FilterError) {
    set.status = 400;
    return { error: `Batch failed at request ${at}: ${e.message}`, code: 400 };
  }
  if (e instanceof AccessRuleError) {
    process.stderr.write(`[batch] ${e.message}\n`);
    set.status = 403;
    return { error: `Batch failed at request ${at}: forbidden by list_rule`, code: 403 };
  }
  const msg = e instanceof Error ? e.message : String(e);
  set.status = 500;
  return { error: `Batch failed at request ${at}: ${msg}`, code: 500 };
}

/** `rateLimit: true` charges each op (the server, where the rate-limit plugin runs too). */
export function makeBatchPlugin(jwtSecret: string, opts: { rateLimit?: boolean } = {}) {
  const rateLimit = opts.rateLimit ?? false;
  return new Elysia({ name: "batch" }).post(
    "/batch",
    async ({ request, body, set }) => {
      const auth = await extractAuth(request, jwtSecret);
      // A token that doesn't verify answers 401 for the whole batch (0.44;
      // every op used to run as anonymous). An API token's scopes are judged
      // per op, below, once the ops are parsed.
      if (!auth && headerBearer(request)) return invalidToken(set, "invalid");
      const requests = body.requests;
      if (!Array.isArray(requests) || requests.length === 0) {
        set.status = 422; return { error: "requests array required", code: 422 };
      }
      if (requests.length > MAX_BATCH) {
        set.status = 422; return { error: `Max ${MAX_BATCH} requests per batch`, code: 422 };
      }
      // Every op's rules see the batch URL's query, and no op reads a view
      // with parameters: `params[...]` there would only reach rules (a joined
      // view's, an expanded one's) as values no row was read with.
      if (viewParamsFromUrl(new URL(request.url).searchParams)) {
        set.status = 400; return { error: "A batch request takes no params[...]; read a view with parameters with GET /api/v1/<view>", code: 400 };
      }

      // Pre-parse to fail fast on invalid URLs/methods
      const parsed: ParsedOp[] = [];
      for (let i = 0; i < requests.length; i++) {
        const r = requests[i] as BatchRequest;
        const p = parseOp(r.method ?? "", r.url ?? "");
        if ("error" in p) {
          set.status = 422; return { error: `Request ${i}: ${p.error}`, code: 422 };
        }
        parsed.push(p);
      }
      // An API token without the scope for one of the ops: 401 for the whole
      // batch, before any op runs (0.44; that op used to run as anonymous,
      // so a read-only token could still write wherever anyone could).
      if (auth && parsed.some((op) => !principalFor(auth, op))) return invalidToken(set, "scope");

      // A batch of reads changes nothing, so it runs without the exclusive
      // write gate: holding it stalled every write in the process for as
      // long as up to 100 lists took. Each read sees committed data; there
      // is no snapshot across the batch.
      if (parsed.every((op) => op.kind === "list" || op.kind === "get")) {
        const results: BatchResult[] = [];
        try {
          for (let i = 0; i < parsed.length; i++) {
            results.push(await dispatchOp(request, parsed[i]!, requests[i]!.body, principalFor(auth, parsed[i]!)));
          }
          return { data: results };
        } catch (e) {
          return batchError(e, results.length, auth, set);
        }
      }

      // A write batch holds the exclusive write gate for its whole run, so a
      // list in it (a filtered scan, up to 99 of them) stalled every record
      // write in the process. Lists go in a read-only batch; a get by id is
      // cheap and stays allowed.
      const listAt = parsed.findIndex((op) => op.kind === "list");
      if (listAt !== -1) {
        set.status = 422;
        return { error: `Request ${listAt}: a batch that writes can't list records; send lists in a separate batch of reads`, code: 422 };
      }

      // Atomic: one transaction, committed or rolled back as a whole. It
      // lives on the shared connection and spans awaits, so the write gate
      // keeps every other record write (and other batches) out until it
      // finishes. SQLite's write lock is taken up front: started deferred,
      // the transaction read first (a table's columns, a relation), and its
      // first write then failed at once with "database is locked" whenever
      // another connection held the lock, the background checkpointer
      // among them; a read can't wait for a writer and keep its snapshot.
      return withExclusiveWrite(async (tx) => {
        const results: BatchResult[] = [];
        try {
          await db.transaction(async () => {
            for (let i = 0; i < parsed.length; i++) {
              const result = await dispatchOp(request, parsed[i]!, requests[i]!.body, principalFor(auth, parsed[i]!));
              // A missing record or collection comes back as a result, not
              // a throw; it fails the batch all the same.
              if (result.status >= 400) throw new BatchOpError(result);
              results.push(result);
            }
          });
          flushTableReports();
          tx.commit(); // realtime / webhooks / after-hooks for the committed writes
          return { data: results };
        } catch (e) {
          discardTableReports();
          tx.rollback();
          return batchError(e, results.length, auth, set);
        }
      });
    },
    {
      // Each op is charged as if sent on its own. This hook is on this route
      // only, so other routes' bodies stay unread (see makeRateLimitPlugin).
      beforeHandle: async ({ request, server, set, body }) => {
        if (!rateLimit) return;
        const limited = await batchOpsRateLimit(request, peerAddress(request, server), jwtSecret, body.requests);
        if (limited) {
          set.status = 429;
          set.headers["Retry-After"] = String(limited.retryAfter);
          return limited.body;
        }
      },
      body: t.Object({
        requests: t.Array(
          t.Object({
            method: t.String(),
            url: t.String(),
            body: t.Optional(t.Any()),
          })
        ),
      }),
    }
  );
}
