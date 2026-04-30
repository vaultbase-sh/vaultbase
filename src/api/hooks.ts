import { eq } from "drizzle-orm";
import Elysia, { t } from "elysia";
import { getDb } from "../db/client.ts";
import { hooks } from "../db/schema.ts";
import { HOOK_EVENTS, invalidateHookCache } from "../core/hooks.ts";
import { verifyAuthToken } from "../core/sec.ts";

async function isAdmin(request: Request, jwtSecret: string): Promise<boolean> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return false;
  // Centralized verifier — fixes N-1 admin-token-bypass.
  return (await verifyAuthToken(token, jwtSecret, { audience: "admin" })) !== null;
}

export function makeHooksPlugin(jwtSecret: string) {
  return new Elysia({ name: "hooks" })
    .get("/api/admin/hooks", async ({ request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      const rows = await getDb().select().from(hooks);
      return { data: rows };
    })

    .post(
      "/api/admin/hooks",
      async ({ request, body, set }) => {
        if (!(await isAdmin(request, jwtSecret))) {
          set.status = 401; return { error: "Unauthorized", code: 401 };
        }
        if (!HOOK_EVENTS.includes(body.event as typeof HOOK_EVENTS[number])) {
          set.status = 422; return { error: `Invalid event: ${body.event}`, code: 422 };
        }
        const id = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
        await getDb().insert(hooks).values({
          id,
          name: body.name ?? "",
          collection_name: body.collection_name ?? "",
          event: body.event,
          code: body.code ?? "",
          enabled: body.enabled === false ? 0 : 1,
          created_at: now,
          updated_at: now,
        });
        invalidateHookCache();
        const row = await getDb().select().from(hooks).where(eq(hooks.id, id)).limit(1);
        return { data: row[0] };
      },
      {
        body: t.Object({
          name: t.Optional(t.String()),
          collection_name: t.Optional(t.String()),
          event: t.String(),
          code: t.Optional(t.String()),
          enabled: t.Optional(t.Boolean()),
        }),
      }
    )

    .patch(
      "/api/admin/hooks/:id",
      async ({ request, params, body, set }) => {
        if (!(await isAdmin(request, jwtSecret))) {
          set.status = 401; return { error: "Unauthorized", code: 401 };
        }
        const update: { name?: string; collection_name?: string; event?: string; code?: string; enabled?: number; updated_at: number } = {
          updated_at: Math.floor(Date.now() / 1000),
        };
        if (body.name !== undefined) update.name = body.name;
        if (body.collection_name !== undefined) update.collection_name = body.collection_name;
        if (body.event !== undefined) {
          if (!HOOK_EVENTS.includes(body.event as typeof HOOK_EVENTS[number])) {
            set.status = 422; return { error: `Invalid event: ${body.event}`, code: 422 };
          }
          update.event = body.event;
        }
        if (body.code !== undefined) update.code = body.code;
        if (body.enabled !== undefined) update.enabled = body.enabled ? 1 : 0;
        await getDb().update(hooks).set(update).where(eq(hooks.id, params.id));
        invalidateHookCache();
        const row = await getDb().select().from(hooks).where(eq(hooks.id, params.id)).limit(1);
        if (row.length === 0) { set.status = 404; return { error: "Hook not found", code: 404 }; }
        return { data: row[0] };
      },
      {
        body: t.Object({
          name: t.Optional(t.String()),
          collection_name: t.Optional(t.String()),
          event: t.Optional(t.String()),
          code: t.Optional(t.String()),
          enabled: t.Optional(t.Boolean()),
        }),
      }
    )

    .delete("/api/admin/hooks/:id", async ({ request, params, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      await getDb().delete(hooks).where(eq(hooks.id, params.id));
      invalidateHookCache();
      return { data: null };
    });
}
