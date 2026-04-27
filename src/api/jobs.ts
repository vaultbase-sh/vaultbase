import { eq } from "drizzle-orm";
import Elysia, { t } from "elysia";
import * as jose from "jose";
import { getDb } from "../db/client.ts";
import { jobs } from "../db/schema.ts";
import { invalidateJobsCache, nextRunFromCron, runJob, validateCron } from "../core/jobs.ts";

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

export function makeJobsPlugin(jwtSecret: string) {
  return new Elysia({ name: "jobs" })
    .get("/api/admin/jobs", async ({ request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      const rows = await getDb().select().from(jobs);
      return { data: rows };
    })

    .post(
      "/api/admin/jobs",
      async ({ request, body, set }) => {
        if (!(await isAdmin(request, jwtSecret))) {
          set.status = 401; return { error: "Unauthorized", code: 401 };
        }
        const cronErr = validateCron(body.cron);
        if (cronErr) { set.status = 422; return { error: `Invalid cron: ${cronErr}`, code: 422 }; }
        const id = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
        const next = nextRunFromCron(body.cron, now);
        await getDb().insert(jobs).values({
          id,
          name: body.name ?? "",
          cron: body.cron,
          code: body.code ?? "",
          enabled: body.enabled === false ? 0 : 1,
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
        body: t.Object({
          name: t.Optional(t.String()),
          cron: t.String(),
          code: t.Optional(t.String()),
          enabled: t.Optional(t.Boolean()),
        }),
      }
    )

    .patch(
      "/api/admin/jobs/:id",
      async ({ request, params, body, set }) => {
        if (!(await isAdmin(request, jwtSecret))) {
          set.status = 401; return { error: "Unauthorized", code: 401 };
        }
        const update: { name?: string; cron?: string; code?: string; enabled?: number; next_run_at?: number; updated_at: number } = {
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
        await getDb().update(jobs).set(update).where(eq(jobs.id, params.id));
        invalidateJobsCache();
        const row = await getDb().select().from(jobs).where(eq(jobs.id, params.id)).limit(1);
        if (row.length === 0) { set.status = 404; return { error: "Job not found", code: 404 }; }
        return { data: row[0] };
      },
      {
        body: t.Object({
          name: t.Optional(t.String()),
          cron: t.Optional(t.String()),
          code: t.Optional(t.String()),
          enabled: t.Optional(t.Boolean()),
        }),
      }
    )

    .delete("/api/admin/jobs/:id", async ({ request, params, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      await getDb().delete(jobs).where(eq(jobs.id, params.id));
      invalidateJobsCache();
      return { data: null };
    })

    .post("/api/admin/jobs/:id/run", async ({ request, params, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      const result = await runJob(params.id);
      if (!result.ok) { set.status = 500; return { error: result.error ?? "Run failed", code: 500 }; }
      return { data: { ok: true } };
    });
}
