import Elysia, { t } from "elysia";
import { hooks } from "../db/schema.ts";
import { HOOK_EVENTS, invalidateHookCache } from "../core/hooks.ts";
import { codeRefusal, createInFiles, deleteCodeRow, findCodeRow, insertCodeRow, listCodeRows, updateCodeRow, updateInFiles } from "./_code-files.ts";
import { adminGuard } from "./_admin.ts";

export function makeHooksPlugin(jwtSecret: string) {
  return new Elysia({ name: "hooks" })
    .use(adminGuard(jwtSecret))
    .get("/admin/hooks", async () => {
      return listCodeRows(hooks);
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
        const refused = codeRefusal(set, body.code);
        if (refused) return refused;
        const id = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
        return insertCodeRow(hooks, {
          id,
          name: body.name ?? "",
          collection_name: body.collection_name ?? "",
          event: body.event,
          code: body.code ?? "",
          enabled: body.enabled === false ? 0 : 1,
          created_at: now,
          updated_at: now,
        }, invalidateHookCache);
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
        const current = await findCodeRow(hooks, params.id);
        if (!current) { set.status = 404; return { error: "Hook not found", code: 404 }; }
        const { updated_at: _u, code: _c, ...settings } = update;
        const inFiles = updateInFiles(set, "hook", current, settings, body.code, request.headers.get("if-match"));
        if (inFiles) return await inFiles;
        const refused = codeRefusal(set, body.code as string | undefined, body.enabled ? String(current.code ?? "") : undefined);
        if (refused) return refused;
        return updateCodeRow(set, hooks, params.id, update, invalidateHookCache, "Hook");
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
      return deleteCodeRow(set, hooks, params.id, invalidateHookCache);
    }, { requireAdmin: true });
}
