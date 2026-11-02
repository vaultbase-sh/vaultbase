/**
 * `~` on a field that isn't text: Postgres has no ILIKE for numbers, dates or
 * bools, so the query failed there while SQLite matched. Runs on both.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { createRecord, listRecords } from "../core/records.ts";
import { createPublicCollection } from "./_helpers.ts";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  await createPublicCollection({ name: "items", fields: JSON.stringify([
    { name: "price", type: "number" }, { name: "active", type: "bool" }, { name: "label", type: "text" },
  ]) });
  await createRecord("items", { price: 10, active: true, label: "Ten" }, null);
  await createRecord("items", { price: 25, active: false, label: "twenty-five" }, null);
});
afterEach(async () => { _resetCollectionCache(); await closeDb(); });

const count = async (filter: string) => (await listRecords("items", { filter })).data.length;

describe("~ on non-text fields", () => {
  it("matches a number field as its text", async () => {
    expect(await count('price ~ "1"')).toBe(1);
    expect(await count('price !~ "1"')).toBe(1);
  });

  it("text matching still ignores case (legitimate path)", async () => {
    expect(await count('label ~ "ten"')).toBe(1);
  });
});

describe("created / updated on another collection", () => {
  it("@collection.x.created reads created_at, as it does on the host", async () => {
    await createPublicCollection({ name: "notes", fields: JSON.stringify([{ name: "body", type: "text" }]) });
    await createRecord("notes", { body: "n" }, null);
    expect(await count("@collection.notes.created > 0")).toBe(2);
  });
});
