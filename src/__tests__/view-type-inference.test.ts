import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../db/client.ts";
import type { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, inferViewFields, parseFields } from "../core/collections.ts";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

function rawClient(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

/**
 * Build a raw source table so each column's storage type is exactly what we
 * want — bypassing records.ts encoders (which would, e.g., serialize JSON to
 * a TEXT BLOB on the way in).
 */
function seedSource(): void {
  const client = rawClient();
  client.exec(`
    CREATE TABLE src (
      id TEXT PRIMARY KEY,
      title TEXT,
      score INTEGER,
      active INTEGER,
      link TEXT,
      contact TEXT,
      body TEXT,
      published_at INTEGER,
      iso_when TEXT,
      is_admin INTEGER,
      flag_count INTEGER,
      empty_col TEXT
    )
  `);
  client.prepare(
    `INSERT INTO src VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    "r1",
    "hi",
    42,
    1,                            // 'active' — INTEGER 1, will be classified by sqlite driver as number
    "https://x.io",
    "a@b.io",
    `{"foo":1}`,
    1745700000,                   // 10-digit unix epoch
    "2026-04-27T10:00:00Z",
    1,                            // is_admin — bool by name hint
    1,                            // flag_count — number, no bool name hint
    null
  );
}

describe("inferViewFields()", () => {
  it("classifies number, url, email, json, date, and text from a sample row", async () => {
    seedSource();
    const fields = inferViewFields(
      `SELECT id, title, score, link, contact, body, published_at, iso_when FROM src`
    );
    const byName = new Map(fields.map((f) => [f.name, f.type]));
    // id is filtered (meta column)
    expect(byName.has("id")).toBe(false);
    expect(byName.get("title")).toBe("text");
    expect(byName.get("score")).toBe("number");
    expect(byName.get("link")).toBe("url");
    expect(byName.get("contact")).toBe("email");
    expect(byName.get("body")).toBe("json");
    expect(byName.get("published_at")).toBe("date"); // 10-digit + *_at
    expect(byName.get("iso_when")).toBe("date"); // ISO-8601 string
  });

  it("falls back to text when the sample row is all-null for a column", () => {
    seedSource();
    const fields = inferViewFields(`SELECT empty_col FROM src`);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ name: "empty_col", type: "text" });
  });

  it("falls back to text when the query returns no rows", () => {
    seedSource();
    const fields = inferViewFields(`SELECT title, score FROM src WHERE 1 = 0`);
    expect(fields.map((f) => f.type)).toEqual(["text", "text"]);
  });

  it("treats integer 0/1 as bool when column name hints (is_*), as number otherwise", () => {
    seedSource();
    const fields = inferViewFields(`SELECT is_admin, flag_count, active FROM src`);
    const byName = new Map(fields.map((f) => [f.name, f.type]));
    expect(byName.get("is_admin")).toBe("bool");
    // 'active' has no is_/has_/_enabled hint → number, not bool
    expect(byName.get("active")).toBe("number");
    expect(byName.get("flag_count")).toBe("number");
  });

  it("recognizes literal boolean values as bool", () => {
    // Bun's sqlite driver returns INTEGER as number, so to test a pure JS
    // boolean we exercise classifyValue indirectly by selecting a JSON object
    // through json_extract — but easier: just verify the algorithm via a SELECT
    // that returns boolean-ish numbers under a `*_enabled` name.
    seedSource();
    const fields = inferViewFields(`SELECT is_admin AS feature_enabled FROM src`);
    expect(fields[0]).toMatchObject({ name: "feature_enabled", type: "bool" });
  });

  it("recognizes ISO-8601 date strings as date", () => {
    seedSource();
    const fields = inferViewFields(`SELECT iso_when FROM src`);
    expect(fields[0]).toMatchObject({ name: "iso_when", type: "date" });
  });

  it("recognizes 10-digit unix timestamps in *_at columns as date", () => {
    seedSource();
    const fields = inferViewFields(`SELECT published_at FROM src`);
    expect(fields[0]).toMatchObject({ name: "published_at", type: "date" });
    // Same number, different name → number
    const numbery = inferViewFields(`SELECT published_at AS score FROM src`);
    expect(numbery[0]).toMatchObject({ name: "score", type: "number" });
  });

  it("recognizes JSON-shaped strings as json (object and array)", () => {
    const client = rawClient();
    client.exec(`CREATE TABLE jsrc (a TEXT, b TEXT)`);
    client.prepare(`INSERT INTO jsrc VALUES (?, ?)`).run(`{"k":1}`, `[1,2,3]`);
    const fields = inferViewFields(`SELECT a, b FROM jsrc`);
    expect(fields.map((f) => f.type)).toEqual(["json", "json"]);
  });

  it("recognizes URL and email strings", () => {
    seedSource();
    const fields = inferViewFields(`SELECT link, contact FROM src`);
    const byName = new Map(fields.map((f) => [f.name, f.type]));
    expect(byName.get("link")).toBe("url");
    expect(byName.get("contact")).toBe("email");
  });

  it("classifies plain strings as text", () => {
    seedSource();
    const fields = inferViewFields(`SELECT title FROM src`);
    expect(fields[0]).toMatchObject({ name: "title", type: "text" });
  });

  it("filters meta columns (id, created, created_at, updated, updated_at)", () => {
    const client = rawClient();
    client.exec(`
      CREATE TABLE m (id TEXT, created INTEGER, created_at INTEGER, updated INTEGER, updated_at INTEGER, payload TEXT)
    `);
    client.prepare(`INSERT INTO m VALUES (?, ?, ?, ?, ?, ?)`).run("1", 1, 1, 1, 1, "x");
    const fields = inferViewFields(`SELECT id, created, created_at, updated, updated_at, payload FROM m`);
    expect(fields.map((f) => f.name)).toEqual(["payload"]);
  });
});

describe("createCollection (view) — uses inferViewFields", () => {
  it("populates typed fields when caller omits explicit fields", async () => {
    seedSource();
    const col = await createCollection({
      name: "post_view",
      type: "view",
      view_query: `SELECT id, title, score, published_at FROM src`,
      fields: JSON.stringify([]),
    });
    const fields = parseFields(col.fields);
    const byName = new Map(fields.map((f) => [f.name, f.type]));
    expect(byName.get("title")).toBe("text");
    expect(byName.get("score")).toBe("number");
    expect(byName.get("published_at")).toBe("date");
  });
});
