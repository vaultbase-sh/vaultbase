import type { Database } from "bun:sqlite";
import Elysia, { t } from "elysia";
import { getDb } from "../db/client.ts";
import { getCollection } from "../core/collections.ts";
import { createRecord, deleteRecord, getRecord, listRecords, ReadOnlyCollectionError, RestrictError, updateRecord } from "../core/records.ts";
import { ValidationError } from "../core/validate.ts";
import { checkRuleOrThrow, recordListRule, RuleDeniedError } from "./_rules.ts";
import type { AuthContext } from "../core/rules.ts";
import { verifyAuthToken } from "../core/sec.ts";
import { normalizeApiPath } from "../core/api-paths.ts";

interface BatchRequest {
  method: string;
  url: string;
  body?: unknown;
}

interface BatchResult {
  status: number;
  body: unknown;
}

const MAX_BATCH = 100;

async function extractAuth(request: Request, jwtSecret: string): Promise<AuthContext | null> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return null;
  // Centralized verifier — fixes N-1 admin-token-bypass. Accept user or admin.
  const ctx = await verifyAuthToken(token, jwtSecret);
  if (!ctx || (ctx.type !== "user" && ctx.type !== "admin")) return null;
  const out: AuthContext = { id: ctx.id, type: ctx.type };
  if (ctx.email) out.email = ctx.email;
  return out;
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

async function dispatchOp(
  request: Request,
  op: ParsedOp,
  body: unknown,
  auth: AuthContext | null
): Promise<BatchResult> {
  // Per-op rule enforcement — same checks the records HTTP layer runs.
  const col = await getCollection(op.collection);
  if (!col) return { status: 404, body: { error: `Collection '${op.collection}' not found`, code: 404 } };

  switch (op.kind) {
    case "create": {
      checkRuleOrThrow(request, "create_rule", col.name, col.create_rule, auth, (body ?? {}) as Record<string, unknown>);
      const rec = await createRecord(op.collection, body as Record<string, unknown>, auth);
      return { status: 201, body: rec };
    }
    case "list": {
      const allowed = recordListRule(request, col.name, col.list_rule, auth);
      if (!allowed) throw new RuleDeniedError("list_rule");
      const q = op.query ?? new URLSearchParams();
      const opts: Parameters<typeof listRecords>[1] = {};
      if (q.get("page"))    opts.page = parseInt(q.get("page")!) || 1;
      if (q.get("perPage")) opts.perPage = parseInt(q.get("perPage")!) || 30;
      if (q.get("filter"))  opts.filter = q.get("filter")!;
      if (q.get("sort"))    opts.sort = q.get("sort")!;
      if (q.get("expand"))  opts.expand = q.get("expand")!;
      if (q.get("fields"))  opts.fields = q.get("fields")!;
      if (q.get("skipTotal") === "1") opts.skipTotal = true;
      opts.auth = auth;
      // Apply expression rule as access filter (admins bypass)
      if (col.list_rule && col.list_rule !== "" && auth?.type !== "admin") {
        opts.accessRule = col.list_rule;
      }
      const result = await listRecords(op.collection, opts);
      return { status: 200, body: result };
    }
    case "get": {
      const rec = await getRecord(op.collection, op.id!);
      if (!rec) return { status: 404, body: { error: "Record not found", code: 404 } };
      checkRuleOrThrow(request, "view_rule", col.name, col.view_rule, auth, rec as unknown as Record<string, unknown>);
      return { status: 200, body: rec };
    }
    case "update": {
      const existing = await getRecord(op.collection, op.id!);
      if (!existing) return { status: 404, body: { error: "Record not found", code: 404 } };
      checkRuleOrThrow(request, "update_rule", col.name, col.update_rule, auth, existing as unknown as Record<string, unknown>);
      const rec = await updateRecord(op.collection, op.id!, body as Record<string, unknown>, auth);
      return { status: 200, body: rec };
    }
    case "delete": {
      const existing = await getRecord(op.collection, op.id!);
      if (!existing) return { status: 404, body: { error: "Record not found", code: 404 } };
      checkRuleOrThrow(request, "delete_rule", col.name, col.delete_rule, auth, existing as unknown as Record<string, unknown>);
      await deleteRecord(op.collection, op.id!, auth);
      return { status: 204, body: null };
    }
  }
}

export function makeBatchPlugin(jwtSecret: string) {
  return new Elysia({ name: "batch" }).post(
    "/batch",
    async ({ request, body, set }) => {
      const auth = await extractAuth(request, jwtSecret);
      const requests = body.requests;
      if (!Array.isArray(requests) || requests.length === 0) {
        set.status = 422; return { error: "requests array required", code: 422 };
      }
      if (requests.length > MAX_BATCH) {
        set.status = 422; return { error: `Max ${MAX_BATCH} requests per batch`, code: 422 };
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

      const client = (getDb() as unknown as { $client: Database }).$client;
      // Atomic: BEGIN ... COMMIT or ROLLBACK
      client.exec("BEGIN");
      const results: BatchResult[] = [];
      try {
        for (let i = 0; i < parsed.length; i++) {
          const result = await dispatchOp(request, parsed[i]!, requests[i]!.body, auth);
          results.push(result);
        }
        client.exec("COMMIT");
        return { data: results };
      } catch (e) {
        client.exec("ROLLBACK");
        if (e instanceof RuleDeniedError) {
          set.status = 403;
          return { error: `Batch failed at request ${results.length}: forbidden by ${e.ruleName}`, code: 403 };
        }
        if (e instanceof ValidationError) {
          set.status = 422;
          return { error: `Batch failed at request ${results.length}: ${e.message}`, code: 422, details: e.details };
        }
        if (e instanceof RestrictError) {
          set.status = 409;
          return { error: `Batch failed at request ${results.length}: ${e.message}`, code: 409, details: e.details };
        }
        if (e instanceof ReadOnlyCollectionError) {
          set.status = 405;
          return { error: `Batch failed at request ${results.length}: ${e.message}`, code: 405 };
        }
        const msg = e instanceof Error ? e.message : String(e);
        set.status = 500;
        return { error: `Batch failed at request ${results.length}: ${msg}`, code: 500 };
      }
    },
    {
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
