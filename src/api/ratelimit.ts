import type { Database } from "bun:sqlite";
import Elysia from "elysia";
import { getDb } from "../db/client.ts";

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

const RESERVED_TOP = new Set(["admin", "auth", "files", "collections", "health"]);

interface Bucket { tokens: number; lastRefill: number }
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
    const client = (getDb() as unknown as { $client: Database }).$client;
    const rows = client
      .prepare(`SELECT key, value FROM vaultbase_settings WHERE key LIKE 'rate_limit.%'`)
      .all() as Array<{ key: string; value: string }>;
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

export function invalidateRateLimitCache(): void {
  cachedConfig = null;
  buckets.clear();
}

function ipFromRequest(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (fwd) return fwd;
  return request.headers.get("x-real-ip") ?? "unknown";
}

function detectAction(method: string, path: string): RuleAction | null {
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

function consumeToken(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: max, lastRefill: now };
    buckets.set(key, b);
  }
  const elapsed = now - b.lastRefill;
  if (elapsed > 0) {
    b.tokens = Math.min(max, b.tokens + (elapsed / windowMs) * max);
    b.lastRefill = now;
  }
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

setInterval(() => {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [k, b] of buckets) {
    if (b.lastRefill < cutoff) buckets.delete(k);
  }
}, 60_000);

export function makeRateLimitPlugin() {
  return new Elysia({ name: "rate-limit" }).onBeforeHandle({ as: "global" }, ({ request, set }) => {
    const path = new URL(request.url).pathname;
    if (shouldSkip(path)) return;
    const cfg = loadConfig();
    if (!cfg.enabled || cfg.rules.length === 0) return;

    const hasAuth = !!request.headers.get("authorization");
    const match = findRule(cfg.rules, path, request.method, hasAuth);
    if (!match) return;

    const ip = ipFromRequest(request);
    const key = `${ip}|${match.index}`;
    if (!consumeToken(key, match.rule.max, match.rule.windowMs)) {
      set.status = 429;
      set.headers["Retry-After"] = String(Math.ceil(match.rule.windowMs / 1000));
      return { error: `Rate limit exceeded (rule: ${match.rule.label})`, code: 429 };
    }
  });
}

// Exposed for admin UI / tests
export const RATE_LIMIT_DEFAULTS = DEFAULT_RULES;
