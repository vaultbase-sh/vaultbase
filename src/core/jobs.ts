import { and, eq } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { getDb } from "../db/client.ts";
import { jobs } from "../db/schema.ts";
import { ValidationError } from "./validate.ts";
import { makeHookHelpers, type HookHelpers } from "./hooks.ts";
import { appendHookLog } from "./file-logger.ts";
import { compileCode } from "./code-loader.ts";

/**
 * Cron-style scheduled jobs.
 *
 * - Each job is JS code compiled via AsyncFunction("ctx", code).
 * - A scheduler loop runs every 30s, executing any job whose next_run_at <= now.
 * - On success: last_run_at, last_status="ok", next_run_at = next future time.
 * - On error:   last_run_at, last_status="error", last_error=msg, next_run_at = next future time.
 *
 * Timezone: parser uses UTC. Single-process — no clustering.
 */

export interface JobContext {
  helpers: HookHelpers;
  /** When this run was scheduled (unix seconds) */
  scheduledAt: number;
}

interface JobRow {
  id: string;
  name: string;
  cron: string;
  code: string;
  enabled: number;
  /**
   * "inline" (default) → cron tick executes the job's code in-process.
   * "worker:<queue>"   → cron tick enqueues a job onto the named queue,
   *                       and a worker on that queue processes it async.
   */
  mode: string;
  last_run_at: number | null;
  next_run_at: number | null;
}

const compiledCache = new Map<string, (ctx: JobContext) => Promise<unknown>>();

export function invalidateJobsCache(): void {
  compiledCache.clear();
}

function compile(row: JobRow): ((ctx: JobContext) => Promise<unknown>) | null {
  const cached = compiledCache.get(row.id);
  if (cached) return cached;
  try {
    const fn = compileCode<JobContext>(row);
    compiledCache.set(row.id, fn);
    return fn;
  } catch (e) {
    console.error(`[jobs] Failed to compile job ${row.id}:`, e);
    return null;
  }
}

export function nextRunFromCron(cronExpr: string, fromSec?: number): number {
  const opts: { tz: string; currentDate?: number } = { tz: "UTC" };
  if (fromSec !== undefined) opts.currentDate = fromSec * 1000;
  const interval = CronExpressionParser.parse(cronExpr, opts);
  return Math.floor(interval.next().getTime() / 1000);
}

export function validateCron(cronExpr: string): string | null {
  try { CronExpressionParser.parse(cronExpr, { tz: "UTC" }); return null; }
  catch (e) { return e instanceof Error ? e.message : "Invalid cron expression"; }
}

export async function runJob(jobId: string): Promise<{ ok: boolean; error?: string }> {
  const db = getDb();
  const rows = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  const row = rows[0] as JobRow | undefined;
  if (!row) return { ok: false, error: "Job not found" };
  const now = Math.floor(Date.now() / 1000);
  let nextRun: number | null = null;
  try { nextRun = nextRunFromCron(row.cron, now); }
  catch { nextRun = null; }

  // Worker-mode: cron tick enqueues onto the named queue and returns. The
  // worker handles execution async — the job's `code` is treated as the
  // payload's "kind" hint via job.name (workers can branch on it).
  const workerMatch = /^worker:(.+)$/.exec(row.mode ?? "inline");
  if (workerMatch) {
    const queue = workerMatch[1]!.trim();
    if (!queue) {
      const msg = `Invalid mode "${row.mode}" — expected "worker:<queue>"`;
      await db.update(jobs).set({
        last_run_at: now, last_status: "error", last_error: msg,
        next_run_at: nextRun, updated_at: now,
      }).where(eq(jobs.id, jobId));
      return { ok: false, error: msg };
    }
    try {
      const { enqueue } = await import("./queues.ts");
      const r = await enqueue(queue, { jobId, jobName: row.name, scheduledAt: now });
      await db.update(jobs).set({
        last_run_at: now, last_status: "ok", last_error: null,
        next_run_at: nextRun, updated_at: now,
      }).where(eq(jobs.id, jobId));
      appendHookLog({
        name: row.name,
        message: `cron job "${row.name || row.id.slice(0, 8)}" enqueued onto ${queue} (job=${r.jobId}${r.deduped ? " · deduped" : ""})`,
      });
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await db.update(jobs).set({
        last_run_at: now, last_status: "error", last_error: msg,
        next_run_at: nextRun, updated_at: now,
      }).where(eq(jobs.id, jobId));
      return { ok: false, error: msg };
    }
  }

  const fn = compile(row);
  if (!fn) return { ok: false, error: "Failed to compile job code" };

  const helpers = makeHookHelpers({ name: row.name });
  const ctx: JobContext = { helpers, scheduledAt: now };

  try {
    await fn(ctx);
    await db.update(jobs).set({
      last_run_at: now,
      last_status: "ok",
      last_error: null,
      next_run_at: nextRun,
      updated_at: now,
    }).where(eq(jobs.id, jobId));
    appendHookLog({
      name: row.name,
      message: `cron job "${row.name || row.id.slice(0, 8)}" ran successfully`,
    });
    return { ok: true };
  } catch (e) {
    const msg = e instanceof ValidationError ? e.message : (e instanceof Error ? e.message : String(e));
    await db.update(jobs).set({
      last_run_at: now,
      last_status: "error",
      last_error: msg,
      next_run_at: nextRun,
      updated_at: now,
    }).where(eq(jobs.id, jobId));
    appendHookLog({
      name: row.name,
      message: `cron job "${row.name || row.id.slice(0, 8)}" failed: ${msg}`,
    });
    return { ok: false, error: msg };
  }
}

let schedulerInterval: ReturnType<typeof setInterval> | null = null;

/** Jobs started by this process that haven't finished yet. */
const runningJobs = new Set<string>();

// ── Jobs registered from code ───────────────────────────────────────────────

export interface JobRegistration {
  name: string;
  /** Five-field cron expression, UTC. */
  cron: string;
  run(ctx: JobContext): unknown;
}

interface RegisteredJob extends JobRegistration { key: string; nextRunAt: number }

const registeredJobs: RegisteredJob[] = [];

/**
 * Add a cron job from code (an extension). It runs inline on the same
 * scheduler as the admin UI's jobs (cluster worker 0 only); its schedule is
 * kept in memory, so a slot missed while the server was down isn't caught up.
 */
export function registerJob(def: JobRegistration): () => void {
  const err = validateCron(def.cron);
  if (err) throw new Error(`job '${def.name}': ${err}`);
  const job: RegisteredJob = { ...def, key: `ext:${def.name}`, nextRunAt: nextRunFromCron(def.cron) };
  registeredJobs.push(job);
  return () => {
    const i = registeredJobs.indexOf(job);
    if (i >= 0) registeredJobs.splice(i, 1);
  };
}

export function listRegisteredJobs(): Array<{ name: string; cron: string; nextRunAt: number }> {
  return registeredJobs.map((j) => ({ name: j.name, cron: j.cron, nextRunAt: j.nextRunAt }));
}

async function runRegisteredJob(job: RegisteredJob, scheduledAt: number): Promise<void> {
  try {
    await job.run({ helpers: makeHookHelpers({ name: job.name }), scheduledAt });
    appendHookLog({ name: job.name, message: `cron job "${job.name}" ran successfully` });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    appendHookLog({ name: job.name, message: `cron job "${job.name}" failed: ${msg}` });
  }
}

function dueRegisteredJobs(now: number): Promise<unknown>[] {
  const started: Promise<unknown>[] = [];
  for (const job of registeredJobs) {
    if (job.nextRunAt > now || runningJobs.has(job.key)) continue;
    job.nextRunAt = nextRunFromCron(job.cron, now);
    runningJobs.add(job.key);
    started.push(runRegisteredJob(job, now).finally(() => runningJobs.delete(job.key)));
  }
  return started;
}

async function scheduleTick(): Promise<Promise<unknown>[]> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const rows = await db.select().from(jobs).where(eq(jobs.enabled, 1));
  const started: Promise<unknown>[] = dueRegisteredJobs(now);
  for (const r of rows) {
    if (r.next_run_at !== null && r.next_run_at <= now) {
      if (runningJobs.has(r.id)) continue; // still running from an earlier slot
      // Claim the slot: move next_run_at on only if no other tick or cluster
      // worker already did. Exactly one claimant runs each slot.
      let next: number;
      try { next = nextRunFromCron(r.cron, now); } catch { continue; }
      const claim = await db.update(jobs)
        .set({ next_run_at: next, updated_at: now })
        .where(and(eq(jobs.id, r.id), eq(jobs.next_run_at, r.next_run_at)))
        .returning({ id: jobs.id });
      if (claim.length === 0) continue;
      runningJobs.add(r.id);
      started.push(runJob(r.id).finally(() => runningJobs.delete(r.id)));
    } else if (r.next_run_at === null) {
      // Newly created or never run — initialize next_run_at
      try {
        const next = nextRunFromCron(r.cron, now);
        await db.update(jobs).set({ next_run_at: next, updated_at: now }).where(eq(jobs.id, r.id));
      } catch { /* invalid cron — skip */ }
    }
  }
  return started;
}

/** Test hook: one scheduler pass, resolving when the jobs it started finish. */
export async function _jobsTickOnce(): Promise<void> {
  await Promise.all(await scheduleTick());
}

export function startScheduler(): void {
  if (schedulerInterval) return;
  // Run once at startup, then every 30s
  void scheduleTick();
  schedulerInterval = setInterval(() => { void scheduleTick(); }, 30_000);
}

export function stopScheduler(): void {
  if (schedulerInterval) clearInterval(schedulerInterval);
  schedulerInterval = null;
}
