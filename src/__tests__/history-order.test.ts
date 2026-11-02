/**
 * History ordered by `at` alone (seconds): a create and an update in the same
 * second came back in either order, so "the version at T" could be the
 * create, and a restore picked the wrong one.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, updateCollection, _resetCollectionCache } from "../core/collections.ts";
import { createRecord, updateRecord } from "../core/records.ts";
import { getHistoryAt, listRecordHistory } from "../core/record-history.ts";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  const col = await createCollection({ name: "docs", fields: JSON.stringify([{ name: "title", type: "text" }]) });
  await updateCollection(col.id, { history_enabled: 1 });
});
afterEach(async () => { _resetCollectionCache(); await closeDb(); });

describe("history in one second", () => {
  it("lists and finds the latest write first", async () => {
    const r = await createRecord("docs", { title: "v1" }, null);
    for (let i = 2; i <= 6; i++) await updateRecord("docs", r.id, { title: `v${i}` }, null);
    const list = await listRecordHistory("docs", r.id);
    expect(list.data.map((e) => e.snapshot["title"])).toEqual(["v6", "v5", "v4", "v3", "v2", "v1"]);
    expect((await getHistoryAt("docs", r.id, Math.floor(Date.now() / 1000) + 1))!.snapshot["title"]).toBe("v6");
  });
});
