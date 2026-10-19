import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { createPublicCollection } from "./_helpers.ts";

// `field.key` in a filter reads inside a json field. On a relation or text
// field the database can't parse the column, and that used to surface as a
// 500 ("malformed JSON"), with docs suggesting `author.id = …` would work.

const SECRET = "test-secret-filter-json-paths";
let authorId = "";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  await createPublicCollection({ name: "people", fields: JSON.stringify([{ name: "name", type: "text" }]) });
  await createPublicCollection({
    name: "notes",
    fields: JSON.stringify([
      { name: "title", type: "text" },
      { name: "meta", type: "json" },
      { name: "author", type: "relation", collection: "people" },
    ]),
  });
  authorId = (await createRecord("people", { name: "Ada" })).id;
  await createRecord("notes", { title: "red one", meta: { color: "red" }, author: authorId });
  await createRecord("notes", { title: "blue one", meta: { color: "blue" }, author: authorId });
});

afterEach(async () => {
  _resetCollectionCache();
  await closeDb();
});

const list = async (filter: string) => {
  const r = await makeRecordsPlugin(SECRET).handle(new Request(`http://localhost/notes?filter=${encodeURIComponent(filter)}`));
  return { status: r.status, json: (await r.json()) as { data?: Array<{ title: string }>; error?: string } };
};

describe("dotted paths in filters", () => {
  it("read inside a json field (legitimate path)", async () => {
    const r = await list('meta.color = "red"');
    expect(r.status).toBe(200);
    expect(r.json.data!.map((n) => n.title)).toEqual(["red one"]);
  });

  it("on a relation field are a 400 that says to compare the id", async () => {
    const r = await list('author.name = "Ada"');
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("relation");
  });

  it("on a text field are a 400 too", async () => {
    expect((await list('title.x = "y"')).status).toBe(400);
  });

  it("a relation compared with an id works", async () => {
    const r = await list(`author = "${authorId}"`);
    expect(r.status).toBe(200);
    expect(r.json.data).toHaveLength(2);
  });
});
