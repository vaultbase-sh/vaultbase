import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { jobsLog, workers } from "../db/schema.ts";
import { ValidationError } from "./validate.ts";
import { makeHookHelpers, type HookHelpers } from "./hooks.ts";
import { compileCode } from "./code-loader.ts";

/**
 * In-process job queue + worker engine. Phase 1 of the Redis brainstorm —
 * works without any external dependency. Same `helpers.enqueue(...)` API
 * exposed inside hooks, custom routes, and cron jobs.
 *
 *   - Queues are virtual (just a `queue` string on a job log row).
 *   - Workers are user-supplied JS compiled via AsyncFunction (same shape
 *     as record hooks / custom routes / cron jobs).
 *   - Retry policy: per-worker `retry_max` + `retry_backoff` ("exponential"
 *     uses 2^attempt × delay_ms; "fixed" uses delay_ms each time).
 *   - Dead-letter: jobs that exhaust retries land in status="dead". They
 *     stay in the log table and can be retried via the admin UI.
 *   - Unique-key dedup: `enqueue(queue, payload, { uniqueKey })` skips if
 *     a non-finished (queued|running) job with the same key exists.
 *
 * Phase 2 will swap the in-memory parts for Redis lists + sorted sets,
 * keeping this same API.
 */

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "dead";
export type RetryBackoff = "exponential" | "fixed";

export const VALID_BACKOFF = new Set(["exponential", "fixed"]);

export function validateQueueName(q: string): string | null {
  if (!q || !q.trim()) return "queue is required";
  if (!/^[a-zA-Z0-9_:-]+$/.test(q)) return "queue must match [a-zA-Z0-9_:-]+";
  return null;
}

export interface EnqueueOpts {
  /** Earliest run time, in seconds from now. */
  delay?: number;
  /** Skip if a non-finished job with this key already exists. */
  uniqueKey?: string;
  /** Override per-worker default retry_max for this enqueue. */
  retries?: number;
  /** Override per-worker default retry_backoff. */
  backoff?: RetryBackoff;
  /** Override per-worker default retry_delay_ms. */
  retryDelayMs?: number;
}

export interface JobContext {
  /** The enqueued payload, JSON-decoded. */
  payload: unknown;
  /** 1-indexed attempt counter (incremented on each retry). */
  attempt: number;
  /** Queue name this job came from. */
  queue: string;
  /** Job id (matches the row in vaultbase_jobs_log). */
  jobId: string;
  /** Helpers shared with hooks / routes / cron. */
  helpers: HookHelpers;
}

interface CompiledWorker {
  id: string;
  name: string;
  queue: string;
  concurrency: number;
  retry_max: number;
  retry_backoff: RetryBackoff;
  retry_delay_ms: number;
  fn: (ctx: JobContext) => Promise<unknown>;
}

const compiledCache = new Map<string, CompiledWorker>(); // worker id → compiled
let cacheLoaded = false;

/**
 * Built-in workers — registered in-source rather than via an admin-edited
 * `vaultbase_workers` row. Used by core features (e.g. notifications) that
 * need the queue's retry/backoff/dead-letter machinery without making the
 * operator paste boilerplate JS into the admin UI on every install.
 *
 * Precedence: any user-defined worker for the same queue wins (so an admin
 * can override a built-in by creating their own row), which is intentional
 * — built-ins are the default, not a constraint.
 */
export interface BuiltinWorkerSpec {
  queue: string;
  /** Display label used in job-log "worker" column. Default `_builtin:<queue>`. */
  name?: string;
  concurrency?: number;
  retry_max?: number;
  retry_backoff?: RetryBackoff;
  retry_delay_ms?: number;
  fn: (ctx: JobContext) => Promise<unknown>;
}

const builtinWorkers = new Map<string, CompiledWorker>(); // queue → compiled

/**
 * Add a worker from code (core features and extensions). Returns a function
 * that removes it.
 */
export function registerBuiltinWorker(spec: BuiltinWorkerSpec): () => void {
  const id = `_builtin:${spec.queue}`;
  if (builtinWorkers.has(spec.queue) && builtinWorkers.get(spec.queue)!.fn !== spec.fn) {
    console.warn(`[queues] replacing the code-registered worker for queue '${spec.queue}'`);
  }
  builtinWorkers.set(spec.queue, {
    id,
    name: spec.name ?? id,
    queue: spec.queue,
    concurrency: Math.max(1, spec.concurrency ?? 1),
    retry_max: Math.max(0, spec.retry_max ?? 5),
    retry_backoff: spec.retry_backoff === "fixed" ? "fixed" : "exponential",
    retry_delay_ms: Math.max(50, spec.retry_delay_ms ?? 2000),
    fn: spec.fn,
  });
  const entry = builtinWorkers.get(spec.queue);
  return () => {
    if (builtinWorkers.get(spec.queue) === entry) builtinWorkers.delete(spec.queue);
  };
}

/** The name extensions use; same as registerBuiltinWorker. */
export const registerWorker = registerBuiltinWorker;

export function listRegisteredWorkers(): Array<{ name: string; queue: string; concurrency: number }> {
  return [...builtinWorkers.values()].map((w) => ({ name: w.name, queue: w.queue, concurrency: w.concurrency }));
}

/** Test-only: drop all built-in worker registrations. */
export function _resetBuiltinWorkers(): void {
  builtinWorkers.clear();
}

export function invalidateWorkerCache(): void {
  compiledCache.clear();
  cacheLoaded = false;
}

interface WorkerRow {
  id: string;
  name: string;
  queue: string;
  code: string;
  enabled: number;
  concurrency: number;
  retry_max: number;
  retry_backoff: string;
  retry_delay_ms: number;
}

function compile(row: WorkerRow): CompiledWorker | null {
  try {
    const fn = compileCode<JobContext>(row);
    return {
      id: row.id,
      name: row.name ?? "",
      queue: row.queue,
      concurrency: Math.max(1, row.concurrency),
      retry_max: Math.max(0, row.retry_max),
      retry_backoff: row.retry_backoff === "fixed" ? "fixed" : "exponential",
      retry_delay_ms: Math.max(50, row.retry_delay_ms),
      fn,
    };
  } catch (e) {
    console.error(`[queues] Failed to compile worker ${row.id}:`, e);
    return null;
  }
}

async function loadWorkers(): Promise<CompiledWorker[]> {
  if (cacheLoaded) return [...compiledCache.values()];
  const rows = await getDb().select().from(workers).where(eq(workers.enabled, 1));
  compiledCache.clear();
  for (const r of rows) {
    const c = compile(r as WorkerRow);
    if (c) compiledCache.set(r.id, c);
  }
  cacheLoaded = true;
  return [...compiledCache.values()];
}

/** Enqueue a job onto a named queue. Available via `helpers.enqueue(...)`. */
export async function enqueue(
  queue: string,
  payload: unknown,
  opts: EnqueueOpts = {}
): Promise<{ jobId: string; deduped: boolean }> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const scheduled_at = now + Math.max(0, opts.delay ?? 0);

  // Unique-key dedup: skip if a non-finished job with the same key exists.
  if (opts.uniqueKey) {
    const existing = await db
      .select({ id: jobsLog.id })
      .from(jobsLog)
      .where(and(
        eq(jobsLog.unique_key, opts.uniqueKey),
        or(eq(jobsLog.status, "queued"), eq(jobsLog.status, "running"))!
      ))
      .limit(1);
    if (existing.length > 0) return { jobId: existing[0]!.id, deduped: true };
  }

  const id = crypto.randomUUID();
  await db.insert(jobsLog).values({
    id,
    queue,
    payload: JSON.stringify(payload ?? null),
    unique_key: opts.uniqueKey ?? null,
    attempt: 1,
    status: "queued",
    scheduled_at,
    enqueued_at: now,
    // Per-job overrides; runJob falls back to the worker's settings when null.
    retry_max: typeof opts.retries === "number" ? Math.max(0, Math.floor(opts.retries)) : null,
    retry_backoff: opts.backoff === "fixed" || opts.backoff === "exponential" ? opts.backoff : null,
    retry_delay_ms: typeof opts.retryDelayMs === "number" ? Math.max(0, Math.floor(opts.retryDelayMs)) : null,
  });
  return { jobId: id, deduped: false };
}

// ── Worker loop ──────────────────────────────────────────────────────────────

let schedulerInterval: ReturnType<typeof setInterval> | null = null;
const inFlight = new Map<string, number>(); // worker id → current concurrent count
const POLL_INTERVAL_MS = 500;

/**
 * Start the in-process worker scheduler. Polls the jobs_log table every
 * 500ms looking for queued jobs whose scheduled_at <= now and whose queue
 * has at least one enabled worker with capacity.
 */
export function startQueueScheduler(): void {
  if (schedulerInterval) return;
  // Jobs a previous process left in `running` were never picked up again.
  // Alone, every running job is ours from before a restart; in a cluster a
  // sibling may still be working on it, so only re-queue ones running for
  // longer than STUCK_AFTER_SECONDS.
  const clustered = !!process.env["VAULTBASE_WORKER_ID"];
  void recoverInterruptedJobs(clustered ? Math.floor(Date.now() / 1000) - STUCK_AFTER_SECONDS : Math.floor(Date.now() / 1000))
    .catch(() => { /* retried by the sweep */ });
  if (clustered) {
    recoveryInterval = setInterval(() => {
      void recoverInterruptedJobs(Math.floor(Date.now() / 1000) - STUCK_AFTER_SECONDS).catch(() => { /* next sweep */ });
    }, 60_000);
    recoveryInterval.unref?.();
  }
  schedulerInterval = setInterval(() => { void tick().catch(() => { /* next tick */ }); }, POLL_INTERVAL_MS);
  void tick();
}

export function stopQueueScheduler(): void {
  if (schedulerInterval) clearInterval(schedulerInterval);
  schedulerInterval = null;
  if (recoveryInterval) clearInterval(recoveryInterval);
  recoveryInterval = null;
}

let recoveryInterval: ReturnType<typeof setInterval> | null = null;
/** In cluster mode, a job running this long is assumed to have lost its process. */
const STUCK_AFTER_SECONDS = 60 * 60;

/**
 * Put jobs stuck in `running` (claimed at or before `startedBefore`) back on
 * the queue, counting the interrupted run as an attempt. A job already out
 * of attempts (its own `retry_max`, else its worker's, else 3) is marked
 * dead instead: re-queuing it regardless let a job that crashes the process
 * restart it in a loop. Returns how many were re-queued.
 */
export async function recoverInterruptedJobs(startedBefore: number): Promise<number> {
  const client = (getDb() as unknown as { $client: { prepare: (sql: string) => { run: (...p: unknown[]) => { changes: number } } } }).$client;
  const now = Math.floor(Date.now() / 1000);
  const maxAttempts = `coalesce(j.retry_max,
      (SELECT max(w.retry_max) FROM vaultbase_workers w WHERE w.queue = j.queue AND w.enabled = 1), 3)`;
  client.prepare(
    `UPDATE vaultbase_jobs_log AS j
        SET status = 'dead', finished_at = ?, error = 'interrupted: the process running this job stopped, and no attempts are left'
      WHERE j.status = 'running' AND j.started_at <= ? AND j.attempt >= ${maxAttempts}`,
  ).run(now, startedBefore);
  return client.prepare(
    `UPDATE vaultbase_jobs_log AS j
        SET status = 'queued', attempt = j.attempt + 1, worker_id = NULL, started_at = NULL,
            scheduled_at = ?, error = 'interrupted: the process running this job stopped'
      WHERE j.status = 'running' AND j.started_at <= ?`,
  ).run(now, startedBefore).changes;
}

/**
 * Wait (up to `timeoutMs`) for jobs this process is running to finish, so a
 * shutdown doesn't leave finished work marked `running` to be re-run.
 */
export async function waitForRunningJobs(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while ([...inFlight.values()].some((n) => n > 0)) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

async function tick(): Promise<void> {
  const compiled = await loadWorkers();

  // Group workers by queue, picking a single worker per queue per tick to
  // avoid two workers grabbing the same job. (Multiple workers per queue is
  // a future addition; for now the first one wins.)
  const byQueue = new Map<string, CompiledWorker>();
  // User-defined workers first — they take precedence over builtins.
  for (const w of compiled) if (!byQueue.has(w.queue)) byQueue.set(w.queue, w);
  // Builtins fill in any queues the user hasn't claimed.
  for (const [queue, w] of builtinWorkers) if (!byQueue.has(queue)) byQueue.set(queue, w);

  if (byQueue.size === 0) return;

  for (const [queue, worker] of byQueue) {
    const current = inFlight.get(worker.id) ?? 0;
    const slots = worker.concurrency - current;
    if (slots <= 0) continue;
    await claimAndRun(queue, worker, slots);
  }
}

async function claimAndRun(queue: string, worker: CompiledWorker, slots: number): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // Pull up to `slots` queued jobs whose scheduled_at has arrived.
  const pending = await db
    .select()
    .from(jobsLog)
    .where(and(
      eq(jobsLog.queue, queue),
      eq(jobsLog.status, "queued"),
      lt(jobsLog.scheduled_at, now + 1),
    ))
    .orderBy(asc(jobsLog.scheduled_at))
    .limit(slots);

  for (const job of pending) {
    // Optimistic claim: flip status to "running" with a worker stamp. If the
    // row already changed (some other tick beat us), the WHERE clause filters
    // and we move on.
    const claim = await db
      .update(jobsLog)
      .set({ status: "running", worker_id: worker.id, started_at: now })
      .where(and(eq(jobsLog.id, job.id), eq(jobsLog.status, "queued")))
      .returning({ id: jobsLog.id });
    if (claim.length === 0) continue;

    inFlight.set(worker.id, (inFlight.get(worker.id) ?? 0) + 1);
    void runJob(worker, job).finally(() => {
      inFlight.set(worker.id, Math.max(0, (inFlight.get(worker.id) ?? 1) - 1));
    });
  }
}

async function runJob(worker: CompiledWorker, job: typeof jobsLog.$inferSelect): Promise<void> {
  const db = getDb();
  const helpers = makeHookHelpers({ name: worker.name });
  let payload: unknown = null;
  try { payload = JSON.parse(job.payload); } catch { payload = null; }

  const ctx: JobContext = {
    payload,
    attempt: job.attempt,
    queue: job.queue,
    jobId: job.id,
    helpers,
  };

  const finishedAt = (): number => Math.floor(Date.now() / 1000);
  try {
    await worker.fn(ctx);
    await db.update(jobsLog).set({
      status: "succeeded",
      finished_at: finishedAt(),
      error: null,
    }).where(eq(jobsLog.id, job.id));
  } catch (e) {
    const msg = e instanceof ValidationError
      ? `ValidationError: ${e.message}`
      : (e instanceof Error ? (e.stack ?? e.message) : String(e));
    // Per-job overrides from enqueue() win over the worker's defaults.
    const retryMax = job.retry_max ?? worker.retry_max;
    const backoff = job.retry_backoff ?? worker.retry_backoff;
    const baseDelayMs = job.retry_delay_ms ?? worker.retry_delay_ms;
    const willRetry = job.attempt < retryMax;
    if (willRetry) {
      const delayMs = backoff === "exponential"
        ? baseDelayMs * Math.pow(2, job.attempt - 1)
        : baseDelayMs;
      const next = Math.floor((Date.now() + delayMs) / 1000);
      // Re-queue: bump attempt, set status back to queued with a fresh
      // schedule. Keeping the same row preserves the audit trail; a fresh
      // row would lose the retry chain.
      await db.update(jobsLog).set({
        status: "queued",
        attempt: job.attempt + 1,
        worker_id: null,
        started_at: null,
        scheduled_at: next,
        error: msg,
      }).where(eq(jobsLog.id, job.id));
    } else {
      await db.update(jobsLog).set({
        status: "dead",
        finished_at: finishedAt(),
        error: msg,
      }).where(eq(jobsLog.id, job.id));
      console.error(`[queues] Job ${job.id} dead after ${job.attempt} attempts: ${msg}`);
    }
  }
}

// ── Admin operations ────────────────────────────────────────────────────────

/** Manually retry a previously-failed/dead job. Resets attempt counter to 1. */
export async function retryJob(id: string): Promise<boolean> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const r = await db
    .update(jobsLog)
    .set({ status: "queued", attempt: 1, scheduled_at: now, started_at: null, finished_at: null, error: null, worker_id: null })
    .where(and(eq(jobsLog.id, id), inArray(jobsLog.status, ["failed", "dead", "succeeded"])))
    .returning({ id: jobsLog.id });
  return r.length > 0;
}

/** Drop a job (typically a stuck "queued" or noisy "dead"). */
export async function discardJob(id: string): Promise<boolean> {
  const db = getDb();
  const r = await db
    .delete(jobsLog)
    .where(and(eq(jobsLog.id, id), or(eq(jobsLog.status, "queued"), eq(jobsLog.status, "dead"), eq(jobsLog.status, "failed"))!))
    .returning({ id: jobsLog.id });
  return r.length > 0;
}

export interface JobsLogQuery {
  queue?: string;
  status?: JobStatus;
  worker_id?: string;
  page?: number;
  perPage?: number;
}

export async function listJobsLog(opts: JobsLogQuery = {}) {
  const db = getDb();
  const page = Math.max(1, opts.page ?? 1);
  const perPage = Math.min(200, Math.max(1, opts.perPage ?? 50));

  const conds = [];
  if (opts.queue) conds.push(eq(jobsLog.queue, opts.queue));
  if (opts.status) conds.push(eq(jobsLog.status, opts.status));
  if (opts.worker_id) conds.push(eq(jobsLog.worker_id, opts.worker_id));
  const where = conds.length > 0 ? and(...conds) : undefined;

  const rows = await db
    .select()
    .from(jobsLog)
    .where(where)
    .orderBy(desc(jobsLog.enqueued_at))
    .limit(perPage)
    .offset((page - 1) * perPage);
  return { data: rows, page, perPage };
}

/**
 * Dashboard counts per queue. Single SELECT with COUNT(... CASE ...) so the
 * jobs page can render cards without a roundtrip per status.
 */
export interface QueueStatRow {
  queue: string;
  /** All-time counts. Unchanged for existing callers. */
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  dead: number;
  /** Counts restricted to the last `windowSec`, keyed off `finished_at`. */
  succeeded_window: number;
  failed_window: number;
  dead_window: number;
  /** `enqueued_at` of the oldest still-queued job, or null when idle. */
  oldest_queued_at: number | null;
}

/**
 * Per-queue counters for the dashboard.
 *
 * `windowSec` adds the `*_window` counts and leaves the all-time ones alone,
 * so the range picker can scope "failed in the last 24h" without changing what
 * existing callers read. Defaults to 24h.
 */
export async function queueStats(windowSec = 86_400): Promise<QueueStatRow[]> {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - Math.max(60, windowSec);

  const blank = (queue: string): QueueStatRow => ({
    queue,
    queued: 0, running: 0, succeeded: 0, failed: 0, dead: 0,
    succeeded_window: 0, failed_window: 0, dead_window: 0,
    oldest_queued_at: null,
  });

  // Count in SQL: loading every jobs_log row into JS on each dashboard load
  // grew without bound.
  const counts = await db
    .select({ queue: jobsLog.queue, status: jobsLog.status, n: sql<number>`count(*)` })
    .from(jobsLog)
    .groupBy(jobsLog.queue, jobsLog.status);
  const map = new Map<string, QueueStatRow>();
  for (const { queue, status, n } of counts) {
    if (!map.has(queue)) map.set(queue, blank(queue));
    const e = map.get(queue)!;
    if (status === "queued" || status === "running" || status === "succeeded" || status === "failed" || status === "dead") {
      e[status] += Number(n);
    }
  }

  // Windowed terminal counts. `finished_at` is only set once a job settles, so
  // rows still in flight are correctly excluded.
  const windowed = await db
    .select({ queue: jobsLog.queue, status: jobsLog.status, n: sql<number>`count(*)` })
    .from(jobsLog)
    .where(sql`${jobsLog.finished_at} is not null and ${jobsLog.finished_at} >= ${cutoff}`)
    .groupBy(jobsLog.queue, jobsLog.status);
  for (const { queue, status, n } of windowed) {
    if (!map.has(queue)) map.set(queue, blank(queue));
    const e = map.get(queue)!;
    if (status === "succeeded") e.succeeded_window += Number(n);
    else if (status === "failed") e.failed_window += Number(n);
    else if (status === "dead") e.dead_window += Number(n);
  }

  // Oldest still-queued job per queue — drives the "OLDEST" backlog column.
  const oldest = await db
    .select({ queue: jobsLog.queue, at: sql<number>`min(${jobsLog.enqueued_at})` })
    .from(jobsLog)
    .where(eq(jobsLog.status, "queued"))
    .groupBy(jobsLog.queue);
  for (const { queue, at } of oldest) {
    if (!map.has(queue)) map.set(queue, blank(queue));
    map.get(queue)!.oldest_queued_at = at === null ? null : Number(at);
  }

  // Workers may exist with zero jobs yet — surface their queues so admins see them.
  const all_workers = await db.select({ queue: workers.queue }).from(workers);
  for (const w of all_workers) {
    if (!map.has(w.queue)) map.set(w.queue, blank(w.queue));
  }
  return [...map.values()].sort((a, b) => a.queue.localeCompare(b.queue));
}

// Avoid unused-import warning when no scheduled-job logic uses `isNull`.
void isNull;
