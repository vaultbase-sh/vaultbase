/**
 * Comparisons answer the same on every database. On Postgres a JSON path
 * read as text compared text with text (`meta.level < 5` held for 10,
 * `meta.banned != true` for a banned user, `meta.on = true` never), a bound
 * number against a text column failed with `text = integer`, array
 * elements compared as text with a number failed the same way, and dates
 * were 32-bit, so a date from 2038 on did not save.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, initDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache, createCollection } from "../core/collections.ts";
import { createRecord, getRecord, listRecords } from "../core/records.ts";
import { createPublicCollection } from "./_helpers.ts";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  await createPublicCollection({
    name: "u",
    fields: JSON.stringify([
      { name: "n", type: "text" },
      { name: "sku", type: "text" },
      { name: "qty", type: "number" },
      { name: "meta", type: "json" },
      { name: "due", type: "date" },
    ]),
  });
  await createRecord("u", { n: "ten", sku: "123", qty: 10, meta: { level: 10, banned: true, score: 2.5, tags: [1, 20], who: { name: "Ann" }, label: "x" } });
  await createRecord("u", { n: "three", sku: "abc", qty: 3, meta: { level: 3, banned: false, score: 10, tags: [3], who: { name: "Bob" }, label: "10" } });
  await createRecord("u", { n: "none", meta: {} });
});
afterEach(async () => {
  _resetCollectionCache();
  await closeDb();
});

async function names(filter: string): Promise<string> {
  const r = await listRecords("u", { filter });
  return r.data.map((x) => x["n"] as string).sort().join(",");
}

describe("comparisons", () => {
  it("compare a JSON number numerically", async () => {
    expect(await names("meta.level < 5")).toBe("three");
    expect(await names("meta.level > 5")).toBe("ten");
    expect(await names("meta.level = 10")).toBe("ten");
    expect(await names("meta.score >= 3")).toBe("three");
    expect(await names("meta.score = 2.5")).toBe("ten");
  });

  it("compare a JSON boolean with true and false", async () => {
    expect(await names("meta.banned = true")).toBe("ten");
    expect(await names("meta.banned != true")).toBe("three");
    expect(await names("meta.banned = false")).toBe("three");
  });

  it("keep JSON strings and numbers apart", async () => {
    expect(await names("meta.level = '10'")).toBe("");
    expect(await names("meta.label = '10'")).toBe("three");
    expect(await names("meta.label = 10")).toBe("");
  });

  it("read a nested path, and a path through a scalar as missing", async () => {
    expect(await names("meta.who.name = 'Bob'")).toBe("three");
    expect(await names("meta.level.x = 1")).toBe("");
  });

  it("compare array elements by the value's type", async () => {
    expect(await names("meta.tags:each > 2")).toBe("three");
    expect(await names("meta.tags ?> 10")).toBe("ten");
    expect(await names("meta.tags ?= 3")).toBe("three");
  });

  it("bind a number against a text column as SQLite does", async () => {
    expect(await names("sku = 123")).toBe("ten");
    expect(await names("qty > 5")).toBe("ten");
    expect(await names("qty = '3'")).toBe("three");
  });

  it("apply a JSON rule as written", async () => {
    await createCollection({
      name: "gated",
      fields: JSON.stringify([{ name: "n", type: "text" }, { name: "meta", type: "json" }]),
    });
    await createRecord("gated", { n: "high", meta: { level: 10, banned: false } });
    await createRecord("gated", { n: "banned", meta: { level: 1, banned: true } });
    await createRecord("gated", { n: "ok", meta: { level: 1, banned: false } });
    const r = await listRecords("gated", { auth: null, accessRule: "meta.level < 5 && meta.banned != true" });
    expect(r.data.map((x) => x["n"])).toEqual(["ok"]);
  });
});

describe("dates", () => {
  it("save and filter dates past 2038", async () => {
    const rec = await createRecord("u", { n: "later", due: "2040-01-01T00:00:00Z" });
    expect((await getRecord("u", rec.id as string))!["due"]).toBe(Date.UTC(2040, 0, 1) / 1000);
    expect(await names(`due > ${Date.UTC(2039, 0, 1) / 1000}`)).toBe("later");
  });
});
