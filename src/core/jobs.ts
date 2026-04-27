import { eq } from "drizzle-orm";
import { CronExpressionParser } from "cron-parser";
import { getDb } from "../db/client.ts";
import { jobs } from "../db/schema.ts";
import { ValidationError } from "./validate.ts";
import { makeHookHelpers, type HookHelpers } from "./hooks.ts";
import { appendHookLog } from "./file-logger.ts";

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
  last_run_at: number | null;
  next_run_at: number | null;
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (ctx: JobContext) => Promise<unknown>;

const compiledCache = new Map<string, (ctx: JobContext) => Promise<unknown>>();

export function invalidateJobsCache(): void {
  compiledCache.clear();
}

function compile(row: JobRow): ((ctx: JobContext) => Promise<unknown>) | null {
  const cached = compiledCache.get(row.id);
  if (cached) return cached;
  try {
    const fn = new AsyncFunction("ctx", row.code);
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
  const fn = compile(row);
  if (!fn) return { ok: false, error: "Failed to compile job code" };

  const now = Math.floor(Date.now() / 1000);
  const helpers = makeHookHelpers({ name: row.name });
  const ctx: JobContext = { helpers, scheduledAt: now };

  let nextRun: number | null = null;
  try { nextRun = nextRunFromCron(row.cron, now); }
  catch { nextRun = null; }

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

async function scheduleTick(): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const rows = await db.select().from(jobs).where(eq(jobs.enabled, 1));
  for (const r of rows) {
    if (r.next_run_at !== null && r.next_run_at <= now) {
      void runJob(r.id);
    } else if (r.next_run_at === null) {
      // Newly created or never run — initialize next_run_at
      try {
        const next = nextRunFromCron(r.cron, now);
        await db.update(jobs).set({ next_run_at: next, updated_at: now }).where(eq(jobs.id, r.id));
      } catch { /* invalid cron — skip */ }
    }
  }
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
