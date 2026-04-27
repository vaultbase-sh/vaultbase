import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import {
  createCollection,
  fieldsFromViewColumns,
  getCollection,
  inferViewColumns,
  parseFields,
  updateCollection,
  validateViewQuery,
} from "../core/collections.ts";
import { createRecord, deleteRecord, listRecords, ReadOnlyCollectionError, updateRecord } from "../core/records.ts";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

describe("validateViewQuery", () => {
  it("accepts a single SELECT", () => {
    expect(() => validateViewQuery("SELECT 1 AS x")).not.toThrow();
    expect(() => validateViewQuery("  select id, title FROM vb_posts  ")).not.toThrow();
    expect(() => validateViewQuery("SELECT 1; ")).not.toThrow(); // trailing semicolon stripped
  });

  it("rejects empty queries", () => {
    expect(() => validateViewQuery("")).toThrow(/empty/);
    expect(() => validateViewQuery("   ")).toThrow(/empty/);
  });

  it("rejects multiple statements", () => {
    expect(() => validateViewQuery("SELECT 1; SELECT 2")).toThrow(/single statement/);
  });

  it("rejects non-SELECT", () => {
    expect(() => validateViewQuery("PRAGMA foo")).toThrow(/SELECT/);
    expect(() => validateViewQuery("VACUUM")).toThrow(/SELECT/);
  });

  it.each([
    ["INSERT INTO foo SELECT 1"],
    ["WITH x AS (DELETE FROM foo RETURNING *) SELECT * FROM x"],
    ["SELECT 1; DROP TABLE foo"],
    ["SELECT 1 UNION SELECT * FROM (UPDATE foo SET bar = 1 RETURNING *)"],
    ["select * from (insert into foo values(1) returning *)"],
  ])("rejects mutating verbs anywhere in the query: %s", (query) => {
    expect(() => validateViewQuery(query)).toThrow();
  });
});

describe("view collection lifecycle", () => {
  async function seedSource() {
    await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    await createRecord("posts", { title: "alpha" });
    await createRecord("posts", { title: "beta" });
  }

  it("creates a view, infers columns, and lists rows via the records API", async () => {
    await seedSource();
    const col = await createCollection({
      name: "post_titles",
      type: "view",
      view_query: 'SELECT id, title FROM vb_posts',
      fields: JSON.stringify([]),
    });
    expect(col.type).toBe("view");
    const fields = parseFields(col.fields);
    // id is filtered from the inferred fields (it's part of record meta)
    expect(fields.map((f) => f.name)).toContain("title");

    const result = await listRecords("post_titles");
    expect(result.totalItems).toBe(2);
    const titles = result.data.map((r) => r["title"]).sort();
    expect(titles).toEqual(["alpha", "beta"]);
  });

  it("defaults list_rule and view_rule to admin-only ('') for safety", async () => {
    await seedSource();
    const col = await createCollection({
      name: "post_titles",
      type: "view",
      view_query: "SELECT id, title FROM vb_posts",
    });
    expect(col.list_rule).toBe("");
    expect(col.view_rule).toBe("");
  });

  it("rejects creation when view_query is missing", async () => {
    await expect(
      createCollection({ name: "broken", type: "view", fields: JSON.stringify([]) })
    ).rejects.toThrow(/view_query/);
  });

  it("recreates the underlying VIEW when query changes on update", async () => {
    await seedSource();
    const col = await createCollection({
      name: "post_titles",
      type: "view",
      view_query: "SELECT id, title FROM vb_posts WHERE title = 'alpha'",
    });
    let result = await listRecords("post_titles");
    expect(result.totalItems).toBe(1);

    await updateCollection(col.id, { view_query: "SELECT id, title FROM vb_posts" });
    result = await listRecords("post_titles");
    expect(result.totalItems).toBe(2);
  });

  it("preserves user-edited field types when only metadata (not query) changes", async () => {
    await seedSource();
    const col = await createCollection({
      name: "post_titles",
      type: "view",
      view_query: "SELECT id, title FROM vb_posts",
    });
    // Caller customizes a field type from text → editor; query unchanged.
    await updateCollection(col.id, {
      fields: JSON.stringify([{ name: "title", type: "editor" }]),
    });
    const after = await getCollection("post_titles");
    const fields = parseFields(after!.fields);
    expect(fields.find((f) => f.name === "title")?.type).toBe("editor");
  });
});

describe("view collections are read-only via the records API", () => {
  async function setupView() {
    await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    await createRecord("posts", { title: "x" });
    await createCollection({
      name: "post_titles",
      type: "view",
      view_query: "SELECT id, title FROM vb_posts",
    });
  }

  it("createRecord throws ReadOnlyCollectionError", async () => {
    await setupView();
    await expect(createRecord("post_titles", { title: "y" })).rejects.toThrow(ReadOnlyCollectionError);
  });

  it("updateRecord throws ReadOnlyCollectionError", async () => {
    await setupView();
    const list = await listRecords("post_titles");
    const id = String(list.data[0]!.id);
    await expect(updateRecord("post_titles", id, { title: "z" })).rejects.toThrow(ReadOnlyCollectionError);
  });

  it("deleteRecord throws ReadOnlyCollectionError", async () => {
    await setupView();
    const list = await listRecords("post_titles");
    const id = String(list.data[0]!.id);
    await expect(deleteRecord("post_titles", id)).rejects.toThrow(ReadOnlyCollectionError);
  });
});

describe("inferViewColumns + fieldsFromViewColumns", () => {
  it("returns column names for a SELECT", async () => {
    await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    const cols = inferViewColumns("SELECT id, title FROM vb_posts");
    expect(cols).toContain("id");
    expect(cols).toContain("title");
  });

  it("strips id/created/updated from generated field defs", () => {
    const fields = fieldsFromViewColumns(["id", "title", "created_at", "updated_at"]);
    expect(fields.map((f) => f.name)).toEqual(["title"]);
  });

  it("defaults all generated fields to text type", () => {
    const fields = fieldsFromViewColumns(["title", "score"]);
    expect(fields.every((f) => f.type === "text")).toBe(true);
  });
});
