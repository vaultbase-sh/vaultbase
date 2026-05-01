/**
 * Cross-Origin Resource Sharing.
 *
 * Reads runtime config from `vaultbase_settings`:
 *   - `cors.origins`     — comma-separated, `*` wildcard, blank = block cross-origin
 *   - `cors.methods`     — comma-separated, default GET,POST,PUT,PATCH,DELETE,OPTIONS
 *   - `cors.headers`     — comma-separated, default Authorization,Content-Type,If-Match,X-VB-Idempotency-Key
 *   - `cors.credentials` — "1" / "0", default "0". MUST NOT combine with origins=`*`.
 *   - `cors.max_age`     — seconds for preflight cache, default "600"
 *
 * Exposed two ways:
 *   - `applyCorsHeaders(req, set)` — set Access-Control-* response headers
 *     based on the request's Origin (use inside Elysia onAfterHandle).
 *   - `handleCorsPreflight(req)`   — produce a 204 Response for OPTIONS
 *     when the origin is allowed, else null (let normal routing run).
 *
 * Cache TTL 5s — same envelope as hook-egress to keep saves snappy without
 * paying a settings round-trip per request.
 */
import { getAllSettings } from "../api/settings.ts";

interface CorsConfig {
  origins: string[];          // empty = block
  wildcard: boolean;
  methods: string;
  headers: string;
  credentials: boolean;
  maxAge: number;
}

const DEFAULT_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const DEFAULT_HEADERS = "Authorization,Content-Type,If-Match,X-VB-Idempotency-Key";
const DEFAULT_MAX_AGE = 600;

let cache: { config: CorsConfig; loaded_at: number } | null = null;
const CACHE_TTL_MS = 5_000;

function load(): CorsConfig {
  const now = Date.now();
  if (cache && now - cache.loaded_at < CACHE_TTL_MS) return cache.config;

  let s: Record<string, string> = {};
  try { s = getAllSettings(); } catch { /* DB not initialised in tests — fall through */ }

  const rawOrigins = (s["cors.origins"] ?? "").trim();
  const list = rawOrigins
    ? rawOrigins.split(",").map((x) => x.trim()).filter(Boolean)
    : [];
  const wildcard = list.includes("*");
  const credentials = (s["cors.credentials"] ?? "0") === "1";
  const config: CorsConfig = {
    origins: list,
    // Browsers refuse credentials + `*`. Silently downgrade by treating as
    // not-wildcard when credentials are on; the origin must match exactly.
    wildcard: wildcard && !credentials,
    methods: (s["cors.methods"] ?? DEFAULT_METHODS).trim() || DEFAULT_METHODS,
    headers: (s["cors.headers"] ?? DEFAULT_HEADERS).trim() || DEFAULT_HEADERS,
    credentials,
    maxAge: Number.parseInt(s["cors.max_age"] ?? "", 10) || DEFAULT_MAX_AGE,
  };
  cache = { config, loaded_at: now };
  return config;
}

export function invalidateCorsCache(): void {
  cache = null;
}

function originAllowed(cfg: CorsConfig, origin: string): boolean {
  if (cfg.wildcard) return true;
  return cfg.origins.includes(origin);
}

/** Apply Access-Control-* response headers when the request is cross-origin. */
export function applyCorsHeaders(
  request: Request,
  set: { headers: Record<string, string | undefined> },
): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const cfg = load();
  if (!originAllowed(cfg, origin)) return;

  // Echo the matched origin (or `*` for true wildcard without creds).
  set.headers["Access-Control-Allow-Origin"] = cfg.wildcard ? "*" : origin;
  // Vary: Origin so caches don't serve a wrong-origin response to peers.
  const existingVary = set.headers["Vary"];
  set.headers["Vary"] = existingVary && existingVary !== "Origin"
    ? `${existingVary}, Origin`
    : "Origin";
  if (cfg.credentials) {
    set.headers["Access-Control-Allow-Credentials"] = "true";
  }
}

/**
 * Short-circuit OPTIONS preflight requests. Returns a 204 Response on
 * allowed origin, `null` to let the normal router run on disallowed
 * origin (which then fails CORS in the browser — nothing to leak).
 */
export function handleCorsPreflight(request: Request): Response | null {
  if (request.method !== "OPTIONS") return null;
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const cfg = load();
  if (!originAllowed(cfg, origin)) return null;

  const reqMethod = request.headers.get("access-control-request-method") ?? "";
  const reqHeaders = request.headers.get("access-control-request-headers") ?? "";

  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": cfg.wildcard ? "*" : origin,
    "Access-Control-Allow-Methods": cfg.methods,
    "Access-Control-Allow-Headers": reqHeaders || cfg.headers,
    "Access-Control-Max-Age": String(cfg.maxAge),
    "Vary": "Origin, Access-Control-Request-Headers",
  };
  if (cfg.credentials) headers["Access-Control-Allow-Credentials"] = "true";
  // No-op acknowledgement of method — browsers don't need it echoed but
  // some preflight inspectors look for it.
  if (reqMethod) headers["Access-Control-Allow-Methods"] = cfg.methods;

  return new Response(null, { status: 204, headers });
}
