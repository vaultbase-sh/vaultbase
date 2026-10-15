import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { pruneHistory, RETENTION_DAYS } from "../core/maintenance.ts";
import { setSetting, validateRetentionDays } from "../api/settings.ts";
import { queueStats } from "../core/queues.ts";

// vaultbase_jobs_log, vaultbase_webhook_deliveries, vaultbase_token_revocations
// and vaultbase_auth_tokens grew forever; queueStats loaded the whole jobs log
// into memory on every dashboard load.

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);
const count = async (table: string) =>
  (await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))!.n;

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

async function job(id: string, queue: string, status: string, finishedAgoDays: number | null) {
  const t = now();
  await db.run(
    `INSERT INTO vaultbase_jobs_log (id, queue, status, payload, scheduled_at, enqueued_at, finished_at) VALUES (?, ?, ?, '{}', ?, ?, ?)`,
    [id, queue, status, t, t, finishedAgoDays === null ? null : t - finishedAgoDays * DAY],
  );
}

describe("pruneHistory", () => {
  it("drops finished jobs past retention, keeps recent and unfinished ones", async () => {
    await job("old-ok", "q", "succeeded", RETENTION_DAYS + 1);
    await job("old-dead", "q", "dead", RETENTION_DAYS + 1);
    await job("new-ok", "q", "succeeded", 1);
    await job("queued", "q", "queued", null);
    await pruneHistory();
    const ids = (await db.all<{ id: string }>(`SELECT id FROM vaultbase_jobs_log ORDER BY id`)).map((r) => r.id);
    expect(ids).toEqual(["new-ok", "queued"]);
  });

  it("drops finished webhook deliveries past retention, keeps pending ones", async () => {
    const t = now();
    const ins =
      `INSERT INTO vaultbase_webhook_deliveries (id, webhook_id, event, payload, attempt, status, scheduled_at, created_at) VALUES (?, 'w', 'e', '{}', 1, ?, ?, ?)`;
    await db.run(ins, ["old-ok", "succeeded", t, t - (RETENTION_DAYS + 1) * DAY]);
    await db.run(ins, ["old-pending", "pending", t, t - (RETENTION_DAYS + 1) * DAY]);
    await db.run(ins, ["new-ok", "succeeded", t, t - DAY]);
    await pruneHistory();
    expect(await count("vaultbase_webhook_deliveries")).toBe(2);
  });

  it("drops revocations and one-time auth tokens that have expired", async () => {
    const t = now();
    await db.run(`INSERT INTO vaultbase_token_revocations (jti, expires_at) VALUES ('gone', ?), ('live', ?)`, [t - 2 * DAY, t + DAY]);
    await db.run(
      `INSERT INTO vaultbase_auth_tokens (id, user_id, collection_id, purpose, expires_at) VALUES ('gone', 'u', 'c', 'reset', ?), ('live', 'u', 'c', 'reset', ?)`,
      [t - 2 * DAY, t + 3600],
    );
    await pruneHistory();
    expect(await count("vaultbase_token_revocations")).toBe(1);
    expect(await count("vaultbase_auth_tokens")).toBe(1);
  });
});

describe("retention setting", () => {
  it("maintenance.retention_days changes the window", async () => {
    setSetting("maintenance.retention_days", "7");
    await job("8-days", "q", "succeeded", 8);
    await job("6-days", "q", "succeeded", 6);
    await pruneHistory();
    const ids = (await db.all<{ id: string }>(`SELECT id FROM vaultbase_jobs_log`)).map((r) => r.id);
    expect(ids).toEqual(["6-days"]);
  });

  it("0 keeps job and delivery history forever, still drops expired tokens", async () => {
    setSetting("maintenance.retention_days", "0");
    await job("ancient", "q", "succeeded", 3650);
    const t = now();
    await db.run(`INSERT INTO vaultbase_token_revocations (jti, expires_at) VALUES ('gone', ?)`, [t - 2 * DAY]);
    await pruneHistory();
    expect(await count("vaultbase_jobs_log")).toBe(1);
    expect(await count("vaultbase_token_revocations")).toBe(0);
  });

  it("validator accepts 0–3650 whole days only", () => {
    expect(validateRetentionDays("0")).toBeNull();
    expect(validateRetentionDays("30")).toBeNull();
    expect(validateRetentionDays("3650")).toBeNull();
    expect(validateRetentionDays("-1")).not.toBeNull();
    expect(validateRetentionDays("3651")).not.toBeNull();
    expect(validateRetentionDays("1.5")).not.toBeNull();
    expect(validateRetentionDays("abc")).not.toBeNull();
  });
});

describe("queueStats", () => {
  it("counts per queue and status", async () => {
    await job("a", "emails", "queued", null);
    await job("b", "emails", "succeeded", 1);
    await job("c", "emails", "dead", 1);
    await job("d", "thumbs", "running", null);
    const stats = await queueStats();
    expect(stats.map((s) => [s.queue, s.queued, s.running, s.succeeded, s.failed, s.dead])).toEqual([
      ["emails", 1, 0, 1, 0, 1],
      ["thumbs", 0, 1, 0, 0, 0],
    ]);
  });

  it("scopes the *_window counters to the window, leaving all-time counts alone", async () => {
    await job("recent-ok",  "emails", "succeeded", 1);   // finished 1d ago
    await job("old-ok",     "emails", "succeeded", 10);  // finished 10d ago
    await job("recent-dead", "emails", "dead", 1);
    await job("old-dead",    "emails", "dead", 10);

    const wide = (await queueStats(30 * DAY))[0]!;
    expect(wide.succeeded).toBe(2);
    expect(wide.succeeded_window).toBe(2);
    expect(wide.dead_window).toBe(2);

    const narrow = (await queueStats(2 * DAY))[0]!;
    expect(narrow.succeeded).toBe(2);          // all-time is unchanged
    expect(narrow.succeeded_window).toBe(1);   // only the 1d-old job
    expect(narrow.dead_window).toBe(1);
  });

  it("reports the oldest still-queued job, and null when the queue is idle", async () => {
    const t = now();
    await db.run(
      `INSERT INTO vaultbase_jobs_log (id, queue, status, payload, scheduled_at, enqueued_at) VALUES (?, ?, 'queued', '{}', ?, ?)`,
      ["older", "emails", t, t - 600],
    );
    await db.run(
      `INSERT INTO vaultbase_jobs_log (id, queue, status, payload, scheduled_at, enqueued_at) VALUES (?, ?, 'queued', '{}', ?, ?)`,
      ["newer", "emails", t, t - 60],
    );
    await job("done", "thumbs", "succeeded", 1);

    const byQueue = Object.fromEntries((await queueStats()).map((s) => [s.queue, s]));
    expect(byQueue["emails"]!.oldest_queued_at).toBe(t - 600);
    expect(byQueue["thumbs"]!.oldest_queued_at).toBeNull();
  });
});
