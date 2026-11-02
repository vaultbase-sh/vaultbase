/**
 * A setNull cascade read each child record before and after the update: two
 * queries per child, under the write gate. It reads them once now, and the
 * realtime events still carry the records with the field cleared.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { createRecord, deleteRecord, getRecord } from "../core/records.ts";
import { on } from "../core/events.ts";
import { createPublicCollection } from "./_helpers.ts";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  await createPublicCollection({ name: "authors", fields: JSON.stringify([{ name: "name", type: "text" }]) });
  await createPublicCollection({ name: "notes", fields: JSON.stringify([{ name: "title", type: "text" }, { name: "author", type: "relation", collection: "authors", options: { cascade: "setNull" } }]) });
});
afterEach(async () => { _resetCollectionCache(); await closeDb(); });

describe("setNull cascade", () => {
  it("runs a fixed number of statements however many children, and sends the cleared records", async () => {
    const a = await createRecord("authors", { name: "a" }, null);
    for (let i = 0; i < 40; i++) await createRecord("notes", { title: `n${i}`, author: a.id }, null);
    const events: Array<Record<string, unknown>> = [];
    const off = on("record.updated", (e) => { if (e.source === "cascade") events.push(e.record); });
    const statements: string[] = [];
    db.trace((sql) => statements.push(sql));
    try {
      await deleteRecord("authors", a.id, null);
    } finally {
      db.trace(null);
    }
    await Bun.sleep(10);
    off();
    expect(statements.filter((s) => /vb_notes/.test(s)).length).toBeLessThan(10);
    expect(events.length).toBe(40);
    expect(events.every((r) => r["author"] === null || r["author"] === "")).toBe(true);
    const one = await getRecord("notes", String(events[0]!["id"]));
    expect(one!["author"] ?? null).toBeFalsy();
  });
});
