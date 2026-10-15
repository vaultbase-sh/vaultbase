/**
 * The fixed schema is generated from the drizzle declarations (db/ddl.ts)
 * and brought up to date at boot: tables created, missing columns added,
 * indexes created, one-off migrations recorded in vaultbase_migrations.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { onSqlite } from "./_helpers.ts";
import { closeDb, getRawClient, initDb } from "../db/client.ts";
import { runMigrations, runOnce } from "../db/migrate.ts";
import { columnSpecs, ensureFixedSchema, tableName } from "../db/ddl.ts";
import { FIXED_INDEXES, FIXED_TABLES } from "../db/fixed-schema.ts";
import { db } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import { _resetCollectionCache } from "../core/collections.ts";

beforeEach(async () => { await initDb(":memory:"); });
afterEach(async () => { _resetCollectionCache(); await closeDb(); });

const columnsOf = (table: string) =>
  (getRawClient().prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name);

describe.skipIf(!onSqlite)("fixed schema", () => {
  it("adds the columns an older database is missing, in the declared shape", async () => {
    // A v0.10-era collections table: no history_enabled, no view_query.
    getRawClient().exec(`CREATE TABLE vaultbase_collections (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, type TEXT NOT NULL DEFAULT 'base',
      fields TEXT NOT NULL DEFAULT '[]', list_rule TEXT, view_rule TEXT, create_rule TEXT,
      update_rule TEXT, delete_rule TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
    getRawClient().exec(`CREATE TABLE vaultbase_routes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', method TEXT NOT NULL, path TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
    getRawClient().exec(`INSERT INTO vaultbase_routes (id, method, path) VALUES ('r1', 'GET', '/x')`);
    await runMigrations();
    // Added columns land at the end, in declaration order: the set is what matters.
    expect(columnsOf("vaultbase_collections").sort()).toEqual(columnSpecs(schema.collections).map((c) => c.name).sort());
    expect(columnsOf("vaultbase_routes").sort()).toEqual(columnSpecs(schema.routes).map((c) => c.name).sort());
    const r = getRawClient().prepare(`SELECT require_auth, origin, file_path FROM vaultbase_routes WHERE id = 'r1'`).get() as Record<string, unknown>;
    expect(r).toEqual({ require_auth: 0, origin: "inline", file_path: null });
    const idx = getRawClient().prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_vaultbase_routes_file_path'`).get();
    expect(idx).not.toBeNull();
  });

  it("creates every declared table and index on a fresh database, and is idempotent", async () => {
    await ensureFixedSchema();
    const tables = new Set((getRawClient().prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>).map((t) => t.name));
    for (const t of FIXED_TABLES) expect(tables.has(tableName(t))).toBe(true);
    const indexes = new Set((getRawClient().prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as Array<{ name: string }>).map((t) => t.name));
    for (const ix of FIXED_INDEXES) expect(indexes.has(ix.name)).toBe(true);
    const token = db.schemaToken();
    await ensureFixedSchema();
    expect(db.schemaToken()).toBe(token);
  });

  it("refuses to add a missing column whose default is an expression", async () => {
    getRawClient().exec(`CREATE TABLE vaultbase_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    await expect(ensureFixedSchema()).rejects.toThrow(/vaultbase_settings\.updated_at/);
  });

  it("runOnce records a migration and runs it once per database", async () => {
    await runMigrations();
    let runs = 0;
    await runOnce("test_step", () => { runs++; });
    await runOnce("test_step", () => { runs++; });
    expect(runs).toBe(1);
    const keys = (getRawClient().prepare(`SELECT key FROM vaultbase_migrations ORDER BY key`).all() as Array<{ key: string }>).map((r) => r.key);
    expect(keys).toEqual(["test_step"]);
    await closeDb();
    await initDb(":memory:");
    await runMigrations();
    await runOnce("test_step", () => { runs++; });
    expect(runs).toBe(2);
  });

  it("every declared default is a literal or the epoch expression", () => {
    for (const t of FIXED_TABLES) for (const c of columnSpecs(t)) {
      if (c.default) expect(["literal", "epochNow", "epochMsNow"]).toContain(c.default.kind);
    }
  });
});
