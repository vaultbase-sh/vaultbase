/**
 * Renaming a field keeps the column and its data when the update names the
 * previous name in `renamedFrom`. Without it, as before, a new name is a
 * drop plus an add.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache, getCollection, updateCollection, parseFields } from "../core/collections.ts";
import { createRecord, getRecord, listRecords } from "../core/records.ts";
import { createPublicCollection, onSqlite } from "./_helpers.ts";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  await createPublicCollection({
    name: "posts",
    fields: JSON.stringify([
      { name: "title", type: "text", options: { searchable: true } },
      { name: "slug", type: "text", options: { unique: true } },
      { name: "body", type: "text" },
    ]),
  });
});

afterEach(async () => {
  _resetCollectionCache();
  await closeDb();
});

describe("field rename", () => {
  it("keeps the data, the unique index and the search index", async () => {
    const rec = await createRecord("posts", { title: "hello world", slug: "hello", body: "b" });
    const col = (await getCollection("posts"))!;
    await updateCollection(col.id, {
      fields: JSON.stringify([
        { name: "headline", type: "text", options: { searchable: true }, renamedFrom: "title" },
        { name: "handle", type: "text", options: { unique: true }, renamedFrom: "slug" },
        { name: "body", type: "text" },
      ]),
    });
    const after = (await getRecord("posts", rec.id))!;
    expect(after["headline"]).toBe("hello world");
    expect(after["handle"]).toBe("hello");
    expect("title" in after).toBe(false);
    // The stored schema carries the new names and no rename hint.
    const stored = parseFields((await getCollection("posts"))!.fields);
    expect(stored.map((f) => f.name)).toEqual(["headline", "handle", "body"]);
    expect(stored.some((f) => "renamedFrom" in f)).toBe(false);
    // Uniqueness survived the rename.
    await expect(createRecord("posts", { headline: "x", handle: "hello", body: "" })).rejects.toThrow();
    // Search still works on the renamed column.
    expect((await listRecords("posts", { search: "hello" })).data.map((r) => r.id)).toEqual([rec.id]);
    const cols = (await db.all<{ name: string }>(db.dialect.listColumnsSql("vb_posts"))).map((c) => c.name);
    expect(cols).toContain("headline");
    expect(cols).not.toContain("title");
  });

  it("without the hint a new name is still a new, empty field", async () => {
    const rec = await createRecord("posts", { title: "hello", slug: "s", body: "b" });
    const col = (await getCollection("posts"))!;
    await updateCollection(col.id, {
      fields: JSON.stringify([{ name: "headline", type: "text" }, { name: "slug", type: "text", options: { unique: true } }, { name: "body", type: "text" }]),
    });
    expect((await getRecord("posts", rec.id))!["headline"]).toBeNull();
  });

  it("refuses to rename and change the type in one step", async () => {
    const col = (await getCollection("posts"))!;
    await expect(updateCollection(col.id, {
      fields: JSON.stringify([{ name: "count", type: "number", renamedFrom: "title" }, { name: "slug", type: "text", options: { unique: true } }, { name: "body", type: "text" }]),
    })).rejects.toThrow(/change its type/);
  });
});
