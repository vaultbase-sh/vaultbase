import Elysia, { t } from "elysia";
import { jobs } from "../db/schema.ts";
import { invalidateJobsCache, nextRunFromCron, runJob, validateCron, validateMode } from "../core/jobs.ts";
import { codeRefusal, createInFiles, deleteCodeRow, findCodeRow, insertCodeRow, listCodeRows, updateCodeRow, updateInFiles } from "./_code-files.ts";
import { adminGuard } from "./_admin.ts";

export function makeJobsPlugin(jwtSecret: string) {
  return new Elysia({ name: "jobs" })
    .use(adminGuard(jwtSecret))
    .get("/admin/jobs", async () => {
      return listCodeRows(jobs);
    }, { requireAdmin: true })

    .post(
      "/admin/jobs",
      async ({ body, set }) => {
        const cronErr = validateCron(body.cron);
        if (cronErr) { set.status = 422; return { error: `Invalid cron: ${cronErr}`, code: 422 }; }
        const mode = body.mode ?? "inline";
        const modeErr = validateMode(mode);
        if (modeErr) { set.status = 422; return { error: modeErr, code: 422 }; }
        const inFiles = createInFiles(set, "job", {
          name: body.name ?? "", cron: body.cron, mode, enabled: body.enabled === false ? 0 : 1,
        }, body.code ?? "");
        if (inFiles) return await inFiles;
        const refused = codeRefusal(set, body.code);
        if (refused) return refused;
        const id = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
        const next = nextRunFromCron(body.cron, now);
        return insertCodeRow(jobs, {
          id,
          name: body.name ?? "",
          cron: body.cron,
          code: body.code ?? "",
          enabled: body.enabled === false ? 0 : 1,
          mode,
          last_run_at: null,
          next_run_at: next,
          last_status: null,
          last_error: null,
          created_at: now,
          updated_at: now,
        }, invalidateJobsCache);
      },
      {
        requireAdmin: true,
        body: t.Object({
          name: t.Optional(t.String()),
          cron: t.String(),
          code: t.Optional(t.String()),
          enabled: t.Optional(t.Boolean()),
          mode: t.Optional(t.String()),
        }),
      }
    )

    .patch(
      "/admin/jobs/:id",
      async ({ request, params, body, set }) => {
        const update: { name?: string; cron?: string; code?: string; enabled?: number; mode?: string; next_run_at?: number; updated_at: number } = {
          updated_at: Math.floor(Date.now() / 1000),
        };
        if (body.name !== undefined) update.name = body.name;
        if (body.cron !== undefined) {
          const cronErr = validateCron(body.cron);
          if (cronErr) { set.status = 422; return { error: `Invalid cron: ${cronErr}`, code: 422 }; }
          update.cron = body.cron;
          update.next_run_at = nextRunFromCron(body.cron, update.updated_at);
        }
        if (body.code !== undefined) update.code = body.code;
        if (body.enabled !== undefined) update.enabled = body.enabled ? 1 : 0;
        if (body.mode !== undefined) {
          const modeErr = validateMode(body.mode);
          if (modeErr) { set.status = 422; return { error: modeErr, code: 422 }; }
          update.mode = body.mode;
        }
        const current = await findCodeRow(jobs, params.id);
        if (!current) { set.status = 404; return { error: "Job not found", code: 404 }; }
        const { updated_at: _u, code: _c, next_run_at: _n, ...settings } = update;
        const inFiles = updateInFiles(set, "job", current, settings, body.code, request.headers.get("if-match"));
        if (inFiles) return await inFiles;
        const refused = codeRefusal(set, body.code as string | undefined, body.enabled ? String(current.code ?? "") : undefined);
        if (refused) return refused;
        return updateCodeRow(set, jobs, params.id, update, invalidateJobsCache, "Job");
      },
      {
        requireAdmin: true,
        body: t.Object({
          name: t.Optional(t.String()),
          cron: t.Optional(t.String()),
          code: t.Optional(t.String()),
          enabled: t.Optional(t.Boolean()),
          mode: t.Optional(t.String()),
        }),
      }
    )

    .delete("/admin/jobs/:id", async ({ params, set }) => {
      return deleteCodeRow(set, jobs, params.id, invalidateJobsCache);
    }, { requireAdmin: true })

    .post("/admin/jobs/:id/run", async ({ params, set }) => {
      const result = await runJob(params.id);
      if (!result.ok) { set.status = 500; return { error: result.error ?? "Run failed", code: 500 }; }
      return { data: { ok: true } };
    }, { requireAdmin: true });
}
