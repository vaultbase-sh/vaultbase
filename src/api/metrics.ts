import Elysia from "elysia";
import { createHash, timingSafeEqual } from "crypto";
import { globalMetrics, STEPS } from "../core/perf-metrics.ts";
import { getRawClient } from "../db/client.ts";
import { getSetting } from "./settings.ts";
import { adminFromRequest, adminGuard } from "./_admin.ts";

interface SqliteSnapshot {
  page_count: number;
  page_size: number;
  cache_used_pages: number;
  wal_pages: number;
}

function sqliteSnapshot(): SqliteSnapshot | null {
  try {
    const c = getRawClient();
    const pc = c.query("PRAGMA page_count").get() as { page_count: number } | undefined;
    const ps = c.query("PRAGMA page_size").get() as { page_size: number } | undefined;
    // wal_checkpoint(PASSIVE) returns (busy, log_pages, checkpointed_pages); we just want log_pages.
    const wal = c.query("PRAGMA wal_checkpoint(PASSIVE)").get() as Record<string, unknown> | undefined;
    return {
      page_count: pc?.page_count ?? 0,
      page_size: ps?.page_size ?? 0,
      cache_used_pages: 0, // bun:sqlite doesn't expose `PRAGMA cache_used` reliably
      wal_pages: typeof wal?.["log"] === "number" ? wal["log"] as number : 0,
    };
  } catch {
    return null;
  }
}

/** Constant-time string compare; hashing first evens out the lengths. */
function sameSecret(a: string, b: string): boolean {
  const h = (v: string) => createHash("sha256").update(v).digest();
  return timingSafeEqual(h(a), h(b));
}

export function makeMetricsPlugin(jwtSecret: string) {
  return new Elysia({ name: "metrics" })
    .use(adminGuard(jwtSecret))
    .get("/_/metrics", async () => {
      return {
        ...globalMetrics.snapshot(),
        sqlite: sqliteSnapshot(),
      };
    }, { requireAdmin: true })
    .post("/_/metrics/reset", async () => {
      globalMetrics.reset();
      return { data: { reset: true } };
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
      const sql = sqliteSnapshot();
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
