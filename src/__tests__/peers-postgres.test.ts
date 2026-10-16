/**
 * Servers sharing one Postgres database: changes travel between them over
 * LISTEN/NOTIFY (core/peers.ts), statements survive a schema change made
 * elsewhere, and servers booting together migrate one at a time.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { closeDb, initDb } from "../db/client.ts";
import { db, getDriver } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { PostgresDriver } from "../db/postgres.ts";
import {
  _peersIdle, announceInvalidation, onPeerInvalidation, onPeerMessage, sendToPeers, startPeers, stopPeers, withSlim,
} from "../core/peers.ts";
import { onSqlite } from "./_helpers.ts";

const PG = process.env["VAULTBASE_TEST_DB"] ?? "";

/** A second connection to the same schema: the other server. */
async function otherServer(): Promise<{ sql: SQL; channel: string; heard: Array<{ from: string; m: Array<Record<string, unknown>> }>; stop: () => Promise<void> }> {
  const schema = (await db.get<{ s: string }>(`SELECT current_schema() AS s`))!.s;
  const sql = new SQL(`${PG}${PG.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`, { max: 1 });
  const channel = `vaultbase_${schema}`.slice(0, 63);
  const heard: Array<{ from: string; m: Array<Record<string, unknown>> }> = [];
  const sub = await sql.listen(channel, (p) => heard.push(JSON.parse(p)));
  return { sql, channel, heard, stop: async () => { await sub.unlisten(); await sql.close(); } };
}

const settle = () => Bun.sleep(150);

describe.skipIf(onSqlite)("peers", () => {
  beforeEach(async () => {
    await initDb(":memory:");
    await runMigrations();
    await startPeers(getDriver() as unknown as Parameters<typeof startPeers>[0]);
  });
  afterEach(async () => {
    await stopPeers();
    await closeDb();
  });

  it("acts on another server's message without echoing it back", async () => {
    const other = await otherServer();
    try {
      let dropped = 0;
      // An invalidator announces, as the real ones do; relayed, it must not.
      const invalidate = () => { dropped++; announceInvalidation("peer-test"); };
      onPeerInvalidation("peer-test", invalidate);
      await other.sql.notify(other.channel, JSON.stringify({ from: "other-server", m: [{ k: "cache:peer-test" }] }));
      await settle();
      await _peersIdle();
      expect(dropped).toBe(1);
      expect(other.heard.filter((h) => h.from !== "other-server")).toEqual([]);
    } finally {
      await other.stop();
    }
  });

  it("tells other servers, batching what is sent outside a transaction", async () => {
    const other = await otherServer();
    try {
      announceInvalidation("a");
      announceInvalidation("b");
      await settle();
      const mine = other.heard.filter((h) => h.from !== "other-server");
      expect(mine.length).toBe(1);
      expect(mine[0]!.m.map((m) => m.k)).toEqual(["cache:a", "cache:b"]);
    } finally {
      await other.stop();
    }
  });

  it("sends from inside a transaction only once it commits", async () => {
    const other = await otherServer();
    try {
      await db.transaction(async () => { sendToPeers({ k: "kept" }); }).catch(() => {});
      await expect(db.transaction(async () => { sendToPeers({ k: "rolled-back" }); throw new Error("undo"); })).rejects.toThrow("undo");
      await settle();
      expect(other.heard.flatMap((h) => h.m.map((m) => m.k))).toEqual(["kept"]);
    } finally {
      await other.stop();
    }
  });

  it("sends the slim form of a message too large for one NOTIFY", async () => {
    const other = await otherServer();
    try {
      sendToPeers(withSlim({ k: "rec", id: "r1", r: { body: "x".repeat(20_000) } }, { k: "rec", id: "r1" }));
      await settle();
      expect(other.heard.flatMap((h) => h.m)).toEqual([{ k: "rec", id: "r1" }]);
    } finally {
      await other.stop();
    }
  });

  it("runs every resettable handler after the listening connection comes back", async () => {
    let resets = 0;
    onPeerMessage("peer-reset-test", () => { resets++; }, { reset: true });
    // Drop the listener's connection from the server side; Bun.sql reconnects.
    await db.run(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query ILIKE 'LISTEN%' AND pid <> pg_backend_pid() AND datname = current_database()`);
    const t0 = Date.now();
    while (resets === 0 && Date.now() - t0 < 5000) await Bun.sleep(50);
    await _peersIdle();
    expect(resets).toBeGreaterThan(0);
  });
});

describe.skipIf(onSqlite)("statements across a schema change made elsewhere", () => {
  beforeEach(async () => { await initDb(":memory:"); await runMigrations(); });
  afterEach(async () => { await closeDb(); });

  it("keep working once another connection adds a column", async () => {
    await db.exec(`CREATE TABLE plan_t (id text, x integer)`);
    await db.run(`INSERT INTO plan_t VALUES ('1', 1)`);
    // Prepare it on every pooled connection.
    await Promise.all(Array.from({ length: 8 }, () => db.all(`SELECT * FROM plan_t WHERE id = ?`, ["1"])));
    const other = await otherServer();
    try {
      await other.sql.unsafe(`ALTER TABLE plan_t ADD COLUMN y text`).simple();
    } finally {
      await other.stop();
    }
    const rows = await Promise.all(Array.from({ length: 8 }, () => db.all(`SELECT * FROM plan_t WHERE id = ?`, ["1"])));
    for (const r of rows) expect(r).toEqual([{ id: "1", x: 1, y: null }]);
  });
});

describe.skipIf(onSqlite)("migration lock", () => {
  beforeEach(async () => { await initDb(":memory:"); await runMigrations(); });
  afterEach(async () => { await closeDb(); });

  it("lets one server migrate a schema at a time", async () => {
    const schema = (await db.get<{ s: string }>(`SELECT current_schema() AS s`))!.s;
    const url = `${PG}${PG.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
    const a = new PostgresDriver(url), b = new PostgresDriver(url);
    try {
      let inside = 0, overlap = false;
      const work = async () => { inside++; if (inside > 1) overlap = true; await Bun.sleep(100); inside--; };
      await Promise.all([a.withMigrationLock(work), b.withMigrationLock(work)]);
      expect(overlap).toBe(false);
    } finally {
      a.close();
      b.close();
    }
  });
});
