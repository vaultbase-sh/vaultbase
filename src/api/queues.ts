import { eq } from "drizzle-orm";
import Elysia, { t } from "elysia";
import * as jose from "jose";
import { getDb } from "../db/client.ts";
import { workers } from "../db/schema.ts";
import {
  invalidateWorkerCache,
  listJobsLog,
  retryJob,
  discardJob,
  queueStats,
  type JobStatus,
} from "../core/queues.ts";

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

const VALID_BACKOFF = new Set(["exponential", "fixed"]);
const VALID_STATUS = new Set<JobStatus>(["queued", "running", "succeeded", "failed", "dead"]);

function validateQueueName(q: string): string | null {
  if (!q || !q.trim()) return "queue is required";
  if (!/^[a-zA-Z0-9_:-]+$/.test(q)) return "queue must match [a-zA-Z0-9_:-]+";
  return null;
}

export function makeQueuesPlugin(jwtSecret: string) {
  return new Elysia({ name: "queues" })
    // ── Workers CRUD ──────────────────────────────────────────────────────
    .get("/api/admin/workers", async ({ request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      const rows = await getDb().select().from(workers);
      return { data: rows };
    })

    .post(
      "/api/admin/workers",
      async ({ request, body, set }) => {
        if (!(await isAdmin(request, jwtSecret))) {
          set.status = 401; return { error: "Unauthorized", code: 401 };
        }
        const qErr = validateQueueName(body.queue);
        if (qErr) { set.status = 422; return { error: qErr, code: 422 }; }
        const backoff = body.retry_backoff ?? "exponential";
        if (!VALID_BACKOFF.has(backoff)) {
          set.status = 422;
          return { error: `retry_backoff must be exponential|fixed`, code: 422 };
        }
        const id = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
        await getDb().insert(workers).values({
          id,
          name: body.name ?? "",
          queue: body.queue,
          code: body.code ?? "",
          enabled: body.enabled === false ? 0 : 1,
          concurrency: Math.max(1, body.concurrency ?? 1),
          retry_max: Math.max(0, body.retry_max ?? 3),
          retry_backoff: backoff,
          retry_delay_ms: Math.max(50, body.retry_delay_ms ?? 1000),
          created_at: now,
          updated_at: now,
        });
        invalidateWorkerCache();
        const row = await getDb().select().from(workers).where(eq(workers.id, id)).limit(1);
        return { data: row[0] };
      },
      {
        body: t.Object({
          name: t.Optional(t.String()),
          queue: t.String(),
          code: t.Optional(t.String()),
          enabled: t.Optional(t.Boolean()),
          concurrency: t.Optional(t.Number()),
          retry_max: t.Optional(t.Number()),
          retry_backoff: t.Optional(t.String()),
          retry_delay_ms: t.Optional(t.Number()),
        }),
      }
    )

    .patch(
      "/api/admin/workers/:id",
      async ({ request, params, body, set }) => {
        if (!(await isAdmin(request, jwtSecret))) {
          set.status = 401; return { error: "Unauthorized", code: 401 };
        }
        const update: Record<string, unknown> = { updated_at: Math.floor(Date.now() / 1000) };
        if (body.name !== undefined) update["name"] = body.name;
        if (body.queue !== undefined) {
          const qErr = validateQueueName(body.queue);
          if (qErr) { set.status = 422; return { error: qErr, code: 422 }; }
          update["queue"] = body.queue;
        }
        if (body.code !== undefined) update["code"] = body.code;
        if (body.enabled !== undefined) update["enabled"] = body.enabled ? 1 : 0;
        if (body.concurrency !== undefined) update["concurrency"] = Math.max(1, body.concurrency);
        if (body.retry_max !== undefined) update["retry_max"] = Math.max(0, body.retry_max);
        if (body.retry_backoff !== undefined) {
          if (!VALID_BACKOFF.has(body.retry_backoff)) {
            set.status = 422;
            return { error: `retry_backoff must be exponential|fixed`, code: 422 };
          }
          update["retry_backoff"] = body.retry_backoff;
        }
        if (body.retry_delay_ms !== undefined) update["retry_delay_ms"] = Math.max(50, body.retry_delay_ms);
        await getDb().update(workers).set(update).where(eq(workers.id, params.id));
        invalidateWorkerCache();
        const row = await getDb().select().from(workers).where(eq(workers.id, params.id)).limit(1);
        if (row.length === 0) { set.status = 404; return { error: "Worker not found", code: 404 }; }
        return { data: row[0] };
      },
      {
        body: t.Object({
          name: t.Optional(t.String()),
          queue: t.Optional(t.String()),
          code: t.Optional(t.String()),
          enabled: t.Optional(t.Boolean()),
          concurrency: t.Optional(t.Number()),
          retry_max: t.Optional(t.Number()),
          retry_backoff: t.Optional(t.String()),
          retry_delay_ms: t.Optional(t.Number()),
        }),
      }
    )

    .delete("/api/admin/workers/:id", async ({ request, params, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      await getDb().delete(workers).where(eq(workers.id, params.id));
      invalidateWorkerCache();
      return { data: null };
    })

    // ── Jobs log + admin actions ──────────────────────────────────────────
    .get(
      "/api/admin/queues/jobs",
      async ({ request, query, set }) => {
        if (!(await isAdmin(request, jwtSecret))) {
          set.status = 401; return { error: "Unauthorized", code: 401 };
        }
        const opts: Parameters<typeof listJobsLog>[0] = {};
        if (query.queue) opts.queue = query.queue;
        if (query.status) {
          if (!VALID_STATUS.has(query.status as JobStatus)) {
            set.status = 422; return { error: `Invalid status: ${query.status}`, code: 422 };
          }
          opts.status = query.status as JobStatus;
        }
        if (query.worker_id) opts.worker_id = query.worker_id;
        if (query.page) opts.page = Number(query.page);
        if (query.perPage) opts.perPage = Number(query.perPage);
        return listJobsLog(opts);
      },
      {
        query: t.Object({
          queue: t.Optional(t.String()),
          status: t.Optional(t.String()),
          worker_id: t.Optional(t.String()),
          page: t.Optional(t.String()),
          perPage: t.Optional(t.String()),
        }),
      }
    )

    .post("/api/admin/queues/jobs/:id/retry", async ({ request, params, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      const ok = await retryJob(params.id);
      if (!ok) { set.status = 404; return { error: "Job not found or not retryable", code: 404 }; }
      return { data: { ok: true } };
    })

    .delete("/api/admin/queues/jobs/:id", async ({ request, params, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      const ok = await discardJob(params.id);
      if (!ok) { set.status = 404; return { error: "Job not found or running", code: 404 }; }
      return { data: null };
    })

    .get("/api/admin/queues/stats", async ({ request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      const data = await queueStats();
      return { data };
    });
}
