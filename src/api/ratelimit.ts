import type { Database } from "bun:sqlite";
import Elysia from "elysia";
import { getDb } from "../db/client.ts";

/**
 * Per-IP token-bucket rate limiter.
 *
 * Configuration sources (in priority order):
 *   1. Settings stored in `vaultbase_settings` table (admin UI)
 *   2. Env vars VAULTBASE_RATE_LIMIT, VAULTBASE_RATE_WINDOW_MS, VAULTBASE_RATE_ENABLED
 *   3. Defaults: 120 req / 60s, enabled
 *
 * Skipped paths: admin UI assets, realtime WS, health, logs polling.
 * Returns 429 with body { error, code } on overflow.
 */

const DEFAULT_RATE = parseInt(process.env["VAULTBASE_RATE_LIMIT"] ?? "120");
const DEFAULT_WINDOW = parseInt(process.env["VAULTBASE_RATE_WINDOW_MS"] ?? "60000");
const DEFAULT_ENABLED = (process.env["VAULTBASE_RATE_ENABLED"] ?? "1") !== "0";

const SKIP_PREFIXES = ["/_/", "/realtime", "/api/health", "/api/admin/logs"];
function shouldSkip(path: string): boolean {
  return SKIP_PREFIXES.some((p) => path.startsWith(p));
}

interface Bucket { tokens: number; lastRefill: number }
const buckets = new Map<string, Bucket>();

interface Config { enabled: boolean; max: number; windowMs: number; expires: number }
let cachedConfig: Config | null = null;
const CONFIG_TTL_MS = 5_000;

function loadConfig(): Config {
  const now = Date.now();
  if (cachedConfig && cachedConfig.expires > now) return cachedConfig;

  let enabled = DEFAULT_ENABLED;
  let max = DEFAULT_RATE;
  let windowMs = DEFAULT_WINDOW;
  try {
    const client = (getDb() as unknown as { $client: Database }).$client;
    const rows = client
      .prepare(`SELECT key, value FROM vaultbase_settings WHERE key LIKE 'rate_limit.%'`)
      .all() as Array<{ key: string; value: string }>;
    for (const r of rows) {
      if (r.key === "rate_limit.enabled")   enabled = r.value === "1" || r.value === "true";
      if (r.key === "rate_limit.max")       { const v = parseInt(r.value); if (!isNaN(v) && v > 0) max = v; }
      if (r.key === "rate_limit.window_ms") { const v = parseInt(r.value); if (!isNaN(v) && v > 0) windowMs = v; }
    }
  } catch { /* DB not initialized yet — use env defaults */ }

  cachedConfig = { enabled, max, windowMs, expires: now + CONFIG_TTL_MS };
  return cachedConfig;
}

/** Force the rate-limit middleware to re-read config from DB on next request. */
export function invalidateRateLimitCache(): void {
  cachedConfig = null;
  buckets.clear();
}

function ipFromRequest(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (fwd) return fwd;
  return request.headers.get("x-real-ip") ?? "unknown";
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

// Evict idle buckets every minute (largest possible window default)
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
    if (!cfg.enabled) return;
    const ip = ipFromRequest(request);
    if (!consumeToken(ip, cfg.max, cfg.windowMs)) {
      set.status = 429;
      set.headers["Retry-After"] = String(Math.ceil(cfg.windowMs / 1000));
      return { error: "Rate limit exceeded", code: 429 };
    }
  });
}
