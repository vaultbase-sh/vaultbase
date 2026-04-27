import { eq } from "drizzle-orm";
import Elysia, { t } from "elysia";
import * as jose from "jose";
import { getDb } from "../db/client.ts";
import { routes } from "../db/schema.ts";
import { ROUTE_METHODS, dispatchCustomRoute, invalidateRoutesCache } from "../core/routes.ts";

async function isAdmin(request: Request, jwtSecret: string): Promise<boolean> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return false;
  try {
    await jose.jwtVerify(token, new TextEncoder().encode(jwtSecret), { audience: "admin" });
    return true;
  } catch {
    return false;
  }
}

function validatePath(path: string): string | null {
  if (!path) return "path required";
  if (!path.startsWith("/")) return "path must start with /";
  if (path.includes("..")) return "path cannot contain '..'";
  return null;
}

/**
 * Returns a Response if the path matches a user route, otherwise undefined.
 * Wired into the main Elysia app's onRequest hook so it fires before route
 * resolution (preventing collisions with built-in /api/:collection routes).
 */
export async function tryDispatchCustom(request: Request, jwtSecret: string): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/custom")) return undefined;
  const inner = url.pathname.replace(/^\/api\/custom/, "") || "/";
  try {
    const result = await dispatchCustomRoute(request, inner, jwtSecret);
    if (!result) {
      return new Response(JSON.stringify({ error: "No matching custom route", code: 404 }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    const headers: Record<string, string> = { "content-type": "application/json", ...result.headers };
    const body = typeof result.body === "string" ? result.body : JSON.stringify(result.body);
    return new Response(body, { status: result.status, headers });
  } catch (e) {
    console.error("[routes] tryDispatchCustom failed:", e);
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: `Custom route dispatch failed: ${msg}`, code: 500 }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}

export function makeRoutesPlugin(jwtSecret: string) {
  return new Elysia({ name: "routes" })
    .get("/api/admin/routes", async ({ request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      const rows = await getDb().select().from(routes);
      return { data: rows };
    })

    .post(
      "/api/admin/routes",
      async ({ request, body, set }) => {
        if (!(await isAdmin(request, jwtSecret))) {
          set.status = 401; return { error: "Unauthorized", code: 401 };
        }
        const method = (body.method ?? "GET").toUpperCase();
        if (!ROUTE_METHODS.includes(method as typeof ROUTE_METHODS[number])) {
          set.status = 422; return { error: `Invalid method: ${method}`, code: 422 };
        }
        const pathErr = validatePath(body.path ?? "");
        if (pathErr) { set.status = 422; return { error: pathErr, code: 422 }; }
        const id = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
        await getDb().insert(routes).values({
          id,
          name: body.name ?? "",
          method,
          path: body.path,
          code: body.code ?? "",
          enabled: body.enabled === false ? 0 : 1,
          created_at: now,
          updated_at: now,
        });
        invalidateRoutesCache();
        const row = await getDb().select().from(routes).where(eq(routes.id, id)).limit(1);
        return { data: row[0] };
      },
      {
        body: t.Object({
          name: t.Optional(t.String()),
          method: t.Optional(t.String()),
          path: t.String(),
          code: t.Optional(t.String()),
          enabled: t.Optional(t.Boolean()),
        }),
      }
    )

    .patch(
      "/api/admin/routes/:id",
      async ({ request, params, body, set }) => {
        if (!(await isAdmin(request, jwtSecret))) {
          set.status = 401; return { error: "Unauthorized", code: 401 };
        }
        const update: { name?: string; method?: string; path?: string; code?: string; enabled?: number; updated_at: number } = {
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
        await getDb().update(routes).set(update).where(eq(routes.id, params.id));
        invalidateRoutesCache();
        const row = await getDb().select().from(routes).where(eq(routes.id, params.id)).limit(1);
        if (row.length === 0) { set.status = 404; return { error: "Route not found", code: 404 }; }
        return { data: row[0] };
      },
      {
        body: t.Object({
          name: t.Optional(t.String()),
          method: t.Optional(t.String()),
          path: t.Optional(t.String()),
          code: t.Optional(t.String()),
          enabled: t.Optional(t.Boolean()),
        }),
      }
    )

    .delete("/api/admin/routes/:id", async ({ request, params, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      await getDb().delete(routes).where(eq(routes.id, params.id));
      invalidateRoutesCache();
      return { data: null };
    });
}
