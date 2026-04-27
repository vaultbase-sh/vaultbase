import type { Database } from "bun:sqlite";
import Elysia, { t } from "elysia";
import * as jose from "jose";
import { getDb } from "../db/client.ts";
import { createRecord, deleteRecord, getRecord, listRecords, updateRecord } from "../core/records.ts";
import { ValidationError } from "../core/validate.ts";
import type { AuthContext } from "../core/rules.ts";

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
  try {
    const { payload } = await jose.jwtVerify(token, new TextEncoder().encode(jwtSecret));
    const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
    if (aud !== "user" && aud !== "admin") return null;
    const ctx: AuthContext = {
      id: payload["id"] as string,
      type: aud as "user" | "admin",
    };
    if (typeof payload["email"] === "string") ctx.email = payload["email"];
    return ctx;
  } catch {
    return null;
  }
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
  const m = url.pathname.match(/^\/api\/([^/]+)(?:\/([^/]+))?\/?$/);
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

async function dispatchOp(op: ParsedOp, body: unknown, auth: AuthContext | null): Promise<BatchResult> {
  switch (op.kind) {
    case "create": {
      const rec = await createRecord(op.collection, body as Record<string, unknown>, auth);
      return { status: 201, body: rec };
    }
    case "list": {
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
      const result = await listRecords(op.collection, opts);
      return { status: 200, body: result };
    }
    case "get": {
      const rec = await getRecord(op.collection, op.id!);
      if (!rec) return { status: 404, body: { error: "Record not found", code: 404 } };
      return { status: 200, body: rec };
    }
    case "update": {
      const rec = await updateRecord(op.collection, op.id!, body as Record<string, unknown>, auth);
      return { status: 200, body: rec };
    }
    case "delete": {
      await deleteRecord(op.collection, op.id!, auth);
      return { status: 204, body: null };
    }
  }
}

export function makeBatchPlugin(jwtSecret: string) {
  return new Elysia({ name: "batch" }).post(
    "/api/batch",
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
          const result = await dispatchOp(parsed[i]!, requests[i]!.body, auth);
          results.push(result);
        }
        client.exec("COMMIT");
        return { data: results };
      } catch (e) {
        client.exec("ROLLBACK");
        if (e instanceof ValidationError) {
          set.status = 422;
          return { error: `Batch failed at request ${results.length}: ${e.message}`, code: 422, details: e.details };
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
