import Elysia from "elysia";
import { settingsWithPrefix } from "./settings.ts";
import { verifyHs256 } from "../core/jwt-hs256.ts";
import { peerAddress, rateLimitKeyForIp, securityHeaders, trustedClientIp } from "../core/sec.ts";
import { applyCorsHeaders } from "../core/cors.ts";
import { normalizeApiPath } from "../core/api-paths.ts";
import { onCloseDb } from "../db/client.ts";

/**
 * Per-IP, per-rule token-bucket rate limiter.
 *
 * Rules are stored in `vaultbase_settings` under key `rate_limit.rules` as a
 * JSON array of `{ label, max, windowMs, audience }`. The first matching
 * rule (by order) is consumed.
 *
 * Label syntax: `<pathPattern>[:<action>]`
 *   - pathPattern: `*` (any), trailing `*` (prefix), or exact path.
 *   - action (optional): auth | create | list | view | update | delete.
 *
 * Audience: `all` | `guest` (no auth header) | `auth` (auth header present).
 *
 * Skipped paths: admin UI assets, realtime WS, health, logs polling.
 */

export type RuleAudience = "all" | "guest" | "auth";
export type RuleAction = "auth" | "create" | "list" | "view" | "update" | "delete";

export interface RateLimitRule {
  label: string;
  max: number;
  windowMs: number;
  audience: RuleAudience;
}

interface ParsedRule extends RateLimitRule {
  pathPattern: string;
  action: RuleAction | null;
}

const DEFAULT_RULES: RateLimitRule[] = [
  { label: "*:auth",    max: 10,  windowMs: 3000,  audience: "all" },
  { label: "*:create",  max: 60,  windowMs: 5000,  audience: "all" },
  { label: "/api/*",    max: 300, windowMs: 10000, audience: "all" },
];

const DEFAULT_ENABLED = (process.env["VAULTBASE_RATE_ENABLED"] ?? "1") !== "0";

const SKIP_PREFIXES = ["/_/", "/realtime", "/api/health", "/api/admin/logs"];
function shouldSkip(path: string): boolean {
  return SKIP_PREFIXES.some((p) => path.startsWith(p));
}

// `batch` too: a batch's ops are charged one by one (checkBatchRateLimit), so
// the batch request itself isn't a create.
const RESERVED_TOP = new Set(["admin", "auth", "files", "collections", "health", "batch"]);

/** `debtUntil`: when a bucket left in debt by a large batch is back to zero tokens. */
interface Bucket { tokens: number; lastRefill: number; debtUntil?: number }
const buckets = new Map<string, Bucket>();

interface Config {
  enabled: boolean;
  rules: ParsedRule[];
  expires: number;
}
let cachedConfig: Config | null = null;
const CONFIG_TTL_MS = 5_000;

function parseLabel(label: string): { pathPattern: string; action: RuleAction | null } {
  const colon = label.lastIndexOf(":");
  if (colon === -1) return { pathPattern: label, action: null };
  const maybeAction = label.slice(colon + 1);
  if (["auth", "create", "list", "view", "update", "delete"].includes(maybeAction)) {
    return { pathPattern: label.slice(0, colon) || "*", action: maybeAction as RuleAction };
  }
  return { pathPattern: label, action: null };
}

function parseRules(raw: string): RateLimitRule[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: RateLimitRule[] = [];
    for (const r of parsed) {
      if (!r || typeof r !== "object") continue;
      const label = String(r.label ?? "").trim();
      const max = Number(r.max);
      const windowMs = Number(r.windowMs);
      const audience = (r.audience === "guest" || r.audience === "auth") ? r.audience : "all";
      if (!label || !Number.isFinite(max) || max < 1) continue;
      if (!Number.isFinite(windowMs) || windowMs < 1) continue;
      out.push({ label, max, windowMs, audience });
    }
    return out;
  } catch { return []; }
}

function loadConfig(): Config {
  const now = Date.now();
  if (cachedConfig && cachedConfig.expires > now) return cachedConfig;

  let enabled = DEFAULT_ENABLED;
  let rules: RateLimitRule[] = DEFAULT_RULES;
  try {
    // From the settings store (api/settings.ts): this runs on the request
    // path and must not wait on the database.
    const rows = Object.entries(settingsWithPrefix("rate_limit."))
      .map(([key, value]) => ({ key, value }));
    let rulesFromDb: RateLimitRule[] | null = null;
    let legacyMax: number | null = null;
    let legacyWindow: number | null = null;
    for (const r of rows) {
      if (r.key === "rate_limit.enabled")   enabled = r.value === "1" || r.value === "true";
      if (r.key === "rate_limit.rules")     rulesFromDb = parseRules(r.value);
      if (r.key === "rate_limit.max")       { const v = parseInt(r.value); if (!isNaN(v) && v > 0) legacyMax = v; }
      if (r.key === "rate_limit.window_ms") { const v = parseInt(r.value); if (!isNaN(v) && v > 0) legacyWindow = v; }
    }
    if (rulesFromDb && rulesFromDb.length > 0) {
      rules = rulesFromDb;
    } else if (legacyMax !== null && legacyWindow !== null) {
      rules = [{ label: "*", max: legacyMax, windowMs: legacyWindow, audience: "all" }];
    }
  } catch { /* DB not initialized — defaults */ }

  const parsed: ParsedRule[] = rules.map((r) => ({ ...r, ...parseLabel(r.label) }));
  cachedConfig = { enabled, rules: parsed, expires: now + CONFIG_TTL_MS };
  return cachedConfig;
}

/** Test hook: number of live buckets. */
export function _bucketCount(): number {
  return buckets.size;
}

export function invalidateRateLimitCache(): void {
  cachedConfig = null;
  buckets.clear();
}
// Built from this database's settings or rows: a closed database leaves none
// behind for the next one (tests open many in one process).
onCloseDb(invalidateRateLimitCache);

export { rateLimitKeyForIp } from "../core/sec.ts";

function ipFromRequest(request: Request, peerIp: string | null): string {
  // Honor x-forwarded-for / x-real-ip ONLY when the immediate peer is a
  // trusted proxy (see sec.ts). Otherwise use the socket peer.
  return rateLimitKeyForIp(trustedClientIp(request, peerIp));
}

/**
 * Whether the request carries a token this server signed. Any
 * `Authorization` header used to select the "signed-in" rules, so a client
 * could pick whichever audience had the looser limit by sending junk.
 * Signature and expiry only — no database lookups on the hot path.
 */
async function hasValidToken(request: Request, jwtSecret: string | undefined): Promise<boolean> {
  if (!jwtSecret) return false;
  const raw = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!raw) return false;
  return verifyHs256(raw.startsWith("vbat_") ? raw.slice(5) : raw, jwtSecret, { issuer: "vaultbase" }) !== null;
}

function detectAction(method: string, rawPath: string): RuleAction | null {
  // Normalise so `/api/v1/auth/...` is treated the same as `/api/auth/...`.
  const path = normalizeApiPath(rawPath);
  // Auth-shaped paths
  if (
    path.startsWith("/api/auth/") ||
    path.startsWith("/api/admin/auth/") ||
    path === "/api/admin/setup" ||
    path.endsWith("/login") ||
    path.endsWith("/register") ||
    path.endsWith("/refresh")
  ) return "auth";

  // Records paths: /api/<collection> or /api/<collection>/<id>
  // Skip reserved top-level segments.
  const m = path.match(/^\/api\/([^/]+)(\/([^/]+))?$/);
  if (!m) return null;
  const top = m[1]!;
  const id = m[3];
  if (RESERVED_TOP.has(top)) return null;
  const M = method.toUpperCase();
  if (!id) {
    if (M === "POST") return "create";
    if (M === "GET")  return "list";
    return null;
  }
  if (M === "GET")    return "view";
  if (M === "PATCH" || M === "PUT") return "update";
  if (M === "DELETE") return "delete";
  return null;
}

function pathMatches(pattern: string, path: string): boolean {
  if (pattern === "*") return true;
  // Paths are matched in /api/... form; a rule written /api/v1/... means the same.
  pattern = normalizeApiPath(pattern);
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return path.startsWith(prefix);
  }
  return path === pattern;
}

function audienceMatches(audience: RuleAudience, hasAuth: boolean): boolean {
  if (audience === "all") return true;
  if (audience === "guest") return !hasAuth;
  return hasAuth;
}

function findRule(rules: ParsedRule[], path: string, method: string, hasAuth: boolean): { rule: ParsedRule; index: number } | null {
  const action = detectAction(method, path);
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i]!;
    if (!pathMatches(r.pathPattern, path)) continue;
    if (r.action && r.action !== action) continue;
    if (!audienceMatches(r.audience, hasAuth)) continue;
    return { rule: r, index: i };
  }
  return null;
}

/** The bucket for `key`, refilled up to now. */
function refilledBucket(key: string, max: number, windowMs: number): Bucket {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: max, lastRefill: now };
    buckets.set(key, b);
    trimBuckets();
  }
  const elapsed = now - b.lastRefill;
  if (elapsed > 0) {
    b.tokens = Math.min(max, b.tokens + (elapsed / windowMs) * max);
    b.lastRefill = now;
  }
  return b;
}

function consumeToken(key: string, max: number, windowMs: number): boolean {
  const b = refilledBucket(key, max, windowMs);
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [k, b] of buckets) {
    // A bucket in debt from a large batch is kept until it has paid it off.
    if (b.lastRefill < cutoff && (b.debtUntil ?? 0) < Date.now()) buckets.delete(k);
  }
}, 60_000).unref?.();

/**
 * Most buckets kept at once. Between sweeps, a client cycling through
 * addresses could otherwise grow the map without bound; past the cap the
 * oldest buckets go first (Map iteration order is insertion order).
 */
const MAX_BUCKETS = 100_000;

function trimBuckets(): void {
  if (buckets.size <= MAX_BUCKETS) return;
  for (const k of buckets.keys()) {
    buckets.delete(k);
    if (buckets.size <= MAX_BUCKETS) break;
  }
}

/** The bucket a request is charged to: the client address and the rule it matched. */
export interface RateLimitCharge {
  key: string;
  max: number;
  windowMs: number;
  label: string;
}

/**
 * The bucket `request` is charged to, or null when no rule applies (the
 * limiter is off, the path is skipped, no rule matches). Read workers that
 * serve requests themselves call this, then take the token from the main
 * thread's buckets (core/worker-listeners.ts), so there is one set.
 */
export async function rateLimitCharge(request: Request, peerIp: string | null, jwtSecret?: string): Promise<RateLimitCharge | null> {
  const ctx = await rateLimitContext(request, peerIp, jwtSecret);
  return ctx ? chargeForPath(ctx, new URL(request.url).pathname, request.method) : null;
}

/** What every charge for one incoming request shares: the rules, whether it carries a valid token, the client address. */
interface RateLimitContext { rules: ParsedRule[]; hasAuth: boolean; ip: string }

async function rateLimitContext(request: Request, peerIp: string | null, jwtSecret?: string): Promise<RateLimitContext | null> {
  const cfg = loadConfig();
  if (!cfg.enabled || cfg.rules.length === 0) return null;
  return { rules: cfg.rules, hasAuth: await hasValidToken(request, jwtSecret), ip: ipFromRequest(request, peerIp) };
}

/**
 * The path as the router and the batch parser (api/batch.ts parseOp) see
 * it: both ignore a trailing slash, so `/api/v1/notes/` is a create, and
 * must be charged as one rather than fall through to the catch-all rule.
 */
function routedPath(rawPath: string): string {
  // A loop, not /\/+$/: that regex is quadratic on a long run of slashes
  // not at the end, and this runs on every request before auth.
  let end = rawPath.length;
  while (end > 1 && rawPath.charCodeAt(end - 1) === 47 /* "/" */) end--;
  const trimmed = rawPath.slice(0, end);
  return normalizeApiPath(trimmed || "/");
}

function chargeForPath(ctx: RateLimitContext, rawPath: string, method: string): RateLimitCharge | null {
  const path = routedPath(rawPath);
  if (shouldSkip(path)) return null;
  const match = findRule(ctx.rules, path, method, ctx.hasAuth);
  if (!match) return null;
  return { key: `${ctx.ip}|${match.index}`, max: match.rule.max, windowMs: match.rule.windowMs, label: match.rule.label };
}

/** Take one token from the charge's bucket; false when it is empty. */
export function takeRateLimitToken(charge: Pick<RateLimitCharge, "key" | "max" | "windowMs">): boolean {
  return consumeToken(charge.key, charge.max, charge.windowMs);
}

/** What a request over its limit is answered with. */
export function rateLimitRefusal(charge: RateLimitCharge): { retryAfter: number; body: { error: string; code: number } } {
  return {
    retryAfter: Math.ceil(charge.windowMs / 1000),
    body: { error: `Rate limit exceeded (rule: ${charge.label})`, code: 429 },
  };
}

/** The 429 for a refused request answered outside the Elysia pipeline: security and CORS headers included. */
export function rateLimitedResponse(request: Request, refusal: ReturnType<typeof rateLimitRefusal>): Response {
  const set = { headers: { "content-type": "application/json", ...securityHeaders({ isApi: true }), "Retry-After": String(refusal.retryAfter) } as Record<string, string | undefined> };
  applyCorsHeaders(request, set);
  return new Response(JSON.stringify(refusal.body), { status: 429, headers: set.headers as Record<string, string> });
}

/**
 * Charge `request` against the matching rate-limit rule. Returns null when
 * it may proceed, or what to answer with when it is over the limit.
 */
export async function checkRateLimit(
  request: Request,
  peerIp: string | null,
  jwtSecret?: string,
): Promise<{ retryAfter: number; body: { error: string; code: number } } | null> {
  const charge = await rateLimitCharge(request, peerIp, jwtSecret);
  if (!charge || takeRateLimitToken(charge)) return null;
  return rateLimitRefusal(charge);
}

/**
 * Charge a batch's ops as if each came on its own: the batch request itself
 * takes one token, and without this 100 creates cost one. Every op takes a
 * token from the bucket its own request would. A batch larger than a rule's
 * limit goes through only when that bucket is full, and leaves it in debt,
 * so the next request on that rule waits as long as the ops sent one by one
 * would have. Nothing is taken unless every bucket can pay.
 */
/** Largest batch the batch route accepts (api/batch.ts MAX_BATCH). */
export const MAX_BATCH_OPS = 100;

export async function checkBatchRateLimit(
  request: Request,
  peerIp: string | null,
  jwtSecret: string | undefined,
  ops: ReadonlyArray<{ method: string; url: string }>,
): Promise<{ retryAfter: number; body: { error: string; code: number } } | null> {
  const ctx = await rateLimitContext(request, peerIp, jwtSecret);
  if (!ctx) return null;
  const due = new Map<string, { charge: RateLimitCharge; n: number }>();
  for (const op of ops.slice(0, MAX_BATCH_OPS)) {
    // Resolved exactly as parseOp resolves it (api/batch.ts): a relative
    // `api/v1/notes` is the create at /api/v1/notes there, not a path under
    // the batch request's own URL.
    let url: URL;
    try { url = new URL(op.url, "http://internal/"); } catch { continue; }
    const charge = chargeForPath(ctx, url.pathname, op.method);
    if (!charge) continue;
    const d = due.get(charge.key);
    if (d) d.n++;
    else due.set(charge.key, { charge, n: 1 });
  }
  for (const { charge, n } of due.values()) {
    if (refilledBucket(charge.key, charge.max, charge.windowMs).tokens < Math.min(n, charge.max)) return rateLimitRefusal(charge);
  }
  for (const { charge, n } of due.values()) {
    const b = buckets.get(charge.key)!;
    b.tokens -= n;
    if (b.tokens < 0) b.debtUntil = b.lastRefill + (-b.tokens / charge.max) * charge.windowMs;
  }
  return null;
}

export function makeRateLimitPlugin(jwtSecret?: string) {
  // The hook must not take `body`: a global hook that reads it makes Elysia
  // parse every request's body first, and routes that read the raw request
  // (file uploads, CSV import, restore) then find it spent. The batch route
  // charges its ops itself (batchOpsRateLimit).
  return new Elysia({ name: "rate-limit" }).onBeforeHandle({ as: "global" }, async ({ request, server, set }) => {
    const limited = await checkRateLimit(request, peerAddress(request, server), jwtSecret);
    if (limited) {
      set.status = 429;
      set.headers["Retry-After"] = String(limited.retryAfter);
      return limited.body;
    }
  });
}

/**
 * The batch route's share of rate limiting: after the request itself was
 * charged, charge its ops (checkBatchRateLimit). Over the batch cap the
 * handler refuses it anyway: charging thousands of ops first was work an
 * anonymous caller could ask for at will.
 */
export async function batchOpsRateLimit(
  request: Request,
  peerIp: string | null,
  jwtSecret: string | undefined,
  ops: unknown,
): Promise<{ retryAfter: number; body: { error: string; code: number } } | null> {
  if (!Array.isArray(ops) || ops.length > MAX_BATCH_OPS) return null;
  return checkBatchRateLimit(request, peerIp, jwtSecret, ops.filter(
    (o): o is { method: string; url: string } => !!o && typeof o.method === "string" && typeof o.url === "string",
  ));
}

// Exposed for admin UI / tests
export const RATE_LIMIT_DEFAULTS = DEFAULT_RULES;
