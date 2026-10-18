/**
 * Peer messages measured in characters: a record in Chinese passed the
 * 7,500 check but was ~3x that in bytes, NOTIFY refused it, and every
 * message packed with it (a rule change included) was lost until a restart.
 * Now sizes are bytes, record events never share a NOTIFY with an
 * invalidation, and a sequence polled by every server catches one lost anyway.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { closeDb, initDb } from "../db/client.ts";
import { db, getDriver } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import {
  _pollPeerGeneration, announceInvalidation, onPeerInvalidation, sendToPeers, startPeers, stopPeers, withSlim,
} from "../core/peers.ts";
import { onSqlite } from "./_helpers.ts";

const PG = process.env["VAULTBASE_TEST_DB"] ?? "";

async function otherServer() {
  const schema = (await db.get<{ s: string }>(`SELECT current_schema() AS s`))!.s;
  const sql = new SQL(`${PG}${PG.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`, { max: 1 });
  const channel = `vaultbase_${schema}`.slice(0, 63);
  const heard: Array<{ from: string; m: Array<Record<string, unknown>> }> = [];
  const sub = await sql.listen(channel, (p) => heard.push(JSON.parse(p)));
  return { sql, heard, stop: async () => { await sub.unlisten(); await sql.close(); } };
}

const settle = () => Bun.sleep(200);

describe.skipIf(onSqlite)("peer message sizes and the generation backstop", () => {
  beforeEach(async () => {
    await initDb(":memory:");
    await runMigrations();
    await startPeers(getDriver() as unknown as Parameters<typeof startPeers>[0]);
  });
  afterEach(async () => {
    await stopPeers();
    await closeDb();
  });

  it("a multibyte record goes slim, and an invalidation sent with it still arrives", async () => {
    const other = await otherServer();
    try {
      const body = "数据".repeat(1_500); // 3,000 characters, ~9,000 bytes
      const slim = { k: "rec", t: "update", c: "posts", id: "r1", src: "api" };
      sendToPeers(withSlim({ ...slim, r: { id: "r1", body } }, slim));
      announceInvalidation("collections");
      await settle();
      const all = other.heard.flatMap((h) => h.m);
      expect(all.find((m) => m["k"] === "cache:collections")).toBeDefined();
      const rec = all.find((m) => m["k"] === "rec")!;
      expect(rec).toBeDefined();
      expect(rec["r"]).toBeUndefined();
      // Never in one NOTIFY together.
      for (const h of other.heard) expect(new Set(h.m.map((m) => m["k"] === "rec")).size).toBe(1);
    } finally {
      await other.stop();
    }
  });

  it("packs by bytes: no NOTIFY over the limit", async () => {
    const other = await otherServer();
    try {
      for (let i = 0; i < 20; i++) {
        const slim = { k: "rec", t: "update", c: "posts", id: `r${i}`, src: "api" };
        sendToPeers(withSlim({ ...slim, r: { id: `r${i}`, body: "é".repeat(600) } }, slim));
      }
      await settle();
      expect(other.heard.flatMap((h) => h.m).filter((m) => m["r"])).toHaveLength(20);
      expect(other.heard.length).toBeGreaterThan(1);
    } finally {
      await other.stop();
    }
  });

  it("resets when another server's invalidation moved the generation and its NOTIFY was lost", async () => {
    let resets = 0;
    onPeerInvalidation("backstop-test", () => { resets++; });
    // Another server bumps the generation; its NOTIFY never arrives.
    const other = new SQL(PG, { max: 1 });
    const schema = (await db.get<{ s: string }>(`SELECT current_schema() AS s`))!.s;
    try {
      await other.unsafe(`SELECT nextval('${schema}.vaultbase_peer_generation')`);
      await _pollPeerGeneration();
      await settle();
      expect(resets).toBeGreaterThan(0);
    } finally {
      await other.close();
    }
  });

  it("doesn't reset for its own invalidations", async () => {
    let resets = 0;
    onPeerInvalidation("backstop-own", () => { resets++; });
    announceInvalidation("hooks");
    await settle();
    await _pollPeerGeneration();
    await settle();
    expect(resets).toBe(0);
  });
});
