import Elysia, { t } from "elysia";
import { workers } from "../db/schema.ts";
import {
  invalidateWorkerCache,
  listJobsLog,
  retryJob,
  JobKeyActiveError,
  discardJob,
  queueStats,
  type JobStatus,
  VALID_BACKOFF,
  validateQueueName,
} from "../core/queues.ts";
import { codeRefusal, createInFiles, deleteCodeRow, findCodeRow, insertCodeRow, listCodeRows, updateCodeRow, updateInFiles } from "./_code-files.ts";
import { adminGuard } from "./_admin.ts";
import { positiveIntParam } from "../core/records.ts";

const VALID_STATUS = new Set<JobStatus>(["queued", "running", "succeeded", "failed", "dead"]);

export function makeQueuesPlugin(jwtSecret: string) {
  return new Elysia({ name: "queues" })
    .use(adminGuard(jwtSecret))
    // ── Workers CRUD ──────────────────────────────────────────────────────
    .get("/admin/workers", async () => {
      return listCodeRows(workers);
    }, { requireAdmin: true })

    .post(
      "/admin/workers",
      async ({ body, set }) => {
        const qErr = validateQueueName(body.queue);
        if (qErr) { set.status = 422; return { error: qErr, code: 422 }; }
        const backoff = body.retry_backoff ?? "exponential";
        if (!VALID_BACKOFF.has(backoff)) {
          set.status = 422;
          return { error: `retry_backoff must be exponential|fixed`, code: 422 };
        }
        const inFiles = createInFiles(set, "worker", {
          name: body.name ?? "", queue: body.queue, enabled: body.enabled === false ? 0 : 1,
          concurrency: Math.max(1, body.concurrency ?? 1), retry_max: Math.max(0, body.retry_max ?? 3),
          retry_backoff: backoff, retry_delay_ms: Math.max(50, body.retry_delay_ms ?? 1000),
        }, body.code ?? "");
        if (inFiles) return await inFiles;
        const refused = codeRefusal(set, body.code);
        if (refused) return refused;
        const id = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
        return insertCodeRow(workers, {
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
        }, invalidateWorkerCache);
      },
      {
        requireAdmin: true,
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
      "/admin/workers/:id",
      async ({ request, params, body, set }) => {
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
        const current = await findCodeRow(workers, params.id);
        if (!current) { set.status = 404; return { error: "Worker not found", code: 404 }; }
        const { updated_at: _u, code: _c, ...settings } = update;
        const inFiles = updateInFiles(set, "worker", current, settings, body.code as string | undefined, request.headers.get("if-match"));
        if (inFiles) return await inFiles;
        const refused = codeRefusal(set, body.code as string | undefined, body.enabled ? String(current.code ?? "") : undefined);
        if (refused) return refused;
        return updateCodeRow(set, workers, params.id, update, invalidateWorkerCache, "Worker");
      },
      {
        requireAdmin: true,
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

    .delete("/admin/workers/:id", async ({ params, set }) => {
      return deleteCodeRow(set, workers, params.id, invalidateWorkerCache);
    }, { requireAdmin: true })

    // ── Jobs log + admin actions ──────────────────────────────────────────
    .get(
      "/admin/queues/jobs",
      async ({ query, set }) => {
        const opts: Parameters<typeof listJobsLog>[0] = {};
        if (query.queue) opts.queue = query.queue;
        if (query.status) {
          if (!VALID_STATUS.has(query.status as JobStatus)) {
            set.status = 422; return { error: `Invalid status: ${query.status}`, code: 422 };
          }
          opts.status = query.status as JobStatus;
        }
        if (query.worker_id) opts.worker_id = query.worker_id;
        if (query.page) opts.page = positiveIntParam(query.page, 1);
        if (query.perPage) opts.perPage = positiveIntParam(query.perPage, 50);
        return listJobsLog(opts);
      },
      {
        requireAdmin: true,
        query: t.Object({
          queue: t.Optional(t.String()),
          status: t.Optional(t.String()),
          worker_id: t.Optional(t.String()),
          page: t.Optional(t.String()),
          perPage: t.Optional(t.String()),
        }),
      }
    )

    .post("/admin/queues/jobs/:id/retry", async ({ params, set }) => {
      let ok: boolean;
      try {
        ok = await retryJob(params.id);
      } catch (e) {
        if (e instanceof JobKeyActiveError) { set.status = 409; return { error: e.message, code: 409 }; }
        throw e;
      }
      if (!ok) { set.status = 404; return { error: "Job not found or not retryable", code: 404 }; }
      return { data: { ok: true } };
    }, { requireAdmin: true })

    .delete("/admin/queues/jobs/:id", async ({ params, set }) => {
      const ok = await discardJob(params.id);
      if (!ok) { set.status = 404; return { error: "Job not found or running", code: 404 }; }
      return { data: null };
    }, { requireAdmin: true })

    .get("/admin/queues/stats", async ({ query }) => {
      // `window` scopes the *_window counters (dashboard range picker).
      // Clamped so a caller can't ask for an unbounded scan.
      const raw = Number.parseInt(String(query.window ?? ""), 10);
      const windowSec = Number.isFinite(raw) && raw > 0
        ? Math.min(raw, 30 * 86_400)
        : 86_400;
      const data = await queueStats(windowSec);
      return { data, windowSec };
    }, { requireAdmin: true });
}
