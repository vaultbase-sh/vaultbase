import { checkRateLimit } from "./ratelimit.ts";
import { inlineCompileError } from "../core/code-loader.ts";
import { applyCorsHeaders } from "../core/cors.ts";
import { rememberedPeer, securityHeaders } from "../core/sec.ts";
import { eq } from "drizzle-orm";
import Elysia, { t } from "elysia";
import { getDb } from "../db/client.ts";
import { routes } from "../db/schema.ts";
import { ROUTE_METHODS, dispatchCustomRoute, invalidateRoutesCache, validatePath } from "../core/routes.ts";
import { customInnerPath } from "../core/api-paths.ts";
import { createInFiles, deleteInFiles, updateInFiles, withVersion } from "./_code-files.ts";
import { adminGuard } from "./_admin.ts";

/**
 * Returns a Response if the path matches a user route, otherwise undefined.
 * Wired into the main Elysia app's onRequest hook so it fires before route
 * resolution (preventing collisions with built-in /api/:collection routes).
 */
/**
 * Custom routes answer from `onRequest`, ahead of the rest of the pipeline,
 * so they used to skip the rate limiter, the security headers and CORS.
 * They now go through the same three here.
 */
export async function tryDispatchCustom(request: Request, jwtSecret: string): Promise<Response | undefined> {
  const url = new URL(request.url);
  const inner = customInnerPath(url.pathname);
  if (inner === null) return undefined;
  const respond = (status: number, body: unknown, extra: Record<string, string> = {}): Response => {
    const set = { headers: { "content-type": "application/json", ...securityHeaders({ isApi: true }), ...extra } as Record<string, string | undefined> };
    applyCorsHeaders(request, set);
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: set.headers as Record<string, string> });
  };
  const limited = await checkRateLimit(request, rememberedPeer(request), jwtSecret);
  if (limited) return respond(429, limited.body, { "Retry-After": String(limited.retryAfter) });
  try {
    const result = await dispatchCustomRoute(request, inner, jwtSecret);
    if (!result) return respond(404, { error: "No matching custom route", code: 404 });
    return respond(result.status, result.body, result.headers);
  } catch (e) {
    // Details go to the log, not to the caller.
    console.error("[routes] tryDispatchCustom failed:", e);
    return respond(500, { error: "Internal error", code: 500 });
  }
}

export function makeRoutesPlugin(jwtSecret: string) {
  return new Elysia({ name: "routes" })
    .use(adminGuard(jwtSecret))
    .get("/admin/routes", async () => {
      const rows = await getDb().select().from(routes);
      return { data: rows.map(withVersion) };
    }, { requireAdmin: true })

    .post(
      "/admin/routes",
      async ({ body, set }) => {
        const method = (body.method ?? "GET").toUpperCase();
        if (!ROUTE_METHODS.includes(method as typeof ROUTE_METHODS[number])) {
          set.status = 422; return { error: `Invalid method: ${method}`, code: 422 };
        }
        const pathErr = validatePath(body.path ?? "");
        if (pathErr) { set.status = 422; return { error: pathErr, code: 422 }; }
        const inFiles = createInFiles(set, "route", {
          name: body.name ?? "", method, path: body.path, enabled: body.enabled === false ? 0 : 1,
          require_auth: body.require_auth === true ? 1 : 0,
        }, body.code ?? "");
        if (inFiles) return await inFiles;
        {
          const bad = body.code !== undefined ? inlineCompileError(body.code as string) : null;
          if (bad) { set.status = 422; return { error: `Code does not compile: ${bad}`, code: 422 }; }
        }
        const id = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
        await getDb().insert(routes).values({
          id,
          name: body.name ?? "",
          method,
          path: body.path,
          code: body.code ?? "",
          enabled: body.enabled === false ? 0 : 1,
          require_auth: body.require_auth === true ? 1 : 0,
          created_at: now,
          updated_at: now,
        });
        invalidateRoutesCache();
        const row = await getDb().select().from(routes).where(eq(routes.id, id)).limit(1);
        return { data: row[0] };
      },
      {
        requireAdmin: true,
        body: t.Object({
          name: t.Optional(t.String()),
          method: t.Optional(t.String()),
          path: t.String(),
          code: t.Optional(t.String()),
          enabled: t.Optional(t.Boolean()),
          require_auth: t.Optional(t.Boolean()),
        }),
      }
    )

    .patch(
      "/admin/routes/:id",
      async ({ request, params, body, set }) => {
        const update: { name?: string; method?: string; path?: string; code?: string; enabled?: number; require_auth?: number; updated_at: number } = {
          updated_at: Math.floor(Date.now() / 1000),
        };
        if (body.name !== undefined) update.name = body.name;
        if (body.method !== undefined) {
          const m = body.method.toUpperCase();
          if (!ROUTE_METHODS.includes(m as typeof ROUTE_METHODS[number])) {
            set.status = 422; return { error: `Invalid method: ${body.method}`, code: 422 };
          }
          update.method = m;
        }
        if (body.path !== undefined) {
          const pathErr = validatePath(body.path);
          if (pathErr) { set.status = 422; return { error: pathErr, code: 422 }; }
          update.path = body.path;
        }
        if (body.code !== undefined) update.code = body.code;
        if (body.enabled !== undefined) update.enabled = body.enabled ? 1 : 0;
        if (body.require_auth !== undefined) update.require_auth = body.require_auth ? 1 : 0;
        const current = (await getDb().select().from(routes).where(eq(routes.id, params.id)).limit(1))[0];
        if (!current) { set.status = 404; return { error: "Route not found", code: 404 }; }
        const { updated_at: _u, code: _c, ...settings } = update;
        const inFiles = updateInFiles(set, "route", current, settings, body.code, request.headers.get("if-match"));
        if (inFiles) return await inFiles;
        {
          const bad = body.code !== undefined ? inlineCompileError(body.code as string) : null;
          if (bad) { set.status = 422; return { error: `Code does not compile: ${bad}`, code: 422 }; }
        }
        await getDb().update(routes).set(update).where(eq(routes.id, params.id));
        invalidateRoutesCache();
        const row = await getDb().select().from(routes).where(eq(routes.id, params.id)).limit(1);
        if (row.length === 0) { set.status = 404; return { error: "Route not found", code: 404 }; }
        return { data: row[0] };
      },
      {
        requireAdmin: true,
        body: t.Object({
          name: t.Optional(t.String()),
          method: t.Optional(t.String()),
          path: t.Optional(t.String()),
          code: t.Optional(t.String()),
          enabled: t.Optional(t.Boolean()),
          require_auth: t.Optional(t.Boolean()),
        }),
      }
    )

    .delete("/admin/routes/:id", async ({ params, set }) => {
      const current = (await getDb().select().from(routes).where(eq(routes.id, params.id)).limit(1))[0];
      const inFiles = current && deleteInFiles(set, current);
      if (inFiles) return await inFiles;
      await getDb().delete(routes).where(eq(routes.id, params.id));
      invalidateRoutesCache();
      return { data: null };
    }, { requireAdmin: true });
}
