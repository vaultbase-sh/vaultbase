import { eq } from "drizzle-orm";
import { databaseCodeError, inlineCompileError } from "../core/code-loader.ts";
import Elysia, { t } from "elysia";
import { getDb } from "../db/client.ts";
import { jobs } from "../db/schema.ts";
import { invalidateJobsCache, nextRunFromCron, runJob, validateCron, validateMode } from "../core/jobs.ts";
import { createInFiles, deleteInFiles, updateInFiles, withVersion } from "./_code-files.ts";
import { adminGuard } from "./_admin.ts";

export function makeJobsPlugin(jwtSecret: string) {
  return new Elysia({ name: "jobs" })
    .use(adminGuard(jwtSecret))
    .get("/admin/jobs", async () => {
      const rows = await getDb().select().from(jobs);
      return { data: rows.map(withVersion) };
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
        {
          const bad = body.code !== undefined ? inlineCompileError(body.code as string) : null;
          if (bad) { set.status = 422; return { error: `Code does not compile: ${bad}`, code: 422 }; }
          const unsupported = databaseCodeError((body.code as string | undefined) ?? "");
          if (unsupported) { set.status = 422; return { error: unsupported, code: 422 }; }
        }
        const id = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
        const next = nextRunFromCron(body.cron, now);
        await getDb().insert(jobs).values({
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
        });
        invalidateJobsCache();
        const row = await getDb().select().from(jobs).where(eq(jobs.id, id)).limit(1);
        return { data: row[0] };
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
        const current = (await getDb().select().from(jobs).where(eq(jobs.id, params.id)).limit(1))[0];
        if (!current) { set.status = 404; return { error: "Job not found", code: 404 }; }
        const { updated_at: _u, code: _c, next_run_at: _n, ...settings } = update;
        const inFiles = updateInFiles(set, "job", current, settings, body.code, request.headers.get("if-match"));
        if (inFiles) return await inFiles;
        {
          const bad = body.code !== undefined ? inlineCompileError(body.code as string) : null;
          if (bad) { set.status = 422; return { error: `Code does not compile: ${bad}`, code: 422 }; }
          // Enabling checks the stored code: it may predate this check.
          const unsupported = databaseCodeError((body.code as string | undefined) ?? (body.enabled ? String(current.code ?? "") : ""));
          if (unsupported) { set.status = 422; return { error: unsupported, code: 422 }; }
        }
        await getDb().update(jobs).set(update).where(eq(jobs.id, params.id));
        invalidateJobsCache();
        const row = await getDb().select().from(jobs).where(eq(jobs.id, params.id)).limit(1);
        if (row.length === 0) { set.status = 404; return { error: "Job not found", code: 404 }; }
        return { data: row[0] };
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
      const current = (await getDb().select().from(jobs).where(eq(jobs.id, params.id)).limit(1))[0];
      const inFiles = current && deleteInFiles(set, current);
      if (inFiles) return await inFiles;
      await getDb().delete(jobs).where(eq(jobs.id, params.id));
      invalidateJobsCache();
      return { data: null };
    }, { requireAdmin: true })

    .post("/admin/jobs/:id/run", async ({ params, set }) => {
      const result = await runJob(params.id);
      if (!result.ok) { set.status = 500; return { error: result.error ?? "Run failed", code: 500 }; }
      return { data: { ok: true } };
    }, { requireAdmin: true });
}
