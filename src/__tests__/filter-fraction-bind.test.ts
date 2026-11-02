/**
 * A number that isn't a whole one in bigint's range (1.5, 1e20) compared
 * with an integer column. Postgres read the bound value as the column's
 * type and failed the query (`invalid input syntax for type bigint`);
 * SQLite answered. Both answer the same now.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { listRecords, createRecord } from "../core/records.ts";
import { createPublicCollection } from "./_helpers.ts";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  await createPublicCollection({
    name: "items",
    fields: JSON.stringify([
      { name: "day", type: "date" },
      { name: "on", type: "bool" },
      { name: "sku", type: "text" },
      { name: "qty", type: "number" },
    ]),
  });
  await createPublicCollection({ name: "parts", fields: JSON.stringify([{ name: "item", type: "relation", collection: "items" }]) });
});

afterEach(async () => {
  _resetCollectionCache();
  await closeDb();
});

const count = async (filter: string, body?: Record<string, unknown>) =>
  (await listRecords("items", { filter, ...(body ? { request: { method: "GET", headers: {}, query: {}, body } } : {}) })).data.length;

describe("fractions against integer columns", () => {
  it("compare as numbers, on either side", async () => {
    const a = await createRecord("items", { day: "2026-01-01T00:00:00Z", on: true, sku: "1.5", qty: 2 });
    await createRecord("parts", { item: a.id });
    await createRecord("parts", { item: a.id });
    expect(await count("created > 1.5")).toBe(1);
    expect(await count("1.5 < created")).toBe(1);
    expect(await count("created < 1.5")).toBe(0);
    expect(await count("day > 1.5")).toBe(1);
    expect(await count("day < 99999999999999999999")).toBe(1);
    expect(await count("on > 0.5")).toBe(1);
    expect(await count("on = 0.5")).toBe(0);
    expect(await count("on != 0.5")).toBe(1);
    expect(await count("sku:length > 2.5")).toBe(1);
    expect(await count("parts_via_item:length > 1.5")).toBe(1);
    expect(await count("parts_via_item:length > 2.5")).toBe(0);
    expect(await count("qty > 1.5")).toBe(1);
  });

  it("compare a text field as text, as before", async () => {
    await createRecord("items", { sku: "1.5" });
    expect(await count("sku = 1.5")).toBe(1);
    expect(await count("sku != 1.5")).toBe(0);
  });

  it("take a fraction from the request too", async () => {
    await createRecord("items", { on: true });
    expect(await count("on > @request.body.min", { min: 0.5 })).toBe(1);
    expect(await count("created > @request.body.min", { min: 1.5 })).toBe(1);
  });
});
