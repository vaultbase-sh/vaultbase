import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { pruneHistory, RETENTION_DAYS } from "../core/maintenance.ts";
import { queueStats } from "../core/queues.ts";

// vaultbase_jobs_log, vaultbase_webhook_deliveries, vaultbase_token_revocations
// and vaultbase_auth_tokens grew forever; queueStats loaded the whole jobs log
// into memory on every dashboard load.

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);
const count = (table: string) =>
  (getRawClient().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

function job(id: string, queue: string, status: string, finishedAgoDays: number | null) {
  const t = now();
  getRawClient().prepare(
    `INSERT INTO vaultbase_jobs_log (id, queue, status, payload, scheduled_at, enqueued_at, finished_at) VALUES (?, ?, ?, '{}', ?, ?, ?)`,
  ).run(id, queue, status, t, t, finishedAgoDays === null ? null : t - finishedAgoDays * DAY);
}

describe("pruneHistory", () => {
  it("drops finished jobs past retention, keeps recent and unfinished ones", async () => {
    job("old-ok", "q", "succeeded", RETENTION_DAYS + 1);
    job("old-dead", "q", "dead", RETENTION_DAYS + 1);
    job("new-ok", "q", "succeeded", 1);
    job("queued", "q", "queued", null);
    await pruneHistory();
    const ids = (getRawClient().prepare(`SELECT id FROM vaultbase_jobs_log ORDER BY id`).all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(["new-ok", "queued"]);
  });

  it("drops finished webhook deliveries past retention, keeps pending ones", async () => {
    const t = now();
    const ins = getRawClient().prepare(
      `INSERT INTO vaultbase_webhook_deliveries (id, webhook_id, event, payload, attempt, status, scheduled_at, created_at) VALUES (?, 'w', 'e', '{}', 1, ?, ?, ?)`,
    );
    ins.run("old-ok", "succeeded", t, t - (RETENTION_DAYS + 1) * DAY);
    ins.run("old-pending", "pending", t, t - (RETENTION_DAYS + 1) * DAY);
    ins.run("new-ok", "succeeded", t, t - DAY);
    await pruneHistory();
    expect(count("vaultbase_webhook_deliveries")).toBe(2);
  });

  it("drops revocations and one-time auth tokens that have expired", async () => {
    const t = now();
    getRawClient().prepare(`INSERT INTO vaultbase_token_revocations (jti, expires_at) VALUES ('gone', ?), ('live', ?)`)
      .run(t - 2 * DAY, t + DAY);
    getRawClient().prepare(
      `INSERT INTO vaultbase_auth_tokens (id, user_id, collection_id, purpose, expires_at) VALUES ('gone', 'u', 'c', 'reset', ?), ('live', 'u', 'c', 'reset', ?)`,
    ).run(t - 2 * DAY, t + 3600);
    await pruneHistory();
    expect(count("vaultbase_token_revocations")).toBe(1);
    expect(count("vaultbase_auth_tokens")).toBe(1);
  });
});

describe("queueStats", () => {
  it("counts per queue and status", async () => {
    job("a", "emails", "queued", null);
    job("b", "emails", "succeeded", 1);
    job("c", "emails", "dead", 1);
    job("d", "thumbs", "running", null);
    const stats = await queueStats();
    expect(stats).toEqual([
      { queue: "emails", queued: 1, running: 0, succeeded: 1, failed: 0, dead: 1 },
      { queue: "thumbs", queued: 0, running: 1, succeeded: 0, failed: 0, dead: 0 },
    ]);
  });
});
