import Elysia from "elysia";
import { createHash, timingSafeEqual } from "crypto";
import { statSync } from "fs";
import { globalMetrics, STEPS } from "../core/perf-metrics.ts";
import { getRawClient } from "../db/client.ts";
import { db, getDriver } from "../db/index.ts";
import { getSetting } from "./settings.ts";
import { adminFromRequest, adminGuard } from "./_admin.ts";
import { connectionCount, realtimeStats } from "../realtime/manager.ts";
import { checkpointStats, type CheckpointStats } from "../db/checkpointer.ts";
import { queryStatsReport, resetQueryStats } from "../core/query-stats.ts";
import { readPoolStats, readPoolTarget } from "../core/read-pool.ts";
import { logWriteFailures } from "../core/file-logger.ts";
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
  if (getDriver().name !== "sqlite") return null;
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

/** The database block every driver fills: which one, how big, and its connections. */
interface DatabaseSnapshot {
  driver: string;
  size_bytes: number;
  /** Server connections to this database (Postgres): all, and running a query now. */
  connections: { total: number; active: number } | null;
}

async function databaseSnapshot(sql: SqliteSnapshot | null): Promise<DatabaseSnapshot | null> {
  try {
    const driver = getDriver().name;
    if (driver === "sqlite") return { driver, size_bytes: sql ? sql.db_bytes + sql.wal_bytes : 0, connections: null };
    const size = await db.get<{ b: number }>(`SELECT pg_database_size(current_database()) AS b`);
    const conns = await db.get<{ total: number; active: number }>(
      `SELECT count(*)::integer AS total, count(*) FILTER (WHERE state = 'active')::integer AS active
         FROM pg_stat_activity WHERE datname = current_database()`,
    );
    return { driver, size_bytes: size?.b ?? 0, connections: conns ?? null };
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
    // Deliveries waiting in the fan-out queue, and connections shed because
    // realtime fell too far behind (realtime/manager.ts).
    realtime_queued_deliveries: realtimeStats().queuedDeliveries,
    realtime_shed_connections: realtimeStats().shedConnections,
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
      const sqlite = await sqliteSnapshot();
      return {
        ...globalMetrics.snapshot(),
        process: processSnapshot(),
        sqlite,
        database: await databaseSnapshot(sqlite),
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
        return { data: await queryStatsReport() };
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
      const dbs = await databaseSnapshot(sql);
      if (dbs) {
        push("vaultbase_database_bytes", "Database size on disk (B).", "gauge", [[`{driver="${dbs.driver}"}`, dbs.size_bytes]]);
        if (dbs.connections) push("vaultbase_database_connections", "Server connections to the database.", "gauge", [
          ['{state="all"}', dbs.connections.total], ['{state="active"}', dbs.connections.active],
        ]);
      }
      if (sql) {
        push("vaultbase_sqlite_page_count", "SQLite database page count.",     "gauge", [["", sql.page_count]]);
        push("vaultbase_sqlite_page_size",  "SQLite database page size (B).",  "gauge", [["", sql.page_size]]);
        push("vaultbase_sqlite_wal_pages",  "SQLite WAL log pages.",           "gauge", [["", sql.wal_pages]]);
      }
      {
        const rt = realtimeStats();
        push("vaultbase_realtime_connections", "Open realtime connections (WebSocket and SSE).", "gauge", [["", rt.connections]]);
        push("vaultbase_realtime_queued_deliveries", "Realtime deliveries waiting to be sent.", "gauge", [["", rt.queuedDeliveries]]);
        push("vaultbase_realtime_shed_connections_total", "Realtime connections disconnected because delivery fell too far behind.", "counter", [["", rt.shedConnections]]);
      }
      push("vaultbase_responses_total", "Finished requests by status class since boot.", "counter",
        (["2xx", "3xx", "4xx", "5xx"] as const).map((c) => [`{class="${c}"}`, snap.status[c]]));
      // Backlogs: what's waiting and what has given up.
      try {
        const jobs = await db.all<{ status: string; n: number }>(`SELECT status, COUNT(*) AS n FROM vaultbase_jobs_log WHERE status IN ('queued', 'running', 'dead') GROUP BY status`);
        const byStatus = Object.fromEntries(jobs.map((r) => [r.status, Number(r.n)]));
        push("vaultbase_jobs", "Queue jobs by status.", "gauge",
          ["queued", "running", "dead"].map((st) => [`{status="${st}"}`, byStatus[st] ?? 0]));
        const now = Math.floor(Date.now() / 1000);
        const [late] = await db.all<{ age: number | null }>(`SELECT MIN(scheduled_at) AS age FROM vaultbase_jobs_log WHERE status = 'queued' AND scheduled_at <= ?`, [now]);
        push("vaultbase_jobs_oldest_due_seconds", "How long the oldest due queued job has waited (0 when none).", "gauge",
          [["", late?.age ? Math.max(0, now - Number(late.age)) : 0]]);
        const hooks = await db.all<{ status: string; n: number }>(`SELECT status, COUNT(*) AS n FROM vaultbase_webhook_deliveries WHERE status IN ('pending', 'dead') GROUP BY status`);
        const byHook = Object.fromEntries(hooks.map((r) => [r.status, Number(r.n)]));
        push("vaultbase_webhook_deliveries", "Webhook deliveries by status.", "gauge",
          ["pending", "dead"].map((st) => [`{status="${st}"}`, byHook[st] ?? 0]));
      } catch { /* tables missing on a fresh database: skipped */ }
      {
        const pool = readPoolStats();
        push("vaultbase_read_workers", "Read worker threads.", "gauge", [['{state="running"}', pool.workers], ['{state="configured"}', readPoolTarget()]]);
        push("vaultbase_read_workers_dropped_total", "Read workers taken out of service since boot.", "counter", [["", pool.dropped]]);
        push("vaultbase_read_workers_restarted_total", "Read workers started to replace dropped ones.", "counter", [["", pool.restarted]]);
      }
      {
        const logs = logWriteFailures();
        push("vaultbase_log_write_failures_total", "Log writes that failed (disk full, permissions).", "counter", [["", logs.failedWrites]]);
        push("vaultbase_log_lines_lost_total", "Log lines lost to failed writes.", "counter", [["", logs.lostLines]]);
      }
      set.headers["content-type"] = "text/plain; version=0.0.4; charset=utf-8";
      return lines.join("\n") + "\n";
    });
}
