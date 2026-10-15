/**
 * The 1,000-row cap on `_via_` back-relations must cap the rows being
 * aggregated. It used to sit on the aggregate query itself, where LIMIT
 * applies to the single output row and capped nothing.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { listRecords, createRecord } from "../core/records.ts";
import { parseFilter } from "../core/filter.ts";
import { createPublicCollection } from "./_helpers.ts";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  await createPublicCollection({ name: "authors", fields: JSON.stringify([{ name: "name", type: "text" }]) });
  await createPublicCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }, { name: "author", type: "relation", collection: "authors" }]) });
});

afterEach(() => {
  _resetCollectionCache();
  closeDb();
});

describe("_via_ cap", () => {
  it("limits the aggregated rows to 1,000", async () => {
    const a = await createRecord("authors", { name: "prolific" });
    const b = await createRecord("authors", { name: "quiet" });
    const c = getRawClient();
    const ins = c.prepare(`INSERT INTO "vb_posts" ("id", "title", "author", "created_at", "updated_at") VALUES (?, ?, ?, 1, 1)`);
    c.exec("BEGIN");
    for (let i = 0; i < 1_200; i++) ins.run(crypto.randomUUID(), `p${i}`, a.id);
    for (let i = 0; i < 3; i++) ins.run(crypto.randomUUID(), `q${i}`, b.id);
    c.exec("COMMIT");
    const capped = await listRecords("authors", { filter: "posts_via_author:length = 1000" });
    expect(capped.data.map((r) => r["name"])).toEqual(["prolific"]);
    const small = await listRecords("authors", { filter: "posts_via_author:length = 3" });
    expect(small.data.map((r) => r["name"])).toEqual(["quiet"]);
  });

  it("puts the LIMIT on the rows, not on the aggregate", () => {
    const r = parseFilter(`posts_via_author:length > 0`, "vb_authors", { id: "x", type: "admin" });
    expect(r?.sql).toMatch(/json_group_array\(_vb_v\) FROM \(SELECT .* LIMIT 1000\)\)/);
  });
});
