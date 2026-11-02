/**
 * The unique check compared the raw input with the stored column: a date
 * (stored as seconds) never matched, so a duplicate reached the database's
 * unique index; a JSON value made the driver throw.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { aggregateRecords } from "../core/aggregate.ts";
import { createPublicCollection } from "./_helpers.ts";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  await createPublicCollection({ name: "events", fields: JSON.stringify([
    { name: "day", type: "date", options: { unique: true } },
    { name: "meta", type: "json", options: { unique: true } },
  ]) });
});
afterEach(async () => { _resetCollectionCache(); await closeDb(); });

const fieldErrors = async (data: Record<string, unknown>) => {
  try { await createRecord("events", data, null); return null; }
  catch (e) { return (e as { details?: Record<string, string> }).details ?? { error: String(e) }; }
};

describe("unique fields compare the stored form", () => {
  it("a duplicate date is a field error", async () => {
    expect(await fieldErrors({ day: "2024-01-01" })).toBeNull();
    expect(Object.keys((await fieldErrors({ day: "2024-01-01" }))!)).toEqual(["day"]);
  });

  it("a duplicate JSON value is a field error, not a driver error", async () => {
    expect(await fieldErrors({ meta: { a: 1 } })).toBeNull();
    expect(Object.keys((await fieldErrors({ meta: { a: 1 } }))!)).toEqual(["meta"]);
  });
});

describe("aggregate buckets", () => {
  it("refuses a bucket name that is only an object property", async () => {
    const { getCollection } = await import("../core/collections.ts");
    await expect(aggregateRecords((await getCollection("events"))!, { groupBy: "created:toString", agg: "count" } as never)).rejects.toThrow("invalid bucket");
  });
});
