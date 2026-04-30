import Elysia, { t } from "elysia";
import * as jose from "jose";
import { timeFor } from "../core/perf-metrics.ts";
import {
  appendLogEntry,
  listLogDates,
  readLogs,
  searchLogs,
  type LogEntry,
  type LogRuleEval,
} from "../core/file-logger.ts";
import { clearRequestContext, getRuleEvals } from "../core/request-context.ts";

const SKIP_PREFIXES = ["/_/", "/api/admin/logs", "/realtime", "/api/health"];

function shouldSkip(path: string): boolean {
  return SKIP_PREFIXES.some((p) => path.startsWith(p));
}

export interface AuthLogContext {
  id: string;
  type: "user" | "admin";
  email?: string;
  /** Admin id from the JWT's `impersonated_by` claim, if present. */
  impersonated_by?: string;
}

export async function insertLog(
  method: string,
  path: string,
  status: number,
  duration_ms: number,
  ip: string | null,
  auth: AuthLogContext | null,
  rules?: LogRuleEval[]
): Promise<void> {
  const tsSec = Math.floor(Date.now() / 1000);
  const entry: LogEntry = {
    id: crypto.randomUUID(),
    ts: new Date(tsSec * 1000).toISOString(),
    created_at: tsSec,
    method,
    path,
    status,
    duration_ms,
    ip,
    auth_id: auth?.id ?? null,
    auth_type: auth?.type ?? null,
    auth_email: auth?.email ?? null,
    auth_impersonated_by: auth?.impersonated_by ?? null,
  };
  if (rules && rules.length > 0) entry.rules = rules;
  // Recorded inside the request's perf timer at the call site below — keep
  // this function pure so it stays callable from non-request paths.
  appendLogEntry(entry);
}

export type RuleOutcomeFilter = "all" | "any" | "allow" | "deny" | "filter";

export interface ListLogsOptions {
  page: number;
  perPage: number;
  method: string;
  status: string;
  includeAdmin: boolean;
  search?: string;
  minDuration?: number;
  /**
   * Filter by per-request rule outcome (records-API requests carry one or more
   * `rules[]` evaluations on the log entry):
   *   - "all"    → no filter (default)
   *   - "any"    → only entries that have any rule eval at all
   *   - "allow"  → at least one rule with outcome="allow"
   *   - "deny"   → at least one rule with outcome="deny"
   *   - "filter" → at least one rule with outcome="filter" (list_rule applied as SQL filter)
   */
  ruleOutcome?: RuleOutcomeFilter;
}

function matches(e: LogEntry, opts: ListLogsOptions): boolean {
  if (!opts.includeAdmin && e.path.startsWith("/api/admin/")) return false;
  if (opts.method !== "all" && e.method !== opts.method) return false;
  if (opts.status === "2xx" && !(e.status >= 200 && e.status < 300)) return false;
  if (opts.status === "4xx" && !(e.status >= 400 && e.status < 500)) return false;
  if (opts.status === "5xx" && !(e.status >= 500))                   return false;
  if (opts.search) {
    const q = opts.search.toLowerCase();
    const haystack = [
      e.path,
      e.message ?? "",
      e.hook_name ?? "",
      e.hook_event ?? "",
      e.hook_collection ?? "",
    ].join(" ").toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  if (typeof opts.minDuration === "number" && opts.minDuration > 0 && e.duration_ms < opts.minDuration) return false;
  if (opts.ruleOutcome && opts.ruleOutcome !== "all") {
    const rules = e.rules ?? [];
    if (rules.length === 0) return false;
    if (opts.ruleOutcome === "any") return true;
    if (!rules.some((r) => r.outcome === opts.ruleOutcome)) return false;
  }
  return true;
}

const READ_CAP = 50_000;

export async function listLogs(opts: ListLogsOptions) {
  const { page, perPage } = opts;
  const all = await readLogs({ limit: READ_CAP });
  const filtered = all.filter((e) => matches(e, opts));
  const totalItems = filtered.length;
  const offset = (page - 1) * perPage;
  const data = filtered.slice(offset, offset + perPage);
  return {
    data,
    page,
    perPage,
    totalItems,
    totalPages: Math.ceil(totalItems / perPage),
  };
}

export async function extractAuth(request: Request, secret: Uint8Array): Promise<AuthLogContext | null> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return null;
  try {
    const { payload } = await jose.jwtVerify(token, secret);
    const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
    if (aud !== "user" && aud !== "admin") return null;
    const ctx: AuthLogContext = {
      id: payload["id"] as string,
      type: aud as "user" | "admin",
    };
    if (typeof payload["email"] === "string") ctx.email = payload["email"];
    if (typeof payload["impersonated_by"] === "string") ctx.impersonated_by = payload["impersonated_by"];
    return ctx;
  } catch {
    return null;
  }
}

export function makeLogsPlugin(jwtSecret: string) {
  const timings = new WeakMap<Request, number>();
  const secret = new TextEncoder().encode(jwtSecret);

  return new Elysia({ name: "logs" })
    .onRequest(({ request }) => {
      timings.set(request, Date.now());
    })
    .onAfterHandle({ as: "global" }, async ({ request, set }) => {
      const path = new URL(request.url).pathname;
      if (shouldSkip(path)) return;
      const start = timings.get(request) ?? Date.now();
      timings.delete(request);
      const ms = Date.now() - start;
      const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
      const auth = await extractAuth(request, secret);
      const rules = getRuleEvals(request);
      clearRequestContext(request);
      void timeFor(request, "log_write", () => insertLog(request.method, path, Number(set.status ?? 200), ms, ip, auth, rules));
    })
    .onError({ as: "global" }, async ({ request, error }) => {
      const path = new URL(request.url).pathname;
      if (shouldSkip(path)) return;
      const start = timings.get(request) ?? Date.now();
      timings.delete(request);
      const ms = Date.now() - start;
      const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
      const status = "status" in error ? Number((error as { status: number }).status) : 500;
      const auth = await extractAuth(request, secret);
      const rules = getRuleEvals(request);
      clearRequestContext(request);
      void timeFor(request, "log_write", () => insertLog(request.method, path, status, ms, ip, auth, rules));
    })
    .get(
      "/api/admin/logs",
      async ({ request, query, set }) => {
        const token = request.headers.get("authorization")?.replace("Bearer ", "");
        if (!token) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
        try {
          await jose.jwtVerify(token, secret, { audience: "admin" });
        } catch {
          set.status = 401;
          return { error: "Unauthorized", code: 401 };
        }
        const page = Math.max(1, parseInt(query.page ?? "1") || 1);
        const perPage = Math.min(200, Math.max(1, parseInt(query.perPage ?? "50") || 50));
        const minDuration = query.minDuration ? parseInt(query.minDuration) || 0 : 0;
        const opts: ListLogsOptions = {
          page,
          perPage,
          method: query.method ?? "all",
          status: query.status ?? "all",
          includeAdmin: query.includeAdmin === "true",
          minDuration,
        };
        if (query.search) opts.search = query.search;
        if (query.ruleOutcome && ["all", "any", "allow", "deny", "filter"].includes(query.ruleOutcome)) {
          opts.ruleOutcome = query.ruleOutcome as RuleOutcomeFilter;
        }
        return listLogs(opts);
      },
      {
        query: t.Object({
          page: t.Optional(t.String()),
          perPage: t.Optional(t.String()),
          method: t.Optional(t.String()),
          status: t.Optional(t.String()),
          includeAdmin: t.Optional(t.String()),
          search: t.Optional(t.String()),
          minDuration: t.Optional(t.String()),
          ruleOutcome: t.Optional(t.String()),
        }),
      }
    )
    .get("/api/admin/logs/files", async ({ request, set }) => {
      const token = request.headers.get("authorization")?.replace("Bearer ", "");
      if (!token) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      try { await jose.jwtVerify(token, secret, { audience: "admin" }); }
      catch { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      return { data: listLogDates() };
    })
    .post(
      "/api/admin/logs/search",
      async ({ request, body, set }) => {
        const token = request.headers.get("authorization")?.replace("Bearer ", "");
        if (!token) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
        try { await jose.jwtVerify(token, secret, { audience: "admin" }); }
        catch { set.status = 401; return { error: "Unauthorized", code: 401 }; }
        if (!body.jsonpath || typeof body.jsonpath !== "string") {
          set.status = 422; return { error: "jsonpath required", code: 422 };
        }
        const opts: { from?: string; to?: string; limit?: number } = {};
        if (body.from) opts.from = body.from;
        if (body.to) opts.to = body.to;
        if (typeof body.limit === "number" && body.limit > 0) opts.limit = Math.min(5000, body.limit);
        const result = await searchLogs(body.jsonpath, opts);
        return { data: result };
      },
      {
        body: t.Object({
          jsonpath: t.String(),
          from: t.Optional(t.String()),
          to: t.Optional(t.String()),
          limit: t.Optional(t.Number()),
        }),
      }
    );
}
