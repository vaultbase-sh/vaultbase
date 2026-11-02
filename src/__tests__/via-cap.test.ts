/**
 * The 1,000-row cap on `_via_` back-relations must cap the rows being
 * aggregated. It used to sit on the aggregate query itself, where LIMIT
 * applies to the single output row and capped nothing.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { listRecords, createRecord } from "../core/records.ts";
import { parseFilter } from "../core/filter.ts";
import { createPublicCollection } from "./_helpers.ts";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  await createPublicCollection({ name: "authors", fields: JSON.stringify([{ name: "name", type: "text" }]) });
  await createPublicCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }, { name: "author", type: "relation", collection: "authors" }]) });
});

afterEach(async () => {
  _resetCollectionCache();
  await closeDb();
});

describe("_via_ cap", () => {
  it("limits the aggregated rows to 1,000", async () => {
    const a = await createRecord("authors", { name: "prolific" });
    const b = await createRecord("authors", { name: "quiet" });
    const ins = `INSERT INTO "vb_posts" ("id", "title", "author", "created_at", "updated_at") VALUES (?, ?, ?, 1, 1)`;
    await db.transaction(async () => {
      for (let i = 0; i < 1_200; i++) await db.run(ins, [crypto.randomUUID(), `p${i}`, a.id]);
      for (let i = 0; i < 3; i++) await db.run(ins, [crypto.randomUUID(), `q${i}`, b.id]);
    });
    const capped = await listRecords("authors", { filter: "posts_via_author:length = 1000" });
    expect(capped.data.map((r) => r["name"])).toEqual(["prolific"]);
    const small = await listRecords("authors", { filter: "posts_via_author:length = 3" });
    expect(small.data.map((r) => r["name"])).toEqual(["quiet"]);
  });

  it("puts the LIMIT on the rows, not on the aggregate", () => {
    const r = parseFilter(`posts_via_author:length > 0`, "vb_authors", { id: "x", type: "admin" });
    expect(r?.sql).toMatch(/COUNT\(\*\) FROM \(SELECT .* LIMIT 1000\) AS _vb_sub\)/);
    const values = parseFilter(`posts_via_author.title ~ "x"`, "vb_authors", { id: "x", type: "admin" });
    expect(values?.sql).toMatch(/json_(group_array|agg)\(_vb_v\) FROM \(SELECT .* LIMIT 1000\) AS _vb_sub\)/);
  });

  it(":length counts the rows once, and is 0 with none", async () => {
    // It took the subquery up to four times, and on Postgres an author with
    // no posts had NULL for a length, so `= 0` never matched.
    const a = await createRecord("authors", { name: "busy" });
    await createRecord("authors", { name: "idle" });
    await createRecord("posts", { title: "one", author: a.id });
    await createRecord("posts", { title: "two", author: a.id });
    const r = parseFilter(`posts_via_author:length > 0`, "vb_authors", { id: "x", type: "admin" });
    expect(r?.sql.match(/FROM "vb_posts"/g)).toHaveLength(1);
    expect((await listRecords("authors", { filter: "posts_via_author:length = 0" })).data.map((x) => x["name"])).toEqual(["idle"]);
    expect((await listRecords("authors", { filter: "posts_via_author:length = 2" })).data.map((x) => x["name"])).toEqual(["busy"]);
    expect((await listRecords("authors", { filter: "posts_via_author.title:length = 2" })).data.map((x) => x["name"])).toEqual(["busy"]);
  });
});
