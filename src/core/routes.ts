import { eq } from "drizzle-orm";
import { accessFor, clientIp, dataPrincipal, verifyAuthToken } from "./sec.ts";
import { getDb } from "../db/client.ts";
import { routes } from "../db/schema.ts";
import { ValidationError } from "./validate.ts";
import { makeHookHelpers, type HookHelpers } from "./hooks.ts";
import { appendHookLog } from "./file-logger.ts";
import { insertLog } from "../api/logs.ts";
import type { AuthContext } from "./rules.ts";
import { compileCode } from "./code-loader.ts";

async function extractAuth(request: Request, jwtSecret: string): Promise<AuthContext | null> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return null;
  // Central verifier: issuer, revocation and principal checks apply here
  // too; API tokens act within their scopes.
  return dataPrincipal(await verifyAuthToken(token, jwtSecret), accessFor(request));
}

/**
 * User-defined HTTP routes. Mounted under `/api/v1/custom/<user-path>`.
 * Each route compiles to an AsyncFunction(ctx) that runs in the request path.
 */

export const ROUTE_METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"] as const;
export type RouteMethod = typeof ROUTE_METHODS[number];

export function validatePath(path: string): string | null {
  if (!path) return "path required";
  if (!path.startsWith("/")) return "path must start with /";
  if (path.includes("..")) return "path cannot contain '..'";
  return null;
}

export interface RouteContext {
  req: Request;
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  auth: AuthContext | null;
  helpers: HookHelpers;
  set: { status: number; headers: Record<string, string> };
}

interface RouteRow {
  id: string;
  name: string;
  method: string;
  path: string;
  code: string;
  enabled: number;
  require_auth?: number;
}

interface CompiledRoute {
  id: string;
  name: string;
  method: string;
  path: string;
  pathPattern: RegExp;
  paramNames: string[];
  requireAuth: boolean;
  fn: (ctx: RouteContext) => Promise<unknown>;
}

const cache = new Map<string, CompiledRoute>();
let cacheLoaded = false;

function compilePath(path: string): { regex: RegExp; params: string[] } {
  // Normalize: ensure leading slash
  const norm = path.startsWith("/") ? path : "/" + path;
  const params: string[] = [];
  const segments = norm.split("/").map((seg) => {
    if (seg.startsWith(":")) {
      params.push(seg.slice(1));
      return "([^/]+)";
    }
    if (seg === "*") return ".*";
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return { regex: new RegExp("^" + segments.join("/") + "/?$"), params };
}

function compile(row: RouteRow): CompiledRoute | null {
  try {
    const { regex, params } = compilePath(row.path);
    const fn = compileCode<RouteContext>(row);
    return {
      id: row.id,
      name: row.name ?? "",
      method: row.method.toUpperCase(),
      path: row.path,
      pathPattern: regex,
      paramNames: params,
      requireAuth: row.require_auth === 1,
      fn,
    };
  } catch (e) {
    console.error(`[routes] Failed to compile route ${row.id}:`, e);
    return null;
  }
}

// ── Routes registered from code ─────────────────────────────────────────────

export interface RouteRegistration {
  name: string;
  method: RouteMethod;
  /** Under /api/v1/custom, e.g. "/stats/:board". `:param` and `*` work as in the admin UI. */
  path: string;
  /** Refuse callers who aren't signed in (guests included). Default false. */
  requireAuth?: boolean;
  handle(ctx: RouteContext): unknown;
}

const registeredRoutes: CompiledRoute[] = [];

/**
 * Add a custom route from code (an extension). A route defined in the admin
 * UI with the same method and path takes precedence.
 */
export function registerRoute(def: RouteRegistration): () => void {
  const method = String(def.method).toUpperCase();
  if (!(ROUTE_METHODS as readonly string[]).includes(method)) throw new Error(`unsupported route method '${def.method}'`);
  const { regex, params } = compilePath(def.path);
  const route: CompiledRoute = {
    id: `ext:${def.name}`, name: def.name, method, path: def.path,
    pathPattern: regex, paramNames: params, requireAuth: def.requireAuth === true,
    fn: async (ctx) => def.handle(ctx),
  };
  registeredRoutes.push(route);
  return () => {
    const i = registeredRoutes.indexOf(route);
    if (i >= 0) registeredRoutes.splice(i, 1);
  };
}

export function listRegisteredRoutes(): Array<{ name: string; method: string; path: string; requireAuth: boolean }> {
  return registeredRoutes.map((r) => ({ name: r.name, method: r.method, path: r.path, requireAuth: r.requireAuth }));
}

export function invalidateRoutesCache(): void {
  cache.clear();
  cacheLoaded = false;
}

async function loadRoutes(): Promise<CompiledRoute[]> {
  if (cacheLoaded) return [...cache.values()];
  const db = getDb();
  const rows = await db.select().from(routes).where(eq(routes.enabled, 1));
  cache.clear();
  for (const r of rows) {
    const c = compile(r as RouteRow);
    if (c) cache.set(r.id, c);
  }
  cacheLoaded = true;
  return [...cache.values()];
}

export interface RouteMatch {
  route: CompiledRoute;
  params: Record<string, string>;
}

export async function findRoute(method: string, path: string): Promise<RouteMatch | null> {
  const all = [...(await loadRoutes()), ...registeredRoutes];
  const M = method.toUpperCase();
  for (const r of all) {
    if (r.method !== M) continue;
    const m = r.pathPattern.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    for (let i = 0; i < r.paramNames.length; i++) {
      params[r.paramNames[i]!] = decodeURIComponent(m[i + 1] ?? "");
    }
    return { route: r, params };
  }
  return null;
}

export async function dispatchCustomRoute(
  request: Request,
  innerPath: string,
  jwtSecret: string
): Promise<{ status: number; headers: Record<string, string>; body: unknown } | null> {
  const match = await findRoute(request.method, innerPath);
  if (!match) return null;

  const url = new URL(request.url);
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { query[k] = v; });

  let body: unknown = null;
  if (request.method !== "GET" && request.method !== "DELETE") {
    const ct = request.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      body = await request.clone().json().catch(() => null);
    } else if (ct.includes("text/")) {
      body = await request.clone().text().catch(() => null);
    }
  }

  const auth = await extractAuth(request, jwtSecret);
  // A guest session (`/auth/:collection/anonymous`) is self-issued by
  // anyone, so it doesn't count as signed in.
  if (match.route.requireAuth && (!auth || auth.anonymous)) {
    return { status: 401, headers: {}, body: { error: "Unauthorized", code: 401 } };
  }
  const helpers = makeHookHelpers({
    name: match.route.name,
    auth,
  });
  const set = { status: 200, headers: {} as Record<string, string> };
  const ctx: RouteContext = {
    req: request,
    method: request.method,
    path: innerPath,
    params: match.params,
    query,
    body,
    auth,
    helpers,
    set,
  };

  const started = Date.now();
  const ip = clientIp(request);
  const fullPath = "/api/v1/custom" + innerPath;
  try {
    const result = await match.route.fn(ctx);
    void insertLog(request.method, fullPath, set.status, Date.now() - started, ip,
      auth ? { id: auth.id, type: auth.type, ...(auth.email ? { email: auth.email } : {}) } : null);
    appendHookLog({
      name: match.route.name,
      message: `route ${match.route.method} ${match.route.path} → ${set.status}`,
    });
    return { status: set.status, headers: set.headers, body: result ?? null };
  } catch (e) {
    let status = 500;
    let body: unknown;
    if (e instanceof ValidationError) {
      status = 422;
      body = { error: e.message, code: 422, details: e.details };
    } else {
      // The message (SQL, paths, stack details) goes to the log only.
      console.error(`[routes] route ${match.route.id} threw:`, e);
      body = { error: "Internal error", code: 500 };
    }
    void insertLog(request.method, fullPath, status, Date.now() - started, ip,
      auth ? { id: auth.id, type: auth.type, ...(auth.email ? { email: auth.email } : {}) } : null);
    return { status, headers: {}, body };
  }
}
