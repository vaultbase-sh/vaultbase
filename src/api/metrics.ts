import Elysia from "elysia";
import { createHash, timingSafeEqual } from "crypto";
import { statSync } from "fs";
import { globalMetrics, STEPS } from "../core/perf-metrics.ts";
import { getRawClient } from "../db/client.ts";
import { db } from "../db/index.ts";
import { getSetting } from "./settings.ts";
import { adminFromRequest, adminGuard } from "./_admin.ts";
import { connectionCount } from "../realtime/manager.ts";
import { checkpointStats, type CheckpointStats } from "../db/checkpointer.ts";
import { queryStatsReport, resetQueryStats } from "../core/query-stats.ts";
import { readPoolStats } from "../core/read-pool.ts";
import { broadcast } from "../core/thread-bus.ts";

interface SqliteSnapshot {
  page_count: number;
  page_size: number;
  cache_used_pages: number;
  wal_pages: number;
  /** On-disk bytes of the main DB file and its WAL; 0 for in-memory. */
  db_bytes: number;
  wal_bytes: number;
  checkpoint: CheckpointStats | null;
}

async function sqliteSnapshot(): Promise<SqliteSnapshot | null> {
  try {
    const pc = await db.get<{ page_count: number }>("PRAGMA page_count");
    const ps = await db.get<{ page_size: number }>("PRAGMA page_size");
    // WAL size comes from the background checkpointer's last pass. Running a
    // checkpoint here on every poll cost ~10% write throughput under load.
    const ckpt = checkpointStats();
    // TODO(db-facade): the driver does not expose the database path yet
    const file = (getRawClient() as { filename?: string }).filename ?? "";
    return {
      db_bytes: fileBytes(file),
      wal_bytes: fileBytes(file ? `${file}-wal` : ""),
      page_count: pc?.page_count ?? 0,
      page_size: ps?.page_size ?? 0,
      cache_used_pages: 0, // bun:sqlite doesn't expose `PRAGMA cache_used` reliably
      wal_pages: ckpt?.wal_frames ?? 0,
      checkpoint: ckpt,
    };
  } catch {
    return null;
  }
}

function fileBytes(path: string): number {
  if (!path || path === ":memory:") return 0;
  try { return statSync(path).size; } catch { return 0; }
}

// ── Process gauges ──────────────────────────────────────────────────────────

/**
 * Event-loop lag: a 250 ms timer that measures how late it fires. Holds the
 * worst lag seen since the last read, so a poll every second or two still
 * catches a short stall. Started on first plugin build; unref'd so it never
 * keeps the process alive.
 */
const LAG_TICK_MS = 250;
let lagMaxMs = 0;
let lagTimer: ReturnType<typeof setInterval> | null = null;

function startLagSampler(): void {
  if (lagTimer) return;
  let expected = performance.now() + LAG_TICK_MS;
  lagTimer = setInterval(() => {
    const now = performance.now();
    const lag = Math.max(0, now - expected);
    if (lag > lagMaxMs) lagMaxMs = lag;
    expected = now + LAG_TICK_MS;
  }, LAG_TICK_MS);
  (lagTimer as { unref?: () => void }).unref?.();
}

let lastCpu = process.cpuUsage();
let lastCpuAt = performance.now();

function processSnapshot() {
  const mem = process.memoryUsage();
  // CPU% since the previous read (100 = one full core).
  const cpu = process.cpuUsage();
  const now = performance.now();
  const wallUs = (now - lastCpuAt) * 1000;
  const usedUs = (cpu.user - lastCpu.user) + (cpu.system - lastCpu.system);
  lastCpu = cpu;
  lastCpuAt = now;
  const lag = lagMaxMs;
  lagMaxMs = 0;
  return {
    pid: process.pid,
    worker_id: process.env["VAULTBASE_WORKER_ID"] ?? null,
    rss_bytes: mem.rss,
    heap_used_bytes: mem.heapUsed,
    heap_total_bytes: mem.heapTotal,
    cpu_percent: wallUs > 0 ? Math.round((usedUs / wallUs) * 1000) / 10 : 0,
    event_loop_lag_ms: Math.round(lag * 10) / 10,
    realtime_connections: connectionCount(),
  };
}

/** Constant-time string compare; hashing first evens out the lengths. */
function sameSecret(a: string, b: string): boolean {
  const h = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(h(a), h(b));
}

export function makeMetricsPlugin(jwtSecret: string) {
  startLagSampler();
  return new Elysia({ name: "metrics" })
    .use(adminGuard(jwtSecret))
    .get("/_/metrics", async () => {
      return {
        ...globalMetrics.snapshot(),
        process: processSnapshot(),
        sqlite: await sqliteSnapshot(),
        read_workers: readPoolStats(),
      };
    }, { requireAdmin: true })
    .post("/_/metrics/reset", async () => {
      globalMetrics.reset();
      resetQueryStats();
      broadcast({ type: "bus", kind: "metrics-reset" });
      return { data: { reset: true } };
    }, { requireAdmin: true })
    // List-query shapes by total time, with SQLite's plan and the index that
    // would serve a scan or an in-memory sort. See core/query-stats.ts.
    .get("/_/metrics/queries", async () => {
      try {
        return { data: queryStatsReport() };
      } catch {
        return { data: [] };
      }
    }, { requireAdmin: true })
    // Prometheus exposition. Off by default; enable via `metrics.enabled`.
    // Scrapers authenticate with `metrics.token` (Bearer).
    .get("/metrics", async ({ request, set }) => {
      if (getSetting("metrics.enabled", "0") !== "1") {
        set.status = 404;
        return "";
      }
      // Never anonymous: the scrape token when one is set, otherwise an
      // admin token. Enabled with no token, this used to answer anyone.
      const required = getSetting("metrics.token", "");
      const got = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const allowed = required ? sameSecret(got, required) : (await adminFromRequest(request, jwtSecret)) !== null;
      if (!allowed) {
        set.status = 401;
        set.headers["www-authenticate"] = "Bearer";
        return "";
      }
      const snap = globalMetrics.snapshot();
      const sql = await sqliteSnapshot();
      const lines: string[] = [];
      const push = (name: string, help: string, type: string, samples: Array<[string, number]>) => {
        lines.push(`# HELP ${name} ${help}`);
        lines.push(`# TYPE ${name} ${type}`);
        for (const [labels, val] of samples) {
          lines.push(`${name}${labels} ${val}`);
        }
      };
      push("vaultbase_uptime_seconds", "Process uptime in seconds.", "gauge", [["", snap.uptime_seconds]]);
      push("vaultbase_requests_total", "Total finished requests since boot.", "counter", [["", snap.requests_total]]);
      push("vaultbase_rps_1min", "Requests per second over the last 60 s.", "gauge", [["", snap.rps_1min]]);
      // Per-step summary — emit p50/p90/p99/p99.9 quantiles + count.
      const stepSamples: Array<[string, number]> = [];
      const stepCount: Array<[string, number]> = [];
      const stepSum: Array<[string, number]> = [];
      for (const step of STEPS) {
        const h = snap.steps[step];
        stepSamples.push([`{step="${step}",quantile="0.5"}`,    h.p50_us]);
        stepSamples.push([`{step="${step}",quantile="0.9"}`,    h.p90_us]);
        stepSamples.push([`{step="${step}",quantile="0.99"}`,   h.p99_us]);
        stepSamples.push([`{step="${step}",quantile="0.999"}`,  h.p99_9_us]);
        stepCount.push([`{step="${step}"}`, h.count]);
        // _sum derived from mean × count — Prometheus contract is honoured.
        stepSum.push([`{step="${step}"}`, Math.round(h.mean_us * h.count)]);
      }
      push("vaultbase_step_duration_microseconds", "Per-step request latency (microseconds).", "summary", stepSamples);
      lines.push(`# TYPE vaultbase_step_duration_microseconds_count counter`);
      for (const [labels, val] of stepCount) lines.push(`vaultbase_step_duration_microseconds_count${labels} ${val}`);
      lines.push(`# TYPE vaultbase_step_duration_microseconds_sum counter`);
      for (const [labels, val] of stepSum) lines.push(`vaultbase_step_duration_microseconds_sum${labels} ${val}`);
      if (sql) {
        push("vaultbase_sqlite_page_count", "SQLite database page count.",     "gauge", [["", sql.page_count]]);
        push("vaultbase_sqlite_page_size",  "SQLite database page size (B).",  "gauge", [["", sql.page_size]]);
        push("vaultbase_sqlite_wal_pages",  "SQLite WAL log pages.",           "gauge", [["", sql.wal_pages]]);
      }
      set.headers["content-type"] = "text/plain; version=0.0.4; charset=utf-8";
      return lines.join("\n") + "\n";
    });
}
