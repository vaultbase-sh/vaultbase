/**
 * A unique key allows one queued-or-running job, enforced by the database:
 * the check-then-insert let concurrent enqueues through (10 at once made 10
 * jobs). Duplicates left by older versions are cleared at startup so the
 * index can be created.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { ensureFixedSchema } from "../db/ddl.ts";
import { jobsLog } from "../db/schema.ts";
import { enqueue, retryJob, JobKeyActiveError } from "../core/queues.ts";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
});

afterEach(async () => { await closeDb(); });

const activeWithKey = async (key: string) =>
  (await getDb().select().from(jobsLog).where(eq(jobsLog.unique_key, key)))
    .filter((j) => j.status === "queued" || j.status === "running");

describe("unique keys", () => {
  it("concurrent enqueues with one key make one job", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => enqueue("mail", { n: 1 }, { uniqueKey: "welcome:u1" })));
    expect(new Set(results.map((r) => r.jobId)).size).toBe(1);
    expect(results.filter((r) => !r.deduped)).toHaveLength(1);
    expect(await activeWithKey("welcome:u1")).toHaveLength(1);
  });

  it("are global across queues", async () => {
    const a = await enqueue("a", null, { uniqueKey: "k" });
    const b = await enqueue("b", null, { uniqueKey: "k" });
    expect(b).toEqual({ jobId: a.jobId, deduped: true });
  });

  it("allow a new job once the previous one finished", async () => {
    const a = await enqueue("mail", null, { uniqueKey: "k" });
    await getDb().update(jobsLog).set({ status: "succeeded" }).where(eq(jobsLog.id, a.jobId));
    const b = await enqueue("mail", null, { uniqueKey: "k" });
    expect(b.deduped).toBe(false);
    expect(b.jobId).not.toBe(a.jobId);
  });

  it("refuse a retry while another job with the key is active", async () => {
    const a = await enqueue("mail", null, { uniqueKey: "k" });
    await getDb().update(jobsLog).set({ status: "dead" }).where(eq(jobsLog.id, a.jobId));
    const b = await enqueue("mail", null, { uniqueKey: "k" });
    await expect(retryJob(a.jobId)).rejects.toBeInstanceOf(JobKeyActiveError);
    await getDb().update(jobsLog).set({ status: "succeeded" }).where(eq(jobsLog.id, b.jobId));
    expect(await retryJob(a.jobId)).toBe(true);
  });

  it("jobs without a key are never deduplicated", async () => {
    const a = await enqueue("mail", null);
    const b = await enqueue("mail", null);
    expect(a.jobId).not.toBe(b.jobId);
  });

  it("startup clears duplicates left by older versions, keeping the running one", async () => {
    await db.exec(`DROP INDEX idx_vaultbase_jobs_log_unique_active`);
    const row = (id: string, status: string, enqueued_at: number) => ({
      id, queue: "q", payload: "null", unique_key: "dup", attempt: 1, status, scheduled_at: 0, enqueued_at,
    });
    await getDb().insert(jobsLog).values([row("j1", "queued", 1), row("j2", "running", 2), row("j3", "queued", 3)]);
    await ensureFixedSchema();
    const active = await activeWithKey("dup");
    expect(active.map((j) => j.id)).toEqual(["j2"]);
    // The others keep running, just without the key.
    const all = await getDb().select().from(jobsLog);
    expect(all.filter((j) => j.status === "queued")).toHaveLength(2);
    expect((await enqueue("q", null, { uniqueKey: "dup" })).deduped).toBe(true);
  });
});
