/**
 * strftime() in filters on Postgres: the common format codes as to_char in
 * UTC, everything else refused with a clear error.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, initDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { createRecord, listRecords } from "../core/records.ts";
import { createPublicCollection } from "./_helpers.ts";

const count = async (filter: string) => (await listRecords("ev", { filter })).data.length;

describe("strftime() in filters", () => {
  beforeEach(async () => {
    await initDb(":memory:");
    await runMigrations();
    await createPublicCollection({ name: "ev", fields: JSON.stringify([{ name: "when", type: "date" }]) });
    await createRecord("ev", { when: 1792108800 }); // 2026-10-16T00:00:00Z
    await createRecord("ev", { when: 1767225600 }); // 2026-01-01T00:00:00Z
  });
  afterEach(async () => { _resetCollectionCache(); await closeDb(); });

  it("formats a stored date with the common codes, the same on every database", async () => {
    expect(await count(`strftime("%Y-%m", when, "unixepoch") = "2026-10"`)).toBe(1);
    expect(await count(`strftime("%Y", when, "unixepoch") = "2026"`)).toBe(2);
    expect(await count(`strftime("%d/%m %H:%M:%S", when, "unixepoch") = "16/10 00:00:00"`)).toBe(1);
    expect(await count(`strftime("%j", when, "unixepoch") = "001"`)).toBe(1);
    expect(await count(`strftime("%Y", "now") >= "2026"`)).toBe(2);
  });
});
