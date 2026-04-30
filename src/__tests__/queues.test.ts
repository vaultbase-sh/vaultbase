import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { workers, jobsLog } from "../db/schema.ts";
import {
  enqueue,
  invalidateWorkerCache,
  startQueueScheduler,
  stopQueueScheduler,
  retryJob,
  discardJob,
  listJobsLog,
  queueStats,
} from "../core/queues.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-queues-"));
  setLogsDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
  invalidateWorkerCache();
});

afterEach(() => {
  stopQueueScheduler();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function insertWorker(opts: {
  queue: string;
  code: string;
  name?: string;
  concurrency?: number;
  retry_max?: number;
  retry_backoff?: "exponential" | "fixed";
  retry_delay_ms?: number;
}): Promise<string> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(workers).values({
    id,
    name: opts.name ?? "",
    queue: opts.queue,
    code: opts.code,
    enabled: 1,
    concurrency: opts.concurrency ?? 1,
    retry_max: opts.retry_max ?? 3,
    retry_backoff: opts.retry_backoff ?? "exponential",
    retry_delay_ms: opts.retry_delay_ms ?? 50,
    created_at: now,
    updated_at: now,
  });
  invalidateWorkerCache();
  return id;
}

async function getJob(id: string) {
  const r = await getDb().select().from(jobsLog).where(eq(jobsLog.id, id)).limit(1);
  return r[0];
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForStatus(id: string, want: string, timeoutMs = 4000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const j = await getJob(id);
    if (j?.status === want) return;
    await sleep(40);
  }
  throw new Error(`Timed out waiting for job ${id} → ${want} (last status: ${(await getJob(id))?.status})`);
}

describe("queues", () => {
  it("enqueue inserts a queued job row", async () => {
    const r = await enqueue("default", { hello: "world" });
    expect(r.deduped).toBe(false);
    const j = await getJob(r.jobId);
    expect(j?.status).toBe("queued");
    expect(j?.queue).toBe("default");
    expect(JSON.parse(j!.payload)).toEqual({ hello: "world" });
    expect(j?.attempt).toBe(1);
  });

  it("enqueue with delay sets scheduled_at into the future", async () => {
    const before = Math.floor(Date.now() / 1000);
    const r = await enqueue("default", null, { delay: 60 });
    const j = await getJob(r.jobId);
    expect(j!.scheduled_at).toBeGreaterThanOrEqual(before + 60);
  });

  it("uniqueKey dedups while a non-finished job exists", async () => {
    const r1 = await enqueue("default", { x: 1 }, { uniqueKey: "k1" });
    const r2 = await enqueue("default", { x: 2 }, { uniqueKey: "k1" });
    expect(r2.deduped).toBe(true);
    expect(r2.jobId).toBe(r1.jobId);
  });

  it("uniqueKey allows re-enqueue after finished status", async () => {
    const r1 = await enqueue("default", { x: 1 }, { uniqueKey: "k2" });
    await getDb().update(jobsLog).set({ status: "succeeded" }).where(eq(jobsLog.id, r1.jobId));
    const r2 = await enqueue("default", { x: 2 }, { uniqueKey: "k2" });
    expect(r2.deduped).toBe(false);
    expect(r2.jobId).not.toBe(r1.jobId);
  });

  it("worker runs a job to success", async () => {
    await insertWorker({ queue: "q1", code: `return ctx.payload;` });
    const r = await enqueue("q1", { ok: true });
    startQueueScheduler();
    await waitForStatus(r.jobId, "succeeded");
    const j = await getJob(r.jobId);
    expect(j?.error).toBeNull();
    expect(j?.finished_at).not.toBeNull();
  });

  it("worker retries on error then dead-letters past retry_max", async () => {
    await insertWorker({
      queue: "q-retry",
      retry_max: 2,
      retry_backoff: "fixed",
      retry_delay_ms: 50,
      code: `throw new Error("boom");`,
    });
    const r = await enqueue("q-retry", null);
    startQueueScheduler();
    await waitForStatus(r.jobId, "dead", 8000);
    const j = await getJob(r.jobId);
    expect(j?.attempt).toBe(2); // attempt fields up to retry_max attempts
    expect(j?.error).toContain("boom");
  });

  it("retryJob resets a dead job to queued attempt=1", async () => {
    await insertWorker({
      queue: "q-rl",
      retry_max: 0,
      code: `throw new Error("fail");`,
    });
    const r = await enqueue("q-rl", null);
    startQueueScheduler();
    await waitForStatus(r.jobId, "dead", 4000);
    stopQueueScheduler();
    const ok = await retryJob(r.jobId);
    expect(ok).toBe(true);
    const j = await getJob(r.jobId);
    expect(j?.status).toBe("queued");
    expect(j?.attempt).toBe(1);
    expect(j?.error).toBeNull();
  });

  it("discardJob removes a queued job", async () => {
    const r = await enqueue("default", null);
    const ok = await discardJob(r.jobId);
    expect(ok).toBe(true);
    expect(await getJob(r.jobId)).toBeUndefined();
  });

  it("discardJob refuses to delete running jobs", async () => {
    const r = await enqueue("default", null);
    await getDb().update(jobsLog).set({ status: "running" }).where(eq(jobsLog.id, r.jobId));
    const ok = await discardJob(r.jobId);
    expect(ok).toBe(false);
    expect(await getJob(r.jobId)).toBeDefined();
  });

  it("listJobsLog filters by queue and status", async () => {
    await enqueue("a", null);
    await enqueue("b", null);
    const r = await enqueue("a", null);
    await getDb().update(jobsLog).set({ status: "dead" }).where(eq(jobsLog.id, r.jobId));
    const aQueued = await listJobsLog({ queue: "a", status: "queued" });
    expect(aQueued.data).toHaveLength(1);
    const aDead = await listJobsLog({ queue: "a", status: "dead" });
    expect(aDead.data).toHaveLength(1);
  });

  it("queueStats counts per status across queues", async () => {
    await insertWorker({ queue: "z1", code: `return null;` });
    await insertWorker({ queue: "z2", code: `return null;` });
    const j1 = await enqueue("z1", null);
    await enqueue("z1", null);
    await enqueue("z2", null);
    await getDb().update(jobsLog).set({ status: "dead" }).where(eq(jobsLog.id, j1.jobId));
    const stats = await queueStats();
    const z1 = stats.find((s) => s.queue === "z1");
    const z2 = stats.find((s) => s.queue === "z2");
    expect(z1).toBeDefined();
    expect(z1?.queued).toBe(1);
    expect(z1?.dead).toBe(1);
    expect(z2?.queued).toBe(1);
  });

  it("claim is exclusive — only one tick processes a queued job", async () => {
    // Insert two workers on the same queue; first wins per tick. Set high
    // concurrency so neither blocks. The job should still complete exactly once.
    await insertWorker({ queue: "race", concurrency: 4, code: `return ctx.payload;` });
    await insertWorker({ queue: "race", concurrency: 4, code: `return ctx.payload;` });
    const r = await enqueue("race", { v: 1 });
    startQueueScheduler();
    await waitForStatus(r.jobId, "succeeded");
    const all = await getDb().select().from(jobsLog);
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe("succeeded");
  });

  it("helpers.enqueue chains jobs", async () => {
    await insertWorker({
      queue: "chain-a",
      code: `await ctx.helpers.enqueue("chain-b", { from: "a" });`,
    });
    await insertWorker({
      queue: "chain-b",
      code: `return ctx.payload;`,
    });
    const r = await enqueue("chain-a", null);
    startQueueScheduler();
    await waitForStatus(r.jobId, "succeeded");
    // Wait for the chain-b job to appear and succeed.
    await sleep(800);
    const bJobs = await listJobsLog({ queue: "chain-b" });
    expect(bJobs.data.length).toBeGreaterThanOrEqual(1);
    const bSucceeded = bJobs.data.some((j) => j.status === "succeeded");
    expect(bSucceeded).toBe(true);
  });
});
