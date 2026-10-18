/**
 * /_/health only says the process is up. /_/ready checks the database,
 * storage, read workers, queues and log writes, and answers 503 when the
 * server can't serve. /metrics gains the error, backlog, worker and
 * log-failure series the review found missing, and failed log writes are
 * counted instead of swallowed.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir, appendLogEntry, drainLogBuffer, logWriteFailures, _resetLogWriteFailures } from "../core/file-logger.ts";
import { setUploadDir, invalidateStorageCache } from "../core/storage.ts";
import { checkReadiness } from "../core/readiness.ts";
import { enqueue, startQueueScheduler, stopQueueScheduler } from "../core/queues.ts";
import { jobsLog, admin } from "../db/schema.ts";
import { eq } from "drizzle-orm";
import { makeMetricsPlugin } from "../api/metrics.ts";
import { setSetting } from "../api/settings.ts";
import { signAuthToken } from "../core/sec.ts";

const SECRET = "test-secret-ready";
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "vb-ready-"));
  setLogsDir(join(dir, "logs"));
  // Log write failures are counted per process: other test files leave some.
  _resetLogWriteFailures();
  setUploadDir(join(dir, "uploads"));
  invalidateStorageCache();
  await initDb(":memory:");
  await runMigrations();
});

afterEach(async () => {
  stopQueueScheduler();
  try { chmodSync(join(dir, "logs"), 0o755); } catch { /* ignore */ }
  await closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("readiness", () => {
  it("is ready with the database, storage and queues working", async () => {
    startQueueScheduler();
    const r = await checkReadiness();
    expect(r.status).toBe("ready");
    expect(r.checks["database"]!.status).toBe("ok");
    expect(r.checks["storage"]!.status).toBe("ok");
    expect(r.checks["queues"]!.status).toBe("ok");
  });

  it("is degraded when jobs wait long past their time", async () => {
    startQueueScheduler();
    const { jobId } = await enqueue("nobody-works-this", null);
    await getDb().update(jobsLog).set({ scheduled_at: Math.floor(Date.now() / 1000) - 3600 }).where(eq(jobsLog.id, jobId));
    const r = await checkReadiness();
    expect(r.status).toBe("degraded");
    expect(r.checks["queues"]!.detail).toContain("1 job");
  });

  it("is degraded when the queue scheduler isn't running", async () => {
    expect((await checkReadiness()).checks["queues"]!.status).toBe("degraded");
    expect((await checkReadiness({ queues: false })).checks["queues"]).toBeUndefined();
  });

  it("is unready when the database is gone", async () => {
    await closeDb();
    const r = await checkReadiness();
    expect(r.status).toBe("unready");
    expect(r.checks["database"]!.status).toBe("down");
    await initDb(":memory:");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("is degraded after a failed log write, which is counted", async () => {
    startQueueScheduler();
    const before = logWriteFailures().failedWrites;
    chmodSync(join(dir, "logs"), 0o500);
    appendLogEntry({ id: "1", ts: new Date().toISOString(), created_at: 0, method: "GET", path: "/x", status: 200, duration_ms: 1, ip: null });
    await drainLogBuffer();
    expect(logWriteFailures().failedWrites).toBe(before + 1);
    const r = await checkReadiness();
    expect(r.checks["logs"]!.status).toBe("degraded");
  });
});

describe("/metrics", () => {
  it("reports responses by class, backlogs, workers and log failures", async () => {
    setSetting("metrics.enabled", "1");
    await getDb().insert(admin).values({ id: "a1", email: "a@x", password_hash: "x", password_reset_at: 0, created_at: 0 });
    const { token } = await signAuthToken({ payload: { id: "a1", email: "a@x" }, audience: "admin", expiresInSeconds: 600, jwtSecret: SECRET });
    await enqueue("q", null);
    const res = await makeMetricsPlugin(SECRET).handle(new Request("http://localhost/metrics", { headers: { authorization: `Bearer ${token}` } }));
    const text = await res.text();
    for (const series of [
      'vaultbase_responses_total{class="5xx"}', 'vaultbase_jobs{status="queued"} 1', 'vaultbase_jobs{status="dead"} 0',
      "vaultbase_jobs_oldest_due_seconds", 'vaultbase_webhook_deliveries{status="pending"} 0',
      'vaultbase_read_workers{state="configured"} 0', "vaultbase_log_write_failures_total",
    ]) expect(text).toContain(series);
  });
});
