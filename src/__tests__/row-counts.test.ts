/**
 * Stored row counts (core/row-counts.ts): an unfiltered list's total is read
 * from a count the table's triggers keep, and must always equal COUNT(*),
 * whatever wrote the rows. Where the count can't be trusted (triggers
 * missing or named for another table) lists count as before.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, closeDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createRecord, deleteRecord, listRecords } from "../core/records.ts";
import { deleteCollection, getCollection, updateCollection } from "../core/collections.ts";
import { storedRowCount } from "../core/row-counts.ts";
import { onSqlite, createPublicCollection } from "./_helpers.ts";

const fields = JSON.stringify([{ name: "n", type: "number" }]);
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "vb-rowcount-"));
  await initDb(`file:${join(dir, "data.db")}`);
  await runMigrations();
});

afterEach(async () => {
  await closeDb();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: cached statements hold the file */ }
});

const total = async (name: string, filter?: string) =>
  (await listRecords(name, { perPage: 1, ...(filter ? { filter } : {}) })).totalItems;
const counted = (table: string) => (getRawClient().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
const triggers = (table: string) =>
  (getRawClient().prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND name LIKE 'vb_rowcount_%' ORDER BY name`).all(table) as Array<{ name: string }>).map((r) => r.name);

describe.skipIf(!onSqlite)("stored row counts", () => {
  it("an unfiltered total is the stored count and follows every kind of write", async () => {
    await createPublicCollection({ name: "items", fields });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await createRecord("items", { n: i })).id);
    expect(await storedRowCount("vb_items")).toBe(5);
    expect(await total("items")).toBe(5);

    await deleteRecord("items", ids[0]!);
    const raw = getRawClient();
    raw.exec(`INSERT INTO vb_items ("id", "n", "created_at", "updated_at") VALUES ('raw1', 9, 1, 1), ('raw2', 9, 1, 1)`);
    raw.exec(`DELETE FROM vb_items WHERE id = 'raw1'`);
    expect(await total("items")).toBe(5);
    expect(await total("items")).toBe(counted("vb_items"));

    // A DELETE with no WHERE is SQLite's truncate shortcut unless a trigger
    // is on the table; the count must still reach zero.
    raw.exec(`DELETE FROM vb_items`);
    expect(await total("items")).toBe(0);
  });

  it("a rolled-back write leaves the count as it was", async () => {
    await createPublicCollection({ name: "items", fields });
    await createRecord("items", { n: 1 });
    const raw = getRawClient();
    raw.exec("BEGIN");
    raw.exec(`INSERT INTO vb_items ("id", "n", "created_at", "updated_at") VALUES ('gone', 1, 1, 1)`);
    raw.exec("ROLLBACK");
    expect(await total("items")).toBe(1);
  });

  it("a filtered total still counts the matching rows", async () => {
    await createPublicCollection({ name: "items", fields });
    for (let i = 0; i < 6; i++) await createRecord("items", { n: i });
    expect(await total("items", "n >= 4")).toBe(2);
  });

  it("a renamed collection keeps an exact count, and a new one under the old name starts at zero", async () => {
    await createPublicCollection({ name: "items", fields });
    for (let i = 0; i < 3; i++) await createRecord("items", { n: i });
    const col = (await getCollection("items"))!;
    await updateCollection(col.id, { name: "things" });
    expect(triggers("vb_things")).toEqual(["vb_rowcount_del_vb_things", "vb_rowcount_ins_vb_things"]);
    expect(await total("things")).toBe(3);

    // The old triggers named the old table inside their body; had they
    // stayed, writes to `things` would move the new `items` count.
    await createPublicCollection({ name: "items", fields });
    await createRecord("things", { n: 9 });
    expect(await total("items")).toBe(0);
    expect(await total("things")).toBe(4);
  });

  it("a table without its triggers is counted, and the next start gives them back with the right count", async () => {
    await createPublicCollection({ name: "items", fields });
    for (let i = 0; i < 4; i++) await createRecord("items", { n: i });
    const raw = getRawClient();
    raw.exec(`DROP TRIGGER vb_rowcount_ins_vb_items`);
    raw.exec(`INSERT INTO vb_items ("id", "n", "created_at", "updated_at") VALUES ('untracked', 1, 1, 1)`);
    expect(await storedRowCount("vb_items")).toBeNull();
    expect(await total("items")).toBe(5);

    await runMigrations();
    expect(await storedRowCount("vb_items")).toBe(5);
    await createRecord("items", { n: 7 });
    expect(await total("items")).toBe(6);
  });

  it("deleting a collection forgets its count", async () => {
    await createPublicCollection({ name: "items", fields });
    await createRecord("items", { n: 1 });
    await deleteCollection("items");
    const row = getRawClient().prepare(`SELECT 1 FROM vaultbase_row_counts WHERE table_name = 'vb_items'`).get();
    expect(row).toBeNull();
  });
});
