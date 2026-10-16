/**
 * A transaction that awaits between its statements owns the shared SQLite
 * connection while it runs. Writes from other requests used to land inside
 * it: lost when it rolled back (a sign-out, a record the client was told
 * was saved), and a hook's transaction inside a record write was committed
 * half-way by the write group, after which it could no longer roll back.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, initDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { createRecord, listRecords } from "../core/records.ts";
import { withSharedWrite } from "../core/write-gate.ts";
import { groupCommitOpen } from "../core/group-commit.ts";
import { makeHookHelpers } from "../core/hooks.ts";
import { createPublicCollection, onSqlite } from "./_helpers.ts";

const put = (key: string) => db.run(`INSERT INTO vaultbase_settings (key, value, updated_at) VALUES (?, 'v', 0)`, [key]);
const keys = async () => (await db.all<{ key: string }>(`SELECT key FROM vaultbase_settings WHERE key LIKE 't.%' ORDER BY key`)).map((r) => r.key);

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  await createPublicCollection({ name: "notes", fields: JSON.stringify([{ name: "t", type: "text" }]) });
});
afterEach(async () => {
  _resetCollectionCache();
  await closeDb();
});

describe("a transaction that awaits", () => {
  it("keeps other requests' writes out of its rollback", async () => {
    let started!: () => void;
    const inside = new Promise<void>((r) => { started = r; });
    const tx = db.transaction(async () => {
      await put("t.mine");
      started();
      await Bun.sleep(20);
      throw new Error("undo");
    });
    await inside;
    // Another request writes while the transaction is open.
    const other = put("t.other");
    const record = createRecord("notes", { t: "saved" });
    await expect(tx).rejects.toThrow("undo");
    await other;
    await record;
    expect(await keys()).toEqual(["t.other"]);
    expect((await listRecords("notes")).data.map((r) => r["t"])).toEqual(["saved"]);
  });

  it("through helpers.sql, from a hook outside any record write", async () => {
    const helpers = makeHookHelpers();
    let started!: () => void;
    const inside = new Promise<void>((r) => { started = r; });
    const tx = helpers.sql.transaction(async () => {
      await helpers.sql.exec(`INSERT INTO vaultbase_settings (key, value, updated_at) VALUES ('t.hook', 'v', 0)`);
      started();
      await Bun.sleep(20);
      throw new Error("undo");
    });
    await inside;
    const record = createRecord("notes", { t: "saved" });
    await expect(tx).rejects.toThrow("undo");
    await record;
    expect(await keys()).toEqual([]);
    expect((await listRecords("notes")).data.length).toBe(1);
  });
});

describe.skipIf(!onSqlite)("a hook's transaction inside a record write", () => {
  it("rolls back only its own writes, though the write group commits around it", async () => {
    let started!: () => void;
    const inside = new Promise<void>((r) => { started = r; });
    // As a beforeCreate hook runs: inside the record write's shared gate.
    const hook = withSharedWrite(async () => {
      expect(groupCommitOpen()).toBe(true);
      await db.transaction(async () => {
        await put("t.hook");
        started();
        await Bun.sleep(20); // the group's end-of-turn commit comes due here
        throw new Error("undo");
      }).catch(() => { /* the hook handles it */ });
    });
    await inside;
    const record = createRecord("notes", { t: "saved" });
    await hook;
    await record;
    expect(await keys()).toEqual([]);
    expect((await listRecords("notes")).data.length).toBe(1);
  });

  it("commits with the group when it succeeds", async () => {
    await withSharedWrite(async () => {
      await db.transaction(async () => {
        await put("t.a");
        await Bun.sleep(5);
        await put("t.b");
      });
    });
    expect(await keys()).toEqual(["t.a", "t.b"]);
  });
});
