/**
 * The Postgres driver (db/postgres.ts), through the facade and the test
 * harness in db/client.ts. Runs only when VAULTBASE_TEST_DB names a
 * Postgres server; every other suite file runs on it the same way, this
 * one checks the driver's own contract.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, getDb, initDb } from "../db/client.ts";
import { admin } from "../db/schema.ts";
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

  it("leaves jsonb's operators, E'' strings and tagged dollar quotes alone", () => {
    expect(toPositional(`SELECT d ?| ARRAY['a'], d ?& ARRAY['b'], ?`)).toBe(`SELECT d ?| ARRAY['a'], d ?& ARRAY['b'], $1`);
    expect(toPositional(`SELECT d ?? 'k', ?`)).toBe(`SELECT d ? 'k', $1`);
    expect(toPositional(`SELECT ?||'x'`)).toBe(`SELECT $1||'x'`);
    expect(toPositional(`SELECT E'it\\'s ?', ?`)).toBe(`SELECT E'it\\'s ?', $1`);
    expect(toPositional(`SELECT $fn$ ? $fn$, ?`)).toBe(`SELECT $fn$ ? $fn$, $1`);
    expect(toPositional(`SELECT name ? 'x' FROM t`, false)).toBe(`SELECT name ? 'x' FROM t`);
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
    ])).toBe(`CREATE TABLE IF NOT EXISTS x (\n  id text PRIMARY KEY,\n  at bigint NOT NULL DEFAULT (extract(epoch from now())::bigint),\n  kind text NOT NULL DEFAULT 'a''b',\n  score double precision\n)`);
    expect(d.createIndex({ name: "i", table: "x", columns: ["kind", "at DESC"], unique: true, where: "at > 0" })).toBe(`CREATE UNIQUE INDEX IF NOT EXISTS i ON x(kind, at DESC) WHERE at > 0`);
    expect(d.jsonExtract(`"t"."meta"`, "$.a")).toBe(`("t"."meta"::jsonb #>> '{a}')`);
    // A path is one `#>>`, so a step through a string reads as missing instead of failing to parse it.
    expect(d.jsonExtract(d.jsonExtract(`"t"."meta"`, "$.a"), "$.b")).toBe(`("t"."meta"::jsonb #>> '{a,b}')`);
  });
});

describe.if(onPg)("jsonb operators on Postgres", () => {
  beforeEach(async () => { await initDb(":memory:"); await runMigrations(); });
  afterEach(async () => { await closeDb(); });

  it("run as written without parameters, and as ?? with them", async () => {
    expect((await db.get<{ r: boolean }>(`SELECT '{"a":1}'::jsonb ? 'a' AS r`))!.r).toBe(true);
    expect((await db.get<{ r: boolean }>(`SELECT '{"a":1}'::jsonb ?| ARRAY['a','b'] AS r`))!.r).toBe(true);
    const row = (await db.get<{ r: boolean; n: number }>(`SELECT '{"a":1}'::jsonb ?? 'b' AS r, ?::integer AS n`, [5]))!;
    expect(row).toEqual({ r: false, n: 5 });
  });
});

describe.if(onPg)("drizzle on Postgres", () => {
  beforeEach(async () => { await initDb(":memory:"); await runMigrations(); });
  afterEach(async () => { await closeDb(); });

  // Drizzle ran on the bare pool: a write inside a transaction committed on
  // another connection and outlived the rollback (history rows of a failed
  // batch, revocations), and bigint columns came back as BigInt.
  it("writes inside the current transaction, and rolls back with it", async () => {
    await expect(db.transaction(async () => {
      await getDb().insert(admin).values({ id: "a1", email: "a@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
      expect((await db.get<{ n: number }>(`SELECT count(*) AS n FROM vaultbase_admin`))!.n).toBe(1);
      throw new Error("undo");
    })).rejects.toThrow("undo");
    expect(await getDb().select().from(admin)).toEqual([]);
  });

  it("returns bigint columns as numbers", async () => {
    const later = Date.UTC(2040, 0, 1) / 1000;
    await getDb().insert(admin).values({ id: "a1", email: "a@test.local", password_hash: "x", password_reset_at: later, created_at: 0 });
    const [row] = await getDb().select().from(admin);
    expect(row!.password_reset_at).toBe(later);
    expect(JSON.stringify(row)).toContain(String(later));
  });
});

describe.if(onPg)("metrics on Postgres", () => {
  beforeEach(async () => { await initDb(":memory:"); await runMigrations(); });
  afterEach(async () => { await closeDb(); });

  it("reports the database size and connections, and no SQLite block", async () => {
    const { makeMetricsPlugin } = await import("../api/metrics.ts");
    const { signAuthToken } = await import("../core/sec.ts");
    const { getDb } = await import("../db/client.ts");
    const { admin } = await import("../db/schema.ts");
    await getDb().insert(admin).values({ id: "a1", email: "m@test.local", password_hash: "x" });
    const { token } = await signAuthToken({ payload: { id: "a1", email: "m@test.local" }, audience: "admin", expiresInSeconds: 60, jwtSecret: "s" });
    const res = await makeMetricsPlugin("s").handle(new Request("http://localhost/_/metrics", { headers: { authorization: `Bearer ${token}` } }));
    const body = await res.json() as { sqlite: unknown; database: { driver: string; size_bytes: number; connections: { total: number } } };
    expect(body.sqlite).toBeNull();
    expect(body.database.driver).toBe("postgres");
    expect(body.database.size_bytes).toBeGreaterThan(0);
    expect(body.database.connections.total).toBeGreaterThan(0);
  });
});
