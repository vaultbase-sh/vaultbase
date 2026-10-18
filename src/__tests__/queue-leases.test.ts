/**
 * Running jobs are leased. A server starting up (or a sweep on any server
 * sharing the database) used to re-queue jobs another server was still
 * running, and a late finish overwrote whatever a newer attempt recorded.
 * Now only an expired lease is recovered, the running process renews its
 * leases, and only the attempt holding the lease writes its result.
 */
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
  enqueue, invalidateWorkerCache, startQueueScheduler, stopQueueScheduler,
  recoverInterruptedJobs, renewLeases, PROCESS_ID, _setLeaseSeconds,
} from "../core/queues.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-leases-"));
  setLogsDir(tmpDir);
  await initDb(":memory:");
  await runMigrations();
  invalidateWorkerCache();
});

afterEach(async () => {
  stopQueueScheduler();
  _setLeaseSeconds(null);
  delete (globalThis as Record<string, unknown>)["__leaseGate"];
  await closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function insertWorker(queue: string, code: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(workers).values({
    id: crypto.randomUUID(), name: "", queue, code, enabled: 1, concurrency: 1,
    retry_max: 3, retry_backoff: "fixed", retry_delay_ms: 50, created_at: now, updated_at: now,
  });
  invalidateWorkerCache();
}

const job = async (id: string) => (await getDb().select().from(jobsLog).where(eq(jobsLog.id, id)).limit(1))[0]!;

async function waitFor(fn: () => Promise<boolean>, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await Bun.sleep(25); }
  throw new Error("timed out");
}

describe("job leases", () => {
  it("a claimed job carries this process's lease", async () => {
    await insertWorker("q", "await new Promise((r) => { globalThis.__leaseGate = r; });");
    const { jobId } = await enqueue("q", {});
    startQueueScheduler();
    await waitFor(async () => (await job(jobId)).status === "running");
    const j = await job(jobId);
    expect(j.lease_owner).toBe(PROCESS_ID);
    expect(j.lease_until!).toBeGreaterThan(Math.floor(Date.now() / 1000));
    (globalThis as { __leaseGate?: () => void }).__leaseGate?.();
    await waitFor(async () => (await job(jobId)).status === "succeeded");
    expect((await job(jobId)).lease_owner).toBeNull();
  });

  it("a live lease is never taken over, however long the job has run", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { jobId } = await enqueue("q", {});
    await getDb().update(jobsLog).set({ status: "running", started_at: now - 7200, lease_owner: "other-server", lease_until: now + 60 }).where(eq(jobsLog.id, jobId));
    // What a server starting up runs: every running job counts as interrupted by age.
    expect(await recoverInterruptedJobs(now)).toBe(0);
    expect((await job(jobId)).status).toBe("running");
  });

  it("an expired lease is recovered", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { jobId } = await enqueue("q", {});
    await getDb().update(jobsLog).set({ status: "running", started_at: now - 5, lease_owner: "crashed", lease_until: now - 1 }).where(eq(jobsLog.id, jobId));
    expect(await recoverInterruptedJobs(now - 3600)).toBe(1);
    const j = await job(jobId);
    expect(j).toMatchObject({ status: "queued", attempt: 2, lease_owner: null, lease_until: null });
  });

  it("renewal extends only this process's leases", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { jobId: mine } = await enqueue("q", {});
    const { jobId: theirs } = await enqueue("q", {});
    await getDb().update(jobsLog).set({ status: "running", started_at: now, lease_owner: PROCESS_ID, lease_until: now + 1 }).where(eq(jobsLog.id, mine));
    await getDb().update(jobsLog).set({ status: "running", started_at: now, lease_owner: "other", lease_until: now + 1 }).where(eq(jobsLog.id, theirs));
    expect(await renewLeases()).toBe(1);
    expect((await job(mine)).lease_until!).toBeGreaterThanOrEqual(now + 59);
    expect((await job(theirs)).lease_until).toBe(now + 1);
  });

  it("a run that lost its lease doesn't overwrite the newer attempt", async () => {
    _setLeaseSeconds(1);
    await insertWorker("q", "await new Promise((r) => { globalThis.__leaseGate = r; });");
    const { jobId } = await enqueue("q", {});
    startQueueScheduler();
    await waitFor(async () => (await job(jobId)).status === "running");
    // The process stalls past its lease; another server recovers the job.
    await Bun.sleep(2100);
    expect(await recoverInterruptedJobs(0)).toBe(1);
    stopQueueScheduler();
    expect((await job(jobId))).toMatchObject({ status: "queued", attempt: 2 });
    // The stalled first attempt finishes now: its result isn't recorded.
    (globalThis as { __leaseGate?: () => void }).__leaseGate?.();
    await Bun.sleep(200);
    expect((await job(jobId))).toMatchObject({ status: "queued", attempt: 2 });
  });
});
