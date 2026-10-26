/**
 * The fixed schema is generated from the drizzle declarations (db/ddl.ts)
 * and brought up to date at boot: tables created, missing columns added,
 * indexes created, one-off migrations recorded in vaultbase_migrations.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { onSqlite } from "./_helpers.ts";
import { closeDb, initDb } from "../db/client.ts";
import { runMigrations, runOnce } from "../db/migrate.ts";
import { columnSpecs, ensureFixedSchema, tableName } from "../db/ddl.ts";
import { FIXED_INDEXES, FIXED_TABLES } from "../db/fixed-schema.ts";
import { db } from "../db/index.ts";
import { ftsColumns } from "../core/fts.ts";
import * as schema from "../db/schema.ts";
import { _resetCollectionCache, createCollection } from "../core/collections.ts";

beforeEach(async () => { await initDb(":memory:"); });
afterEach(async () => { _resetCollectionCache(); await closeDb(); });

/** Columns of a table, through the dialect (empty when the table is missing). */
const columnsOf = async (table: string) =>
  (await db.all<{ name: string }>(db.dialect.listColumnsSql(table))).map((c) => c.name);

/** Index names of a table, through the dialect. */
const indexesOf = async (table: string) =>
  (await db.all<{ name: string }>(db.dialect.listIndexesSql(), [table])).map((i) => i.name);

/** The default expression for "now", as an older release declared it. */
const now = () => (db.name === "sqlite" ? "(unixepoch())" : db.dialect.epochNow);

describe("fixed schema", () => {
  it("adds the columns an older database is missing, in the declared shape", async () => {
    // A v0.10-era collections table: no history_enabled, no view_query.
    await db.exec(`CREATE TABLE vaultbase_collections (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, type TEXT NOT NULL DEFAULT 'base',
      fields TEXT NOT NULL DEFAULT '[]', list_rule TEXT, view_rule TEXT, create_rule TEXT,
      update_rule TEXT, delete_rule TEXT,
      created_at INTEGER NOT NULL DEFAULT ${now()}, updated_at INTEGER NOT NULL DEFAULT ${now()})`);
    await db.exec(`CREATE TABLE vaultbase_routes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', method TEXT NOT NULL, path TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT ${now()}, updated_at INTEGER NOT NULL DEFAULT ${now()})`);
    await db.exec(`INSERT INTO vaultbase_routes (id, method, path) VALUES ('r1', 'GET', '/x')`);
    await runMigrations();
    // Added columns land at the end, in declaration order: the set is what matters.
    expect((await columnsOf("vaultbase_collections")).sort()).toEqual(columnSpecs(schema.collections).map((c) => c.name).sort());
    expect((await columnsOf("vaultbase_routes")).sort()).toEqual(columnSpecs(schema.routes).map((c) => c.name).sort());
    const r = await db.get<Record<string, unknown>>(`SELECT require_auth, origin, file_path FROM vaultbase_routes WHERE id = 'r1'`);
    expect({ require_auth: Number(r!["require_auth"]), origin: r!["origin"], file_path: r!["file_path"] }).toEqual({ require_auth: 0, origin: "inline", file_path: null });
    expect(await indexesOf("vaultbase_routes")).toContain("idx_vaultbase_routes_file_path");
  });

  it("creates every declared table and index on a fresh database, and is idempotent", async () => {
    await ensureFixedSchema();
    for (const t of FIXED_TABLES) expect((await columnsOf(tableName(t))).length).toBeGreaterThan(0);
    for (const ix of FIXED_INDEXES) expect(await indexesOf(ix.table)).toContain(ix.name);
    const token = db.schemaToken();
    await ensureFixedSchema();
    expect(db.schemaToken()).toBe(token);
  });

  it("a missing column whose default is an expression: refused on SQLite, added with its default on Postgres", async () => {
    await db.exec(`CREATE TABLE vaultbase_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    await db.exec(`INSERT INTO vaultbase_settings (key, value) VALUES ('a', 'b')`);
    if (!db.dialect.addColumnExpressionDefault) {
      await expect(ensureFixedSchema()).rejects.toThrow(/vaultbase_settings\.updated_at/);
      return;
    }
    await ensureFixedSchema();
    expect(await columnsOf("vaultbase_settings")).toContain("updated_at");
    // The existing row got the default, a current epoch second.
    const row = await db.get<{ t: number }>(`SELECT updated_at AS t FROM vaultbase_settings WHERE key = 'a'`);
    expect(Math.abs(Number(row!.t) - Date.now() / 1000)).toBeLessThan(120);
  });

  it("runOnce records a migration and runs it once per database", async () => {
    await runMigrations();
    let runs = 0;
    await runOnce("test_step", () => { runs++; });
    await runOnce("test_step", () => { runs++; });
    expect(runs).toBe(1);
    const keys = (await db.all<{ key: string }>(`SELECT key FROM vaultbase_migrations ORDER BY key`)).map((r) => r.key);
    // Recorded once (the server's own migrations add their keys too).
    expect(keys.filter((k) => k === "test_step")).toEqual(["test_step"]);
    await closeDb();
    await initDb(":memory:");
    await runMigrations();
    await runOnce("test_step", () => { runs++; });
    expect(runs).toBe(2);
  });

  it("a start on an up-to-date database changes no schema", async () => {
    await runMigrations();
    await createCollection({ name: "authors", type: "base", fields: JSON.stringify([{ name: "name", type: "text" }]),
      list_rule: null, view_rule: null, create_rule: null, update_rule: null, delete_rule: null });
    await createCollection({ name: "posts", type: "base", fields: JSON.stringify([
      { name: "title", type: "text", options: { searchable: true } },
      { name: "author", type: "relation", collection: "authors" },
      { name: "published", type: "autodate" },
    ]), list_rule: null, view_rule: null, create_rule: null, update_rule: null, delete_rule: null });
    // The longest name: Postgres cuts its index names to 63 bytes.
    const long = "l".repeat(63);
    await createCollection({ name: long, type: "base", fields: JSON.stringify([
      { name: "body", type: "text", options: { searchable: true } },
    ]), list_rule: null, view_rule: null, create_rule: null, update_rule: null, delete_rule: null });
    expect(await ftsColumns(long)).toEqual(["body"]);
    await runMigrations();
    // On Postgres any CREATE/ALTER/DROP moves the token, IF NOT EXISTS too:
    // each one waits for a lock behind the table's writers.
    const token = db.schemaToken();
    await runMigrations();
    expect(db.schemaToken()).toBe(token);
  });

  it.skipIf(onSqlite)("starts in a schema whose name needs quoting", async () => {
    await closeDb();
    const schemaName = `Vb-Quoted-${process.pid}`;
    const base = process.env["VAULTBASE_TEST_DB"]!;
    const admin = new SQL(base);
    await admin.unsafe(`CREATE SCHEMA "${schemaName}"`);
    try {
      await initDb(`${base}${base.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path="${schemaName}"`)}`);
      expect((await db.get<{ s: string }>(`SELECT current_schema() AS s`))!.s).toBe(schemaName);
      await runMigrations();
      await createCollection({ name: "notes", type: "base", fields: JSON.stringify([
        { name: "title", type: "text", options: { searchable: true } },
      ]), list_rule: null, view_rule: null, create_rule: null, update_rule: null, delete_rule: null });
      expect(await ftsColumns("notes")).toEqual(["title"]);
      await runMigrations();
    } finally {
      _resetCollectionCache();
      await closeDb();
      await admin.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
      await admin.close();
      await initDb(":memory:"); // for afterEach
    }
  });

  it("every declared default is a literal or the epoch expression", () => {
    for (const t of FIXED_TABLES) for (const c of columnSpecs(t)) {
      if (c.default) expect(["literal", "epochNow", "epochMsNow"]).toContain(c.default.kind);
    }
  });
});
