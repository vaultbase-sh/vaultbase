/**
 * A relation holds one record id. `multiple: true` was accepted in the schema
 * but no record could be written with it, so it is refused now; a schema that
 * already has one keeps it.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, getCollection, updateCollection, _resetCollectionCache } from "../core/collections.ts";
import { createWithLegacyMultipleRelations } from "./_helpers.ts";

const F = (fields: object[]) => JSON.stringify(fields);

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  await createCollection({ name: "tags", fields: F([{ name: "name", type: "text" }]) });
});
afterEach(async () => { _resetCollectionCache(); await closeDb(); });

describe("multiple relations", () => {
  it("are refused on a new collection and as a new field", async () => {
    await expect(createCollection({ name: "posts", fields: F([{ name: "tags", type: "relation", collection: "tags", options: { multiple: true } }]) })).rejects.toThrow();
    const col = await createCollection({ name: "posts", fields: F([{ name: "title", type: "text" }]) });
    await expect(updateCollection(col.id, { fields: F([{ name: "title", type: "text" }, { name: "tags", type: "relation", collection: "tags", options: { multiple: true } }]) })).rejects.toThrow();
  });

  it("a schema that has one keeps it through other edits (legitimate path)", async () => {
    const col = await createWithLegacyMultipleRelations({ name: "posts", fields: F([{ name: "tags", type: "relation", collection: "tags", options: { multiple: true } }]) });
    await updateCollection(col.id, { fields: F([{ name: "tags", type: "relation", collection: "tags", options: { multiple: true } }, { name: "title", type: "text" }]) });
    expect((await getCollection("posts"))!.fields).toContain('"title"');
  });

  it("a single relation is still fine (legitimate path)", async () => {
    await createCollection({ name: "posts", fields: F([{ name: "tag", type: "relation", collection: "tags" }]) });
  });
});
