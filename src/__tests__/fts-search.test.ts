/**
 * Full-text search: `searchable` fields, the FTS5 index lifecycle and
 * `?search=` on the list endpoint.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { initDb, closeDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import {
  createCollection, updateCollection, deleteCollection, getCollection, type FieldDef,
} from "../core/collections.ts";
import { createRecord, updateRecord, deleteRecord, listRecords, FilterError } from "../core/records.ts";
import { ftsColumns, hasFts, toFtsQuery } from "../core/fts.ts";
import { makeRecordsPlugin } from "../api/records.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-fts-"));
  setLogsDir(tmpDir);
  await initDb(":memory:");
  await runMigrations();
});

afterEach(async () => {
  await closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

const FIELDS: FieldDef[] = [
  { name: "title", type: "text", options: { searchable: true } },
  { name: "body", type: "editor", options: { searchable: true } },
  { name: "status", type: "text" },
];

async function notes(fields: FieldDef[] = FIELDS, rules: Record<string, string | null> = {}) {
  return createCollection({
    name: "notes", type: "base", fields: JSON.stringify(fields),
    list_rule: null, view_rule: null, create_rule: null, update_rule: null, delete_rule: null,
    ...rules,
  });
}

const ids = async (search: string, extra: Parameters<typeof listRecords>[1] = {}) =>
  (await listRecords("notes", { search, ...extra })).data.map((r) => r["title"]);

describe("toFtsQuery", () => {
  it("quotes terms, ANDs them and prefixes the last", () => {
    expect(toFtsQuery("hello world")).toBe(`"hello" "world"*`);
    expect(toFtsQuery("  ")).toBeNull();
    expect(toFtsQuery(`say "hi"`)).toBe(`"say" "hi"*`);
  });
});

describe("index lifecycle", () => {
  it("creates the index only for searchable fields", async () => {
    await notes();
    expect(ftsColumns("notes")).toEqual(["title", "body"]);
  });

  it("rejects searchable on a non-text or encrypted field", async () => {
    await expect(notes([{ name: "n", type: "number", options: { searchable: true } }])).rejects.toThrow();
    await expect(notes([{ name: "s", type: "text", options: { searchable: true, encrypted: true } }])).rejects.toThrow();
  });

  it("backfills when a field becomes searchable, and survives dropping it", async () => {
    const col = await notes([{ name: "title", type: "text" }, { name: "status", type: "text" }]);
    expect(hasFts("notes")).toBe(false);
    await createRecord("notes", { title: "existing row", status: "open" });

    await updateCollection(col.id, { fields: JSON.stringify([
      { name: "title", type: "text", options: { searchable: true } },
      { name: "status", type: "text", options: { searchable: true } },
    ]) });
    expect(await ids("existing")).toEqual(["existing row"]);
    expect(await ids("open")).toEqual(["existing row"]);

    // Dropping an indexed column must not be blocked by the triggers.
    await updateCollection(col.id, { fields: JSON.stringify([{ name: "title", type: "text", options: { searchable: true } }]) });
    expect(ftsColumns("notes")).toEqual(["title"]);
    expect(await ids("existing")).toEqual(["existing row"]);

    await updateCollection(col.id, { fields: JSON.stringify([{ name: "title", type: "text" }]) });
    expect(hasFts("notes")).toBe(false);
  });

  it("follows a rename and goes away with the collection", async () => {
    const col = await notes();
    await createRecord("notes", { title: "renamed one" });
    await updateCollection(col.id, { name: "memos" });
    expect(hasFts("notes")).toBe(false);
    expect((await listRecords("memos", { search: "renamed" })).data.length).toBe(1);
    await deleteCollection(col.id);
    expect(hasFts("memos")).toBe(false);
  });

  it("is restored at boot if missing", async () => {
    await notes();
    await createRecord("notes", { title: "boot check" });
    getRawClient().exec(`DROP TABLE vb_notes_fts`);
    await runMigrations();
    expect(await ids("boot")).toEqual(["boot check"]);
  });
});

describe("search", () => {
  it("matches words, prefixes and accents", async () => {
    await notes();
    await createRecord("notes", { title: "Café opening", body: "<p>Fresh bread</p>" });
    await createRecord("notes", { title: "مرحبا بالعالم", body: "" });
    await createRecord("notes", { title: "Unrelated", body: "nothing here" });
    expect(await ids("cafe")).toEqual(["Café opening"]);
    expect(await ids("bre")).toEqual(["Café opening"]);
    expect(await ids("مرحبا")).toEqual(["مرحبا بالعالم"]);
    expect(await ids("bread cafe")).toEqual(["Café opening"]);
    expect(await ids("bread missing")).toEqual([]);
  });

  it("orders by relevance unless a sort is given", async () => {
    await notes();
    await createRecord("notes", { title: "a apple banana cherry date elder fig grape", body: "" });
    await createRecord("notes", { title: "b apple apple apple", body: "" });
    expect((await ids("apple"))[0]).toStartWith("b ");
    expect((await ids("apple", { sort: "title" }))[0]).toStartWith("a ");
  });

  it("tracks updates and deletes", async () => {
    await notes();
    const r = await createRecord("notes", { title: "before" });
    await updateRecord("notes", String(r.id), { title: "after" });
    expect(await ids("before")).toEqual([]);
    expect(await ids("after")).toEqual(["after"]);
    // Writes that skip the records API are covered by the triggers too.
    getRawClient().prepare(`UPDATE vb_notes SET title = 'raw sql' WHERE id = ?`).run(String(r.id));
    expect(await ids("raw")).toEqual(["raw sql"]);
    await deleteRecord("notes", String(r.id));
    expect(await ids("raw")).toEqual([]);
  });

  it("combines with filter, count and pagination", async () => {
    await notes();
    for (let i = 0; i < 5; i++) await createRecord("notes", { title: `alpha ${i}`, status: i % 2 ? "odd" : "even" });
    await createRecord("notes", { title: "beta", status: "odd" });
    const res = await listRecords("notes", { search: "alpha", filter: `status = "odd"`, perPage: 1 });
    expect(res.totalItems).toBe(2);
    expect(res.data.length).toBe(1);
  });

  it("treats FTS syntax in the input as text", async () => {
    await notes();
    await createRecord("notes", { title: "plain" });
    for (const s of [`OR`, `"`, `-plain`, `title:plain`, `*`, `NEAR(a b)`, `(`, `^`]) {
      await listRecords("notes", { search: s });
    }
    expect(await ids("-plain")).toEqual(["plain"]);
  });

  it("errors on a collection without searchable fields", async () => {
    await notes([{ name: "title", type: "text" }]);
    await expect(listRecords("notes", { search: "x" })).rejects.toBeInstanceOf(FilterError);
    expect((await listRecords("notes", { search: "  " })).data).toEqual([]);
  });
});

describe("API", () => {
  it("applies the list rule to search results", async () => {
    await notes(FIELDS, { list_rule: `status = "public"` });
    await createRecord("notes", { title: "secret plan", status: "private" });
    await createRecord("notes", { title: "public plan", status: "public" });
    const res = await makeRecordsPlugin("s").handle(new Request("http://localhost/notes?search=plan"));
    const body = await res.json() as { data: Array<{ title: string }> };
    expect(body.data.map((r) => r.title)).toEqual(["public plan"]);
  });

  it("narrows vector search candidates", async () => {
    await notes([
      { name: "title", type: "text", options: { searchable: true } },
      { name: "emb", type: "vector", options: { dimensions: 2 } },
    ]);
    await createRecord("notes", { title: "apple near", emb: [1, 0] });
    await createRecord("notes", { title: "apple far", emb: [0, 1] });
    await createRecord("notes", { title: "pear nearest", emb: [1, 0] });
    const url = `http://localhost/notes?search=apple&nearVectorField=emb&nearVector=${encodeURIComponent("[1,0]")}`;
    const body = await (await makeRecordsPlugin("s").handle(new Request(url))).json() as { data: Array<{ title: string }> };
    expect(body.data.map((r) => r.title)).toEqual(["apple near", "apple far"]);
  });

  it("returns 400 for a collection without searchable fields", async () => {
    await notes([{ name: "title", type: "text" }]);
    const res = await makeRecordsPlugin("s").handle(new Request("http://localhost/notes?search=x"));
    expect(res.status).toBe(400);
    expect(await getCollection("notes")).not.toBeNull();
  });
});
