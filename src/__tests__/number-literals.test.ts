/**
 * Signed and decimal number literals in filters and rules, and the
 * geoDistance() function they are usually written with.
 *
 * `10.5` used to be read as a dotted path (field `10`, key `5`) and a sign
 * never matched, so `price >= 10.5` and `price < -3` failed to parse. And
 * geoDistance() compiled its latitude arguments into the SQL twice while
 * binding each once, so the documented radius search failed with a
 * parameter-count error for any literal coordinates.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, initDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { createRecord, listRecords } from "../core/records.ts";
import { parseFilter } from "../core/filter.ts";
import { evaluateRule } from "../core/rules.ts";
import { createPublicCollection } from "./_helpers.ts";

const opts = { hostFilterable: () => true };

describe("number literals", () => {
  it("parse decimals, signs and plain integers", () => {
    expect(parseFilter("price >= 10.5", "vb_t", opts)).toEqual({ sql: `"vb_t"."price" >= ?`, params: [10.5] });
    expect(parseFilter("price < -3", "vb_t", opts)).toEqual({ sql: `"vb_t"."price" < ?`, params: [-3] });
    expect(parseFilter("price = -0.25", "vb_t", opts)).toEqual({ sql: `"vb_t"."price" = ?`, params: [-0.25] });
    expect(parseFilter("price = 3", "vb_t", opts)).toEqual({ sql: `"vb_t"."price" = ?`, params: [3] });
    expect(parseFilter("meta.a = 1.5", "vb_t", opts)).toEqual({ sql: `json_extract("vb_t"."meta", '$.a') = ?`, params: [1.5] });
  });

  it("still read a field that contains digits", () => {
    expect(parseFilter("n2 = 1", "vb_t", opts)).toEqual({ sql: `"vb_t"."n2" = ?`, params: [1] });
  });

  it("reject a number running into letters", () => {
    expect(() => parseFilter("price = 10abc", "vb_t", opts)).toThrow();
  });

  it("evaluate in-process", () => {
    expect(evaluateRule("price >= 10.5", null, { price: 11 })).toBe(true);
    expect(evaluateRule("price >= 10.5", null, { price: 10 })).toBe(false);
    expect(evaluateRule("temp < -3", null, { temp: -4 })).toBe(true);
    expect(evaluateRule("temp < -3", null, { temp: -2 })).toBe(false);
  });
});

describe("geoDistance", () => {
  beforeEach(async () => {
    initDb(":memory:");
    await runMigrations();
    await createPublicCollection({
      name: "places",
      fields: JSON.stringify([{ name: "name", type: "text" }, { name: "point", type: "geoPoint" }]),
    });
    await createRecord("places", { name: "near", point: { lng: -73.98, lat: 40.75 } });
    await createRecord("places", { name: "far", point: { lng: 13.4, lat: 52.5 } });
  });
  afterEach(() => {
    _resetCollectionCache();
    closeDb();
  });

  it("binds every placeholder", () => {
    const out = parseFilter("geoDistance(point.lng, point.lat, -73.99, 40.74) < 5", "vb_places", opts)!;
    expect((out.sql.match(/\?/g) ?? []).length).toBe(out.params.length);
  });

  it("answers the documented radius search", async () => {
    const near = await listRecords("places", { filter: "geoDistance(point.lng, point.lat, -73.99, 40.74) < 5" });
    expect(near.data.map((r) => r["name"])).toEqual(["near"]);
    const none = await listRecords("places", { filter: "geoDistance(point.lng, point.lat, 0, 0) < 1" });
    expect(none.data).toEqual([]);
    const both = await listRecords("places", { filter: "geoDistance(point.lng, point.lat, -73.99, 40.74) < 10000", sort: "name" });
    expect(both.data.map((r) => r["name"])).toEqual(["far", "near"]);
  });
});
