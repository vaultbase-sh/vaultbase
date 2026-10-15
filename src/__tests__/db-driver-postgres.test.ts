/**
 * The Postgres driver (db/postgres.ts), through the facade and the test
 * harness in db/client.ts. Runs only when VAULTBASE_TEST_DB names a
 * Postgres server; every other suite file runs on it the same way, this
 * one checks the driver's own contract.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, initDb } from "../db/client.ts";
import { db, getDriver } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { PostgresDriver } from "../db/postgres.ts";
import { toPositional } from "../db/placeholders.ts";
import { _resetTableWrites, tableVersion } from "../core/table-writes.ts";

const PG = process.env["VAULTBASE_TEST_DB"];
const onPg = !!PG && /^postgres/i.test(PG);

describe("placeholders", () => {
  it("rewrites ? to $n outside strings, identifiers and comments", () => {
    expect(toPositional(`SELECT * FROM t WHERE a = ? AND b = ?`)).toBe(`SELECT * FROM t WHERE a = $1 AND b = $2`);
    expect(toPositional(`SELECT '?', "col?", ? -- ?\n, /* ? */ ?`)).toBe(`SELECT '?', "col?", $1 -- ?\n, /* ? */ $2`);
    expect(toPositional(`SELECT 'it''s ?', ?`)).toBe(`SELECT 'it''s ?', $1`);
    expect(toPositional(`SELECT $$ ? $$, ?`)).toBe(`SELECT $$ ? $$, $1`);
  });
});

describe.if(onPg)("Postgres driver", () => {
  beforeEach(async () => {
    await initDb(":memory:");
    _resetTableWrites();
  });
  afterEach(async () => {
    await closeDb();
    _resetTableWrites();
  });

  it("opens a fresh schema per database, migrates it and drops it on close", async () => {
    expect(db.name).toBe("postgres");
    await runMigrations();
    const tables = await db.all<{ name: string }>(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()`);
    expect(tables.map((t) => t.name)).toContain("vaultbase_collections");
    const schema = (await db.get<{ s: string }>(`SELECT current_schema() AS s`))!.s;
    expect(schema).toMatch(/^vb_test_/);
    await closeDb();
    const probe = new PostgresDriver(PG!, { max: 1 });
    try {
      const left = await probe.all<{ n: string }>(`SELECT nspname AS n FROM pg_namespace WHERE nspname = ?`, [schema]);
      expect(left).toEqual([]);
    } finally { probe.close(); }
    await initDb(":memory:"); // for afterEach
  });

  it("all, get, run and describe", async () => {
    await db.exec(`CREATE TABLE t ("id" text PRIMARY KEY, "name" text, "n" integer DEFAULT 0)`);
    const r = await db.run(`INSERT INTO t ("id", "name") VALUES (?, ?), (?, ?)`, ["a", "x", "b", "y"], { table: "t" });
    expect(r.changes).toBe(2);
    expect(tableVersion("t")).toBe(1);
    expect(await db.all(`SELECT "name" FROM t ORDER BY "id"`)).toEqual([{ name: "x" }, { name: "y" }]);
    expect(await db.get<{ name: string }>(`SELECT "name" FROM t WHERE "id" = ?`, ["b"])).toEqual({ name: "y" });
    expect(await db.get(`SELECT "name" FROM t WHERE "id" = ?`, ["zz"])).toBeNull();
    expect(await db.describe(`SELECT "id", "name" AS label FROM t WHERE FALSE`)).toEqual(["id", "label"]);
    expect((await db.run(`UPDATE t SET "n" = 5`)).changes).toBe(2);
  });

  it("transactions pin a connection and savepoints undo only their part", async () => {
    await db.exec(`CREATE TABLE t ("id" text PRIMARY KEY)`);
    await db.transaction(async () => {
      expect(db.inTransaction).toBe(true);
      await db.run(`INSERT INTO t VALUES (?)`, ["outer"]);
      await expect(db.transaction(async () => {
        await db.run(`INSERT INTO t VALUES (?)`, ["inner"]);
        throw new Error("inner");
      })).rejects.toThrow("inner");
      await db.savepoint(async () => { await db.run(`INSERT INTO t VALUES (?)`, ["kept"]); });
    });
    expect(db.inTransaction).toBe(false);
    expect((await db.all<{ id: string }>(`SELECT "id" FROM t ORDER BY "id"`)).map((r) => r.id)).toEqual(["kept", "outer"]);
    await expect(db.transaction(async () => {
      await db.run(`INSERT INTO t VALUES (?)`, ["lost"]);
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect((await db.all(`SELECT "id" FROM t WHERE "id" = ?`, ["lost"]))).toEqual([]);
  });

  it("the schema token moves on this process's DDL and sync is refused", async () => {
    const t0 = db.schemaToken();
    await db.exec(`CREATE TABLE t2 ("id" text)`);
    expect(db.schemaToken()).toBe(t0 + 1);
    expect(() => db.sync.all(`SELECT 1`)).toThrow(/not available on Postgres/);
    expect(getDriver().capabilities.fts).toBe("tsvector");
  });

  it("the dialect renders the fixed-table DDL for Postgres", () => {
    const d = db.dialect;
    expect(d.createTable("x", [
      { name: "id", type: "text", primaryKey: true, notNull: true, unique: false },
      { name: "at", type: "integer", primaryKey: false, notNull: true, unique: false, default: { kind: "epochNow" } },
      { name: "kind", type: "text", primaryKey: false, notNull: true, unique: false, default: { kind: "literal", value: "a'b" } },
      { name: "score", type: "real", primaryKey: false, notNull: false, unique: false },
    ])).toBe(`CREATE TABLE IF NOT EXISTS x (\n  id text PRIMARY KEY,\n  at integer NOT NULL DEFAULT (extract(epoch from now())::integer),\n  kind text NOT NULL DEFAULT 'a''b',\n  score double precision\n)`);
    expect(d.createIndex({ name: "i", table: "x", columns: ["kind", "at DESC"], unique: true, where: "at > 0" })).toBe(`CREATE UNIQUE INDEX IF NOT EXISTS i ON x(kind, at DESC) WHERE at > 0`);
    expect(d.jsonExtract(`"t"."meta"`, "$.a")).toBe(`("t"."meta"::jsonb #>> '{a}')`);
  });
});
