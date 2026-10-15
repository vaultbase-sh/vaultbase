/**
 * Admin actions audit log.
 *
 * Wired as a global Elysia `onAfterHandle` that fires for every state-changing
 * request to `/api/admin/*` (POST/PATCH/PUT/DELETE; not GET). Each row
 * captures actor + action + target + status + IP, in append-only form.
 *
 * Append-only: no UPDATE / DELETE paths through application code, except
 * the opt-in `audit.retention_days` prune in maintenance.ts.
 */
import { eq, desc, and, gte, lte, like, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { auditLog } from "../db/schema.ts";
import { clientIp as trustedIp } from "./sec.ts";
import { normalizeApiPath } from "./api-paths.ts";

/** The client IP, by the trusted-proxy rule (see sec.ts clientIp). */
function clientIp(request: Request): string | null {
  return trustedIp(request);
}

/** Verbs we audit. GET reads are intentionally omitted (volume + low value). */
const AUDITED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Skip audit on these admin sub-paths to keep the log signal-rich. */
const SKIP_PATHS: ReadonlyArray<string | RegExp> = [
  "/api/admin/setup",            // covered explicitly elsewhere
  "/api/admin/auth/login",       // login attempts already logged separately
  "/api/admin/auth/logout",
  "/api/admin/migrations/diff",  // read-only despite being POST
  /^\/api\/admin\/preview-/,
  /^\/api\/admin\/.*\/preview$/,
];

function shouldAudit(method: string, rawPath: string): boolean {
  // Normalise so `/api/v1/admin/...` is treated identically to `/api/admin/...`.
  const path = normalizeApiPath(rawPath);
  if (!AUDITED_METHODS.has(method)) return false;
  if (!path.startsWith("/api/admin/")) return false;
  for (const p of SKIP_PATHS) {
    if (typeof p === "string") {
      if (path === p) return false;
    } else {
      if (p.test(path)) return false;
    }
  }
  return true;
}

/**
 * Map a path + method to a logical action label. Best-effort —
 * uncategorised paths fall back to the literal `<METHOD> <path>`.
 */
function deriveAction(method: string, rawPath: string): { action: string; target: string | null } {
  const path = normalizeApiPath(rawPath);
  // /api/admin/<resource>/<id?>
  const m = /^\/api\/admin\/([a-z][a-z0-9_-]*)(?:\/([^/?]+))?(?:\/([^/?]+))?/.exec(path);
  if (!m) return { action: `${method} ${path}`, target: null };
  const resource = m[1] ?? "";
  const id = m[2] ?? null;
  const sub = m[3] ?? null;

  // Common resource shapes: collections, settings, hooks, jobs, queues,
  // routes, indexes, admins, auth-users, migrations, backup, etc.
  const noun = resource.replace(/-/g, "_");
  const verb =
    method === "POST"   ? (sub ? sub : "create") :
    method === "PUT"    ? "replace" :
    method === "PATCH"  ? "update" :
    method === "DELETE" ? "delete" :
    method.toLowerCase();
  const action = `${noun}.${verb}`;
  return { action, target: id };
}

/**
 * Trim a long string to a fixed length with an ellipsis. Used so a long
 * payload summary doesn't bloat the audit row.
 */
function trim(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

interface RecordOpts {
  request: Request;
  status: number;
  /** Post-auth admin context, when available. */
  actor: { id: string; email?: string } | null;
  /** Optional human summary — typically the request body or a short delta. */
  summary?: string | null;
}

/**
 * Persist one audit row. Called from the global onAfterHandle. Errors are
 * swallowed — never block a request because audit logging failed; the
 * fallback is the file logger which catches the same data.
 */
export async function recordAuditEntry(opts: RecordOpts): Promise<void> {
  const url = new URL(opts.request.url);
  const method = opts.request.method.toUpperCase();
  if (!shouldAudit(method, url.pathname)) return;

  const { action, target } = deriveAction(method, url.pathname);
  try {
    await getDb().insert(auditLog).values({
      id: crypto.randomUUID(),
      actor_id: opts.actor?.id ?? null,
      actor_email: opts.actor?.email ?? null,
      method,
      path: url.pathname,
      action,
      target,
      status: opts.status,
      ip: clientIp(opts.request),
      summary: opts.summary ? trim(opts.summary, 1024) : null,
      at: Math.floor(Date.now() / 1000),
    });
  } catch {
    // Audit must never break a request. Real failures still surface in
    // the file logger via the parent onAfterHandle.
  }
}

/**
 * Persist an audit row for an action that doesn't arrive as an admin HTTP
 * request — e.g. an MCP tool call made with an API token. Same table and
 * columns as `recordAuditEntry`; errors are swallowed for the same reason.
 */
export async function recordAuditEvent(opts: {
  actor: { id: string; email?: string } | null;
  method: string;
  path: string;
  action: string;
  target?: string | null;
  status: number;
  summary?: string | null;
}): Promise<void> {
  try {
    await getDb().insert(auditLog).values({
      id: crypto.randomUUID(),
      actor_id: opts.actor?.id ?? null,
      actor_email: opts.actor?.email ?? null,
      method: opts.method,
      path: opts.path,
      action: opts.action,
      target: opts.target ?? null,
      status: opts.status,
      ip: null,
      summary: opts.summary ? trim(opts.summary, 1024) : null,
      at: Math.floor(Date.now() / 1000),
    });
  } catch {
    // Audit must never break the action it records.
  }
}

// ── Read API ────────────────────────────────────────────────────────────────

export interface ListAuditOpts {
  page?: number;
  perPage?: number;
  /** Filter to a single actor id. */
  actorId?: string;
  /** Filter on action prefix, e.g. `"collection."`. */
  actionPrefix?: string;
  /** Unix-seconds inclusive lower / upper bounds. */
  from?: number;
  to?: number;
}

export async function listAuditEntries(opts: ListAuditOpts = {}): Promise<{
  data: Array<{
    id: string;
    actor_id: string | null;
    actor_email: string | null;
    method: string;
    path: string;
    action: string;
    target: string | null;
    status: number;
    ip: string | null;
    summary: string | null;
    at: number;
  }>;
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
}> {
  const db = getDb();
  const perPage = Math.min(500, Math.max(1, opts.perPage ?? 50));
  const page = Math.max(1, opts.page ?? 1);
  const offset = (page - 1) * perPage;

  const filters = [];
  if (opts.actorId) filters.push(eq(auditLog.actor_id, opts.actorId));
  if (opts.actionPrefix) filters.push(like(auditLog.action, `${opts.actionPrefix}%`));
  if (opts.from !== undefined) filters.push(gte(auditLog.at, opts.from));
  if (opts.to !== undefined) filters.push(lte(auditLog.at, opts.to));
  const where = filters.length === 0 ? undefined : (filters.length === 1 ? filters[0] : and(...filters));

  const totalRow = await (where
    ? db.select({ n: sql<number>`CAST(COUNT(*) AS INTEGER)` }).from(auditLog).where(where)
    : db.select({ n: sql<number>`CAST(COUNT(*) AS INTEGER)` }).from(auditLog));
  const totalItems = (totalRow[0]?.n ?? 0) as number;

  const rows = await (where
    ? db.select().from(auditLog).where(where).orderBy(desc(auditLog.at)).limit(perPage).offset(offset)
    : db.select().from(auditLog).orderBy(desc(auditLog.at)).limit(perPage).offset(offset));

  return {
    data: rows,
    page,
    perPage,
    totalItems,
    totalPages: Math.max(1, Math.ceil(totalItems / perPage)),
  };
}
