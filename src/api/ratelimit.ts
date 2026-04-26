import Elysia from "elysia";

/**
 * Per-IP token-bucket rate limiter.
 *
 * Defaults: 120 requests / 60s. Configure via env:
 *   VAULTBASE_RATE_LIMIT — max requests per window (default 120)
 *   VAULTBASE_RATE_WINDOW_MS — window in ms (default 60000)
 *
 * Skipped paths: admin UI assets, realtime WS, health, logs polling.
 * Returns 429 with body { error, code } on overflow.
 */

const RATE = parseInt(process.env["VAULTBASE_RATE_LIMIT"] ?? "120");
const WINDOW_MS = parseInt(process.env["VAULTBASE_RATE_WINDOW_MS"] ?? "60000");

interface Bucket { tokens: number; lastRefill: number }
const buckets = new Map<string, Bucket>();

const SKIP_PREFIXES = ["/_/", "/realtime", "/api/health", "/api/admin/logs"];
function shouldSkip(path: string): boolean {
  return SKIP_PREFIXES.some((p) => path.startsWith(p));
}

function ipFromRequest(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (fwd) return fwd;
  return request.headers.get("x-real-ip") ?? "unknown";
}

function consumeToken(key: string): boolean {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: RATE, lastRefill: now };
    buckets.set(key, b);
  }
  const elapsed = now - b.lastRefill;
  if (elapsed > 0) {
    b.tokens = Math.min(RATE, b.tokens + (elapsed / WINDOW_MS) * RATE);
    b.lastRefill = now;
  }
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

// Evict idle buckets every window
setInterval(() => {
  const cutoff = Date.now() - 5 * WINDOW_MS;
  for (const [k, b] of buckets) {
    if (b.lastRefill < cutoff) buckets.delete(k);
  }
}, WINDOW_MS);

export function makeRateLimitPlugin() {
  return new Elysia({ name: "rate-limit" }).onBeforeHandle({ as: "global" }, ({ request, set }) => {
    const path = new URL(request.url).pathname;
    if (shouldSkip(path)) return;
    const ip = ipFromRequest(request);
    if (!consumeToken(ip)) {
      set.status = 429;
      set.headers["Retry-After"] = String(Math.ceil(WINDOW_MS / 1000));
      return { error: "Rate limit exceeded", code: 429 };
    }
  });
}
