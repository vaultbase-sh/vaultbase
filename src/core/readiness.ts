/**
 * Readiness: can this server do its work right now? `/_/health` stays the
 * cheap liveness answer (the process is up); `/_/ready` checks what the
 * server depends on and answers 503 when it can't serve.
 *
 * - database: a round trip within 2 s. Down → not ready.
 * - storage: a lookup in the configured storage within 3 s. Failing → not ready.
 * - read workers: fewer running than configured → degraded (reads fall back
 *   to the main thread, slower).
 * - queues: the scheduler isn't running, or jobs are waiting more than five
 *   minutes past their time → degraded.
 * - logs: a log write failed in the last five minutes → degraded.
 *
 * Degraded answers 200 with the reason, so a load balancer keeps sending
 * traffic while an alert on `status` can still fire.
 */
import { db } from "../db/index.ts";
import { fileExists } from "./storage.ts";
import { readPoolSize, readPoolTarget } from "./read-pool.ts";
import { queueSchedulerRunning } from "./queues.ts";
import { logWriteFailures } from "./file-logger.ts";

export type CheckState = "ok" | "degraded" | "down";

export interface ReadinessReport {
  status: "ready" | "degraded" | "unready";
  checks: Record<string, { status: CheckState; detail?: string; ms?: number }>;
}

const OVERDUE_S = 300;
const LOG_FAILURE_WINDOW_MS = 5 * 60_000;

async function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

async function timed(ms: number, fn: () => Promise<string | undefined | void>): Promise<{ status: CheckState; detail?: string; ms: number }> {
  const t0 = performance.now();
  try {
    const detail = await within(ms, fn());
    return { status: "ok", ...(detail ? { detail } : {}), ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { status: "down", detail: e instanceof Error ? e.message : String(e), ms: Math.round(performance.now() - t0) };
  }
}

/** `queues` is off on a read worker, which runs no scheduler. */
export async function checkReadiness(opts: { queues?: boolean } = {}): Promise<ReadinessReport> {
  const checks: ReadinessReport["checks"] = {};
  checks["database"] = await timed(2_000, async () => { await db.all("SELECT 1"); });
  checks["storage"] = await timed(3_000, async () => { await fileExists(".vaultbase-ready-probe"); });

  const target = readPoolTarget();
  if (target > 0) {
    const running = readPoolSize();
    checks["read_workers"] = running >= target
      ? { status: "ok", detail: `${running} of ${target}` }
      : { status: "degraded", detail: `${running} of ${target} running; reads on the main thread meanwhile` };
  }

  if (opts.queues !== false && checks["database"].status === "ok") {
    const now = Math.floor(Date.now() / 1000);
    let overdue = 0;
    try {
      const [row] = await db.all<{ n: number }>(
        `SELECT COUNT(*) AS n FROM vaultbase_jobs_log WHERE status = 'queued' AND scheduled_at < ?`, [now - OVERDUE_S],
      );
      overdue = Number(row?.n ?? 0);
    } catch { /* counted as none */ }
    if (!queueSchedulerRunning()) checks["queues"] = { status: "degraded", detail: "the queue scheduler isn't running" };
    else if (overdue > 0) checks["queues"] = { status: "degraded", detail: `${overdue} job(s) waiting more than ${OVERDUE_S / 60} minutes past their time` };
    else checks["queues"] = { status: "ok" };
  }

  const logs = logWriteFailures();
  checks["logs"] = logs.lastAt > Date.now() - LOG_FAILURE_WINDOW_MS
    ? { status: "degraded", detail: `log writes failing: ${logs.lastError}` }
    : { status: "ok" };

  const states = Object.values(checks).map((c) => c.status);
  const status = states.includes("down") ? "unready" : states.includes("degraded") ? "degraded" : "ready";
  return { status, checks };
}
