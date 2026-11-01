/**
 * Maintenance mode: the API closed to clients while admins keep working.
 *
 * Switched on in the admin (Settings → Maintenance mode). While it's on:
 *
 *   - API calls and realtime connections get 503 with the admin's message,
 *     except from an admin (a session or an admin API token, so the admin
 *     UI, the CLI's tokens and MCP keep working) and except `/api/health`
 *     and the admin API itself (its own login has to work);
 *   - `read_only` lets reads through (GET / HEAD, and realtime) and refuses
 *     the rest; `full`, the default, refuses everything;
 *   - custom routes are closed in both levels unless listed in
 *     `maintenance_mode.routes` ("GET /status");
 *   - cron jobs, queue workers and webhook deliveries pause unless
 *     `maintenance_mode.background` is `run`. Record hooks still run: they
 *     are part of the writes admins make, and may be what keeps data valid.
 *
 * The check runs in `onRequest`, in the main thread and in every read
 * worker (they run the same pipeline), so reads answered off the main
 * thread are covered. Settings reach the read workers when they change and
 * other processes within the settings reload (2 s).
 *
 * `until` is a hint for clients (`Retry-After`, `retry_after` in the body);
 * the mode doesn't end by itself, so a migration that overruns isn't opened
 * up halfway.
 */
import { getSetting as readSetting } from "../api/settings.ts";
import { applyCorsHeaders } from "./cors.ts";
import { isAdminApiPath, normalizeApiPath } from "./api-paths.ts";
import { extractBearer, securityHeaders, verifyAuthToken } from "./sec.ts";
import { findRoute } from "./routes.ts";

/**
 * A setting, or the default while no database is open (a restore reopening
 * it, shutdown): timers and the request path read these, and must not throw.
 */
function getSetting(key: string, fallback: string): string {
  try {
    return readSetting(key, fallback);
  } catch {
    return fallback;
  }
}

export const MAINTENANCE_KEYS = {
  enabled: "maintenance_mode.enabled",
  level: "maintenance_mode.level",
  message: "maintenance_mode.message",
  until: "maintenance_mode.until",
  background: "maintenance_mode.background",
  routes: "maintenance_mode.routes",
} as const;

export type MaintenanceLevel = "full" | "read_only";

export const DEFAULT_MAINTENANCE_MESSAGE = "The service is down for maintenance. Please try again later.";

export interface MaintenanceState {
  on: boolean;
  level: MaintenanceLevel;
  message: string;
  /** Unix seconds the admin expects to be back, or null. */
  until: number | null;
  pauseBackground: boolean;
  /** Custom routes left open, as "METHOD /path". */
  routes: Set<string>;
}

/** "GET /status/:id" → "GET /status/:id", tidied; null when it isn't one. */
export function normalizeRouteEntry(raw: string): string | null {
  const m = /^\s*([A-Za-z]+)\s+(\/\S*)\s*$/.exec(raw);
  return m ? `${m[1]!.toUpperCase()} ${m[2]}` : null;
}

function parseRoutes(raw: string): Set<string> {
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return new Set();
    return new Set(list.flatMap((e) => (typeof e === "string" ? [normalizeRouteEntry(e)] : [])).filter((e): e is string => e !== null));
  } catch {
    return new Set();
  }
}

export function maintenanceState(): MaintenanceState {
  const until = Number(getSetting(MAINTENANCE_KEYS.until, ""));
  return {
    on: getSetting(MAINTENANCE_KEYS.enabled, "0") === "1",
    level: getSetting(MAINTENANCE_KEYS.level, "full") === "read_only" ? "read_only" : "full",
    message: getSetting(MAINTENANCE_KEYS.message, "").trim() || DEFAULT_MAINTENANCE_MESSAGE,
    until: Number.isInteger(until) && until > 0 ? until : null,
    pauseBackground: getSetting(MAINTENANCE_KEYS.background, "pause") !== "run",
    routes: parseRoutes(getSetting(MAINTENANCE_KEYS.routes, "[]")),
  };
}

/** Whether maintenance mode is on, at any level. */
export function maintenanceOn(): boolean {
  return getSetting(MAINTENANCE_KEYS.enabled, "0") === "1";
}

/** Whether cron jobs, queue workers and webhook deliveries should wait. */
export function backgroundPaused(): boolean {
  return getSetting(MAINTENANCE_KEYS.enabled, "0") === "1"
    && getSetting(MAINTENANCE_KEYS.background, "pause") !== "run";
}

/** Whether realtime connections that aren't an admin's should be closed. */
export function realtimeClosed(): boolean {
  const s = maintenanceState();
  return s.on && s.level === "full";
}

/** The 503 a refused request gets. */
export function maintenanceResponse(request: Request, s: MaintenanceState, nowSec = Math.floor(Date.now() / 1000)): Response {
  const retryAfter = s.until !== null && s.until > nowSec ? s.until - nowSec : null;
  const set = {
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...securityHeaders({ isApi: true }),
      ...(retryAfter !== null ? { "Retry-After": String(retryAfter) } : {}),
    } as Record<string, string | undefined>,
  };
  applyCorsHeaders(request, set);
  // Retry-After isn't readable cross-origin, so the body carries it too.
  const body = {
    error: s.message,
    code: 503,
    maintenance: {
      level: s.level,
      ...(s.until !== null ? { until: s.until } : {}),
      ...(retryAfter !== null ? { retry_after: retryAfter } : {}),
    },
  };
  return new Response(JSON.stringify(body), { status: 503, headers: set.headers as Record<string, string> });
}

/** Whether the request carries an admin session or an admin API token. */
async function fromAdmin(request: Request, jwtSecret: string): Promise<boolean> {
  const token = extractBearer(request);
  if (!token) return false;
  try {
    return (await verifyAuthToken(token, jwtSecret))?.type === "admin";
  } catch {
    return false;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * The 503 for `request` when maintenance mode refuses it, otherwise null.
 * Cheap when the mode is off: one in-memory setting read.
 */
export async function maintenanceRefusal(request: Request, jwtSecret: string): Promise<Response | null> {
  if (getSetting(MAINTENANCE_KEYS.enabled, "0") !== "1") return null;
  const s = maintenanceState();
  const pathname = new URL(request.url).pathname;
  // Routing ignores a trailing slash (`/realtime/` is the realtime socket).
  const path = normalizeApiPath(pathname).replace(/\/+$/, "") || "/";
  if (path !== "/realtime" && !path.startsWith("/api/")) return null; // admin UI, auth pages, probes
  if (path === "/api/health" || isAdminApiPath(pathname)) return null;
  if (request.method === "OPTIONS") return null;

  if (path === "/api/custom" || path.startsWith("/api/custom/")) {
    const inner = path.slice("/api/custom".length) || "/";
    const match = await findRoute(request.method, inner).catch(() => null);
    if (match && s.routes.has(`${match.route.method} ${match.route.path}`)) return null;
  } else if (s.level === "read_only") {
    // Realtime is a read: the SSE fallback sets its subscriptions with POST.
    if (SAFE_METHODS.has(request.method) || path === "/api/realtime" || path.startsWith("/api/realtime/")) return null;
  }

  if (await fromAdmin(request, jwtSecret)) return null;
  return maintenanceResponse(request, s);
}

/** Longest message shown to clients. */
export const MAX_MAINTENANCE_MESSAGE = 500;
/** Most custom routes that can be left open. */
export const MAX_MAINTENANCE_ROUTES = 100;

/** The problem with a `maintenance_mode.*` value, or null. */
export function validateMaintenanceSetting(key: string, value: unknown): string | null {
  const v = String(value ?? "");
  switch (key) {
    case MAINTENANCE_KEYS.enabled:
      return v === "0" || v === "1" ? null : "must be 0 or 1";
    case MAINTENANCE_KEYS.level:
      return v === "full" || v === "read_only" ? null : "must be full or read_only";
    case MAINTENANCE_KEYS.background:
      return v === "pause" || v === "run" ? null : "must be pause or run";
    case MAINTENANCE_KEYS.message:
      return v.length <= MAX_MAINTENANCE_MESSAGE ? null : `must be at most ${MAX_MAINTENANCE_MESSAGE} characters`;
    case MAINTENANCE_KEYS.until: {
      if (v.trim() === "") return null;
      const n = Number(v);
      return Number.isInteger(n) && n > 0 ? null : "must be a Unix time in seconds, or empty";
    }
    case MAINTENANCE_KEYS.routes: {
      let list: unknown;
      try { list = JSON.parse(v || "[]"); } catch { return "must be a JSON array of routes like \"GET /status\""; }
      if (!Array.isArray(list)) return "must be a JSON array of routes like \"GET /status\"";
      if (list.length > MAX_MAINTENANCE_ROUTES) return `can list at most ${MAX_MAINTENANCE_ROUTES} routes`;
      const bad = list.find((e) => typeof e !== "string" || normalizeRouteEntry(e) === null);
      return bad === undefined ? null : `'${String(bad)}' isn't a route like "GET /status"`;
    }
  }
  return null;
}
