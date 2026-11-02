/**
 * `INSERT OR REPLACE` from raw SQL replaced a row without firing its delete
 * trigger (recursive_triggers was off), so the stored row count grew by one
 * each time and never came back. SQLite only.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { createRecord, listRecords } from "../core/records.ts";
import { createPublicCollection, onSqlite } from "./_helpers.ts";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  await createPublicCollection({ name: "items", fields: JSON.stringify([{ name: "title", type: "text" }]) });
});
afterEach(async () => { _resetCollectionCache(); await closeDb(); });

describe.skipIf(!onSqlite)("row counts after REPLACE", () => {
  it("stay right", async () => {
    const r = await createRecord("items", { title: "a" }, null);
    for (let i = 0; i < 3; i++) await db.run(`INSERT OR REPLACE INTO vb_items (id, title, created_at, updated_at) VALUES (?, ?, 1, 1)`, [r.id, `t${i}`]);
    const res = await listRecords("items", {});
    expect(res.data.length).toBe(1);
    expect(res.totalItems).toBe(1);
  });
});
