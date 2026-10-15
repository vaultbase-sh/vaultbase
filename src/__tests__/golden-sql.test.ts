/**
 * Golden SQL: the SQLite schema and the filter compiler's output, pinned
 * byte for byte. The database layer is being put behind a driver facade so
 * other databases can plug in; the contract is that SQLite's SQL does not
 * change while that happens. A refactor that changes any of this fails
 * here, and must either be a bug fix (update the golden on purpose with
 * `UPDATE_GOLDEN=1 bun test golden-sql`) or be undone.
 *
 * Three goldens, under `src/__tests__/golden/`:
 *   fixed-schema.sql  every table, index, view and trigger a fresh database
 *                     has after `runMigrations` (from `sqlite_master`)
 *   user-table.sql    the table, indexes and full-text index of a collection
 *                     with every built-in field type
 *   filters.json      the SQL and parameters the filter compiler emits for a
 *                     corpus of expressions, under three callers (public,
 *                     user, admin) where the caller matters
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, getRawClient, initDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { parseFilter, type CollectionLookup, type ParseFilterOpts } from "../core/filter.ts";
import type { AuthContext } from "../core/rules.ts";
import { createPublicCollection } from "./_helpers.ts";
import { db } from "../db/index.ts";
import { createRecord, deleteRecord, getRecord, listRecords, updateRecord } from "../core/records.ts";

const DIR = new URL("./golden/", import.meta.url);
const UPDATE = process.env["UPDATE_GOLDEN"] === "1";

async function check(name: string, actual: string): Promise<void> {
  const file = Bun.file(new URL(name, DIR));
  if (UPDATE) {
    await Bun.write(file, actual);
    return;
  }
  const expected = (await file.exists()) ? await file.text() : null;
  expect(expected, `${name} missing — run UPDATE_GOLDEN=1 bun test golden-sql`).not.toBeNull();
  expect(actual).toBe(expected!);
}

function dumpSchema(where: string): string {
  const rows = getRawClient()
    .prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND ${where} ORDER BY type, name`)
    .all() as Array<{ type: string; name: string; sql: string }>;
  return rows.map((r) => `-- ${r.type} ${r.name}\n${r.sql};\n`).join("\n") + "\n";
}

/** Every built-in field type, with the options that change the DDL or the compiled SQL. */
const GOLD_FIELDS = [
  { name: "title", type: "text", required: true, options: { searchable: true } },
  { name: "slug", type: "text", options: { unique: true } },
  { name: "body", type: "editor", options: { searchable: true } },
  { name: "contact", type: "email" },
  { name: "site", type: "url" },
  { name: "price", type: "number" },
  { name: "active", type: "bool" },
  { name: "when", type: "date" },
  { name: "stamp", type: "autodate", onCreate: true, onUpdate: true },
  { name: "status", type: "select", options: { values: ["draft", "published"] } },
  { name: "tags", type: "select", options: { values: ["a", "b", "c"], multiple: true } },
  { name: "meta", type: "json" },
  { name: "cover", type: "file" },
  { name: "docs", type: "file", options: { multiple: true } },
  { name: "author", type: "relation", collection: "gold_people" },
  { name: "editors", type: "relation", collection: "gold_people", options: { multiple: true } },
  { name: "pt", type: "geoPoint" },
  { name: "emb", type: "vector", options: { dimensions: 3 } },
  { name: "hue", type: "color" },
  { name: "secret", type: "password" },
];
const PEOPLE_FIELDS = [
  { name: "name", type: "text" },
  { name: "role", type: "select", options: { values: ["staff", "guest"] } },
];

/**
 * The lookup the compiler is given, built from the corpus collections the
 * way records.ts builds it from the collection cache: public view and list
 * rules, password fields private, everything else filterable.
 */
const lookup: CollectionLookup = (name) => {
  const fields = name === "gold" ? GOLD_FIELDS : name === "gold_people" ? PEOPLE_FIELDS : null;
  if (!fields) return null;
  const names = new Set(fields.map((f) => f.name));
  const priv = new Set(fields.filter((f) => f.type === "password").map((f) => f.name));
  const system = new Set(["id", "created_at", "updated_at"]);
  return {
    viewRule: name === "gold_people" ? '@request.auth.id != ""' : null,
    listRule: name === "gold_people" ? 'role = "staff"' : null,
    hasField: (n) => names.has(n) || system.has(n),
    isPrivateField: (n) => priv.has(n),
    isFilterable: (n) => (names.has(n) && !priv.has(n)) || system.has(n),
  };
};

const GOLD_FILTERABLE = new Set([...GOLD_FIELDS.filter((f) => f.type !== "password").map((f) => f.name), "id", "created_at", "updated_at"]);
const hostOpts = { hostPrivateField: (n: string) => n === "secret", hostFilterable: (n: string) => GOLD_FILTERABLE.has(n) };

const USER: AuthContext = { type: "user", id: "u1", email: "u1@test.local", collectionName: "users", verified: true } as AuthContext;
const ADMIN: AuthContext = { type: "admin", id: "a1", email: "a1@test.local" } as AuthContext;

interface Case {
  /** Table the expression compiles against. */
  table?: string;
  expr: string;
  /** Compile under these callers; default is public only. */
  callers?: Array<"public" | "user" | "admin">;
  /** A client `?filter=` rather than a rule (inherits joined list rules, counts joins). */
  client?: boolean;
  /** Parameters hold the current time: the golden keeps their count, not their values. */
  timed?: boolean;
  request?: ParseFilterOpts["request"];
}

const CORPUS: Case[] = [
  // Scalars and literals
  { expr: 'title = "hello"' },
  { expr: 'title != "hello"' },
  { expr: "price > 10" },
  { expr: "price >= 10.5" },
  { expr: "price < -3" },
  { expr: "price <= 3" },
  { expr: "active = true" },
  { expr: "active = false" },
  { expr: 'status = "published"' },
  { expr: "when = null" },
  { expr: "when != null" },
  { expr: 'contact = ""' },
  { expr: 'id = "abc"' },
  { expr: "created_at > 1700000000" },
  { expr: 'title = "it\'s \\"quoted\\" 100%"' },
  // Boolean structure
  { expr: 'status = "published" && active = true' },
  { expr: 'status = "published" || active = true' },
  { expr: '(status = "published" || status = "draft") && price > 0' },
  { expr: '!(active = true)' },
  // Substring match
  { expr: 'title ~ "hel"' },
  { expr: 'title !~ "hel"' },
  { expr: 'title ~ "100%_"' },
  { expr: 'title ~ ""' },
  { expr: 'title ~ "x" || body ~ "x"' },
  // Modifiers
  { expr: 'title:lower = "HELLO"' },
  { expr: 'title:lower ~ "HEL"' },
  { expr: "tags:length = 2" },
  { expr: "tags:length > 0" },
  { expr: "docs:length = 0" },
  { expr: 'tags:each = "a"' },
  { expr: 'tags:each != "a"' },
  { expr: 'tags:each ~ "a"' },
  // Array-prefixed operators
  { expr: 'tags ?= "a"' },
  { expr: 'tags ?!= "a"' },
  { expr: 'tags ?~ "a"' },
  { expr: 'tags ?!~ "a"' },
  { expr: 'editors ?= "p1"' },
  { expr: 'tags ?= "a" && tags ?= "b"' },
  // JSON paths
  { expr: "meta.a = 1" },
  { expr: 'meta.a.b.c = "deep"' },
  { expr: "meta.list:length > 1" },
  { expr: 'meta.list ?= "x"' },
  // Relations and the request
  { expr: "author = @request.auth.id", callers: ["public", "user", "admin"] },
  { expr: 'author != "" && author = @request.auth.id', callers: ["user"] },
  { expr: "editors ?= @request.auth.id", callers: ["user"] },
  { expr: "@request.auth.verified = true", callers: ["public", "user"] },
  { expr: '@request.auth.type = "user"', callers: ["public", "user", "admin"] },
  { expr: '@request.auth.collectionName = "users"', callers: ["user"] },
  { expr: "@request.auth.anonymous = false", callers: ["user"] },
  { expr: '@request.method = "GET"', request: { method: "GET" } },
  { expr: '@request.context = "realtime"', request: { context: "realtime" } },
  { expr: '@request.headers.x_tenant = "t1"', request: { headers: { x_tenant: "t1" } } },
  { expr: '@request.query.view = "all"', request: { query: { view: "all" } } },
  { expr: '@request.body.title = "x"', request: { body: { title: "x" } } },
  { expr: "@request.body.title:isset = true", request: { body: { title: "x" } } },
  { expr: "@request.body.title:isset = true", request: { body: {} } },
  { expr: '@request.body.title:changed = true', request: { body: { title: "new" }, existing: { title: "old" } } },
  { expr: "title ~ @request.query.q", request: { query: { q: "50%_off" } } },
  // Cross-collection references
  { expr: '@collection.gold_people.name = "bob"', callers: ["public", "user", "admin"] },
  { expr: "@collection.gold_people.id = author", callers: ["user", "admin"] },
  { expr: '@collection.gold_people.role = "staff" && @collection.gold_people.id = author', callers: ["user"] },
  { expr: '@collection.gold_people:a.id = author && @collection.gold_people:b.name = "x"', callers: ["user"] },
  { expr: "@collection.gold_people.id != author", callers: ["public", "user", "admin"] },
  { expr: '@collection.gold_people.name != "x"', callers: ["user"] },
  { expr: '@collection.gold_people.name = "bob"', callers: ["user"], client: true },
  { expr: "@collection.missing.x = 1", callers: ["public", "admin"] },
  // Back-relations
  { table: "vb_gold_people", expr: "gold_via_author:length > 0", callers: ["public", "user", "admin"] },
  { table: "vb_gold_people", expr: "gold_via_author:length = 1000", callers: ["public"] },
  { table: "vb_gold_people", expr: 'gold_via_author.status ?= "published"', callers: ["public", "user"] },
  { table: "vb_gold_people", expr: "gold_via_author.price:length > 0", callers: ["public"] },
  { table: "vb_gold_people", expr: 'gold_via_author.title ?~ "x"', callers: ["user"], client: true },
  { table: "vb_gold_people", expr: "gold_via_editors:length > 0", callers: ["public"] },
  // Datetime macros
  { expr: "when <= @now", timed: true },
  { expr: "when >= @todayStart && when <= @todayEnd", timed: true },
  { expr: "when > @yesterday || when < @tomorrow", timed: true },
  { expr: "when >= @monthStart && when <= @monthEnd", timed: true },
  { expr: "when >= @yearStart && when <= @yearEnd", timed: true },
  { expr: "price = @second || price = @minute || price = @hour || price = @day || price = @weekday || price = @month || price = @year", timed: true },
  { expr: "stamp < @now", timed: true },
  // Functions
  { expr: "geoDistance(pt.lon, pt.lat, 13.4, 52.5) < 10" },
  { expr: 'strftime("%Y", when, "unixepoch") = "2026"' },
  { expr: 'strftime("%Y-%m", created_at, "unixepoch") = "2026-10"' },
];

function compile(c: Case, caller: "public" | "user" | "admin"): unknown {
  const auth = caller === "user" ? USER : caller === "admin" ? ADMIN : null;
  try {
    const out = parseFilter(c.expr, c.table ?? "vb_gold", {
      auth,
      request: c.request ?? null,
      lookup,
      clientFilter: c.client === true,
      ...hostOpts,
    });
    if (!out) return { parse: null };
    return { sql: out.sql, params: c.timed ? { count: out.params.length } : out.params };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

describe("golden SQL", () => {
  beforeEach(async () => {
    initDb(":memory:");
    await runMigrations();
  });
  afterEach(() => {
    _resetCollectionCache();
    closeDb();
  });

  it("fixed schema", async () => {
    await check("fixed-schema.sql", dumpSchema("name NOT LIKE 'sqlite_%'"));
  });

  it("user table with every field type", async () => {
    await createPublicCollection({ name: "gold_people", fields: JSON.stringify(PEOPLE_FIELDS) });
    await createPublicCollection({ name: "gold", fields: JSON.stringify(GOLD_FIELDS) });
    await check("user-table.sql", dumpSchema("(tbl_name LIKE 'vb_gold%' OR name LIKE '%vb_gold%')"));
  });

  it("filter compiler", async () => {
    const out: Record<string, unknown> = {};
    for (const c of CORPUS) {
      const key = `${c.table ?? "vb_gold"} | ${c.expr}${c.client ? " | client" : ""}${c.request ? " | " + JSON.stringify(c.request) : ""}`;
      const callers = c.callers ?? ["public"];
      out[key] = callers.length === 1 && callers[0] === "public"
        ? compile(c, "public")
        : Object.fromEntries(callers.map((k) => [k, compile(c, k)]));
    }
    await check("filters.json", JSON.stringify(out, null, 2) + "\n");
  });

  it("private and unknown columns raise the same error", () => {
    const a = (() => { try { parseFilter('secret = "x"', "vb_gold", { lookup, ...hostOpts }); return null; } catch (e) { return (e as Error).message; } })();
    const b = (() => { try { parseFilter('nothere = "x"', "vb_gold", { lookup, ...hostOpts }); return null; } catch (e) { return (e as Error).message; } })();
    expect(a).not.toBeNull();
    expect(a!.replace("secret", "<name>")).toBe(b!.replace("nothere", "<name>"));
  });
});

/**
 * The statement stream of the record operations: every SQL statement the
 * driver runs for a list (plain, filtered and sorted on page 2, expanded,
 * searched, without a total), a get, a create, an update, a plain delete
 * and a cascading delete. The sequence is run once untraced so every cache
 * (settings, totals, columns, statements) is warm, then once traced.
 */
describe("golden SQL: operations", () => {
  const CASCADE_PEOPLE = [{ name: "name", type: "text" }];
  const CASCADE_GOLD = GOLD_FIELDS.map((f) => (f.name === "author" ? { ...f, options: { cascade: "cascade" } } : f));

  beforeEach(async () => {
    initDb(":memory:");
    await runMigrations();
    await createPublicCollection({ name: "gold_people", fields: JSON.stringify(CASCADE_PEOPLE) });
    await createPublicCollection({ name: "gold", fields: JSON.stringify(CASCADE_GOLD) });
  });
  afterEach(() => {
    _resetCollectionCache();
    closeDb();
  });

  async function sequence(): Promise<void> {
    const person = await createRecord("gold_people", { name: "ann" });
    const rec = await createRecord("gold", { title: "hello world", price: 2.5, active: true, tags: ["a", "b"], author: person.id });
    await listRecords("gold");
    await listRecords("gold", { filter: 'active = true && title ~ "hello"', sort: "-price,title", page: 2, perPage: 10 });
    await listRecords("gold", { expand: "author", fields: "title,author" });
    await listRecords("gold", { search: "hello" });
    await listRecords("gold", { skipTotal: true });
    await getRecord("gold", rec.id);
    await updateRecord("gold", rec.id, { price: 3, tags: ["c"] });
    await deleteRecord("gold", rec.id);
    const again = await createRecord("gold", { title: "second", author: person.id });
    await deleteRecord("gold_people", person.id); // cascades into gold
    expect(await getRecord("gold", again.id)).toBeNull();
  }

  it("statement stream", async () => {
    await sequence();
    const seen: string[] = [];
    db.trace((sql) => seen.push(sql));
    try {
      await sequence();
    } finally {
      db.trace(null);
    }
    await check("operations.sql", seen.map((s) => s.replace(/\s+/g, " ").trim() + ";").join("\n") + "\n");
  });
});
