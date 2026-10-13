import { eq } from "drizzle-orm";
import Elysia, { t } from "elysia";
import { getDb } from "../db/client.ts";
import { hooks } from "../db/schema.ts";
import { HOOK_EVENTS, invalidateHookCache } from "../core/hooks.ts";
import { createInFiles, deleteInFiles, updateInFiles, withVersion } from "./_code-files.ts";
import { adminGuard } from "./_admin.ts";

export function makeHooksPlugin(jwtSecret: string) {
  return new Elysia({ name: "hooks" })
    .use(adminGuard(jwtSecret))
    .get("/admin/hooks", async () => {
      const rows = await getDb().select().from(hooks);
      return { data: rows.map(withVersion) };
    }, { requireAdmin: true })

    .post(
      "/admin/hooks",
      async ({ body, set }) => {
        if (!HOOK_EVENTS.includes(body.event as typeof HOOK_EVENTS[number])) {
          set.status = 422; return { error: `Invalid event: ${body.event}`, code: 422 };
        }
        const inFiles = createInFiles(set, "hook", {
          name: body.name ?? "", collection_name: body.collection_name ?? "", event: body.event, enabled: body.enabled === false ? 0 : 1,
        }, body.code ?? "");
        if (inFiles) return await inFiles;
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
        requireAdmin: true,
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
      "/admin/hooks/:id",
      async ({ request, params, body, set }) => {
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
        const current = (await getDb().select().from(hooks).where(eq(hooks.id, params.id)).limit(1))[0];
        if (!current) { set.status = 404; return { error: "Hook not found", code: 404 }; }
        const { updated_at: _u, code: _c, ...settings } = update;
        const inFiles = updateInFiles(set, "hook", current, settings, body.code, request.headers.get("if-match"));
        if (inFiles) return await inFiles;
        await getDb().update(hooks).set(update).where(eq(hooks.id, params.id));
        invalidateHookCache();
        const row = await getDb().select().from(hooks).where(eq(hooks.id, params.id)).limit(1);
        if (row.length === 0) { set.status = 404; return { error: "Hook not found", code: 404 }; }
        return { data: row[0] };
      },
      {
        requireAdmin: true,
        body: t.Object({
          name: t.Optional(t.String()),
          collection_name: t.Optional(t.String()),
          event: t.Optional(t.String()),
          code: t.Optional(t.String()),
          enabled: t.Optional(t.Boolean()),
        }),
      }
    )

    .delete("/admin/hooks/:id", async ({ params, set }) => {
      const current = (await getDb().select().from(hooks).where(eq(hooks.id, params.id)).limit(1))[0];
      const inFiles = current && deleteInFiles(set, current);
      if (inFiles) return await inFiles;
      await getDb().delete(hooks).where(eq(hooks.id, params.id));
      invalidateHookCache();
      return { data: null };
    }, { requireAdmin: true });
}
