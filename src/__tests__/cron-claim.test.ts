import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { jobs } from "../db/schema.ts";
import { _jobsTickOnce } from "../core/jobs.ts";

// The scheduler started any job whose next_run_at had passed, but only moved
// next_run_at forward after the job finished. A job slower than the 30 s tick
// was started again by the next tick, and under `vaultbase cluster` every
// worker's scheduler ran the same slot.

const g = globalThis as unknown as { __cronHits?: number };

beforeEach(async () => {
  g.__cronHits = 0;
  await initDb(":memory:");
  await runMigrations();
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(jobs).values({
    id: "job1", name: "slow", cron: "* * * * *", enabled: 1, mode: "inline",
    code: "globalThis.__cronHits = (globalThis.__cronHits ?? 0) + 1; await new Promise((r) => setTimeout(r, 300));",
    next_run_at: now - 1, created_at: now, updated_at: now,
  });
});

afterEach(() => closeDb());

describe("cron scheduler claims each slot once", () => {
  it("overlapping ticks run a due job exactly once", async () => {
    // Two schedulers (overlapping ticks, or two cluster workers) see the same due slot.
    await Promise.all([_jobsTickOnce(), _jobsTickOnce()]);
    expect(g.__cronHits).toBe(1);
  });

  it("the claimed slot moves next_run_at into the future", async () => {
    // Compare with the time of the claim, not after the 300 ms run: a tick just
    // before a minute boundary finishes on it, and the next slot is that boundary.
    const claimedAt = Math.floor(Date.now() / 1000);
    await _jobsTickOnce();
    const row = (await getDb().select().from(jobs).where(eq(jobs.id, "job1")))[0]!;
    expect(row.next_run_at!).toBeGreaterThan(claimedAt);
    expect(row.last_status).toBe("ok");
  });
});
