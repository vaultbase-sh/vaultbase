/**
 * The database facade and the SQLite driver behind it (db/index.ts,
 * db/sqlite.ts): plain values on the SQLite path, write reporting, the
 * transaction and savepoint shapes, tracing, and the facade following a
 * reopened database.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, getRawClient, initDb } from "../db/client.ts";
import { db, getDriver } from "../db/index.ts";
import { _resetTableWrites, tableVersion, takeReportedChanges } from "../core/table-writes.ts";

beforeEach(() => {
  initDb(":memory:");
  db.exec(`CREATE TABLE t ("id" INTEGER PRIMARY KEY, "name" TEXT, "n" INTEGER DEFAULT 0)`);
  _resetTableWrites();
});
afterEach(() => {
  closeDb();
  _resetTableWrites();
});

describe("facade", () => {
  it("throws before initDb and after closeDb", () => {
    closeDb();
    expect(() => db.all("SELECT 1")).toThrow(/not initialized/);
    expect(() => getDriver()).toThrow(/not initialized/);
    initDb(":memory:");
    expect(db.name).toBe("sqlite");
  });

  it("follows a reopened database", () => {
    db.sync.run(`INSERT INTO t (name) VALUES (?)`, ["a"]);
    closeDb();
    initDb(":memory:");
    expect(db.sync.all(`SELECT name FROM sqlite_master WHERE name = 't'`)).toEqual([]);
  });

  it("exposes the dialect and capabilities", () => {
    expect(db.dialect.name).toBe("sqlite");
    expect(db.dialect.epochNow).toBe("unixepoch()");
    expect(db.dialect.columnType("number")).toBe("REAL");
    expect(db.dialect.columnType("bool")).toBe("INTEGER");
    expect(db.dialect.columnType("date")).toBe("INTEGER");
    expect(db.dialect.columnType("text")).toBe("TEXT");
    expect(db.dialect.quoteIdent('a"b')).toBe('"a""b"');
    expect(db.capabilities.fts).toBe("fts5");
    expect(db.capabilities.statementAtomicity).toBe(true);
  });
});

describe("SQLite driver", () => {
  it("returns plain values, not promises, on every call", () => {
    const run = db.run(`INSERT INTO t (name) VALUES (?)`, ["a"]);
    expect(run).not.toBeInstanceOf(Promise);
    expect((run as { changes: number }).changes).toBe(1);
    expect(db.all(`SELECT name FROM t`)).toEqual([{ name: "a" }]);
    expect(db.sync.get<{ name: string }>(`SELECT name FROM t WHERE id = ?`, [1])).toEqual({ name: "a" });
    expect(db.get(`SELECT name FROM t WHERE id = ?`, [99])).toBeNull();
    expect(db.describe(`SELECT id, name AS label FROM t`)).toEqual(["id", "label"]);
    expect(db.exec(`UPDATE t SET n = 1`)).toBeUndefined();
  });

  it("awaits uniformly", async () => {
    await db.run(`INSERT INTO t (name) VALUES (?)`, ["a"]);
    const rows = await db.all<{ name: string }>(`SELECT name FROM t`);
    expect(rows[0]?.name).toBe("a");
  });

  it("caches prepared statements and drops them on request and on close", () => {
    const before = db.preparedStatementCount();
    db.all(`SELECT 1 AS one`);
    db.all(`SELECT 1 AS one`);
    db.all(`SELECT 2 AS two`);
    expect(db.preparedStatementCount()).toBe(before + 2);
    db.invalidateStatements();
    expect(db.preparedStatementCount()).toBe(0);
    db.all(`SELECT 1 AS one`);
    const driver = getDriver();
    closeDb();
    expect(driver.preparedStatementCount()).toBe(0);
    initDb(":memory:");
  });

  it("evicts the oldest statement past the cap", () => {
    for (let i = 0; i < 300; i++) db.all(`SELECT ${i} AS v`);
    expect(db.preparedStatementCount()).toBe(256);
  });

  it("reports a write to its table, trigger rows included, and flushes outside a transaction", () => {
    db.exec(`CREATE TABLE audit (x INTEGER)`);
    db.exec(`CREATE TRIGGER t_ai AFTER INSERT ON t BEGIN INSERT INTO audit VALUES (new.id); END`);
    const v0 = tableVersion("t");
    takeReportedChanges();
    const r = db.sync.run(`INSERT INTO t (name) VALUES (?), (?)`, ["a", "b"], { table: "t" });
    // Two rows plus the two the trigger wrote; bun:sqlite counts the
    // trigger rows in `changes` as well, which the tracker never relied on.
    expect(r.trackedChanges).toBe(4);
    expect(tableVersion("t")).toBe(v0 + 1);
    expect(takeReportedChanges()).toBe(4);
    // Without a table nothing is reported and tracked equals changes.
    const plain = db.sync.run(`UPDATE t SET n = 2`);
    expect(plain.trackedChanges).toBe(plain.changes);
    expect(tableVersion("t")).toBe(v0 + 1);
    expect(takeReportedChanges()).toBe(0);
  });

  it("commits a transaction and rolls back on a throw", async () => {
    await db.transaction(async () => {
      db.run(`INSERT INTO t (name) VALUES ('in')`);
      expect(db.inTransaction).toBe(true);
    });
    expect(db.inTransaction).toBe(false);
    await expect(db.transaction(async () => {
      db.run(`INSERT INTO t (name) VALUES ('lost')`);
      throw new Error("boom");
    })).rejects.toThrow("boom");
    expect(db.inTransaction).toBe(false);
    expect(db.all(`SELECT name FROM t ORDER BY id`)).toEqual([{ name: "in" }]);
  });

  it("nests as a savepoint: an inner failure undoes only the inner work", async () => {
    await db.transaction(async () => {
      db.run(`INSERT INTO t (name) VALUES ('outer')`);
      await expect(db.transaction(async () => {
        db.run(`INSERT INTO t (name) VALUES ('inner')`);
        throw new Error("inner");
      })).rejects.toThrow("inner");
      expect(db.inTransaction).toBe(true);
      await db.savepoint(async () => { db.run(`INSERT INTO t (name) VALUES ('kept')`); });
    });
    expect(db.all(`SELECT name FROM t ORDER BY id`)).toEqual([{ name: "outer" }, { name: "kept" }]);
  });

  it("runs a synchronous transaction with no gap, nesting as a savepoint", () => {
    const seen: string[] = [];
    db.trace((sql) => seen.push(sql));
    const out = db.sync.transaction(() => {
      db.sync.run(`INSERT INTO t (name) VALUES ('s1')`);
      expect(() => db.sync.transaction(() => { db.sync.run(`INSERT INTO t (name) VALUES ('s2')`); throw new Error("inner"); })).toThrow("inner");
      return 42;
    }, { immediate: false });
    db.trace(null);
    expect(out).toBe(42);
    expect(seen).toEqual(["BEGIN", "INSERT INTO t (name) VALUES ('s1')", "SAVEPOINT vb_sp_1", "INSERT INTO t (name) VALUES ('s2')", "ROLLBACK TO vb_sp_1", "RELEASE vb_sp_1", "COMMIT"]);
    expect(db.sync.all(`SELECT name FROM t`)).toEqual([{ name: "s1" }]);
    expect(() => db.sync.transaction(() => { db.sync.run(`INSERT INTO t (name) VALUES ('s3')`); throw new Error("outer"); })).toThrow("outer");
    expect(db.inTransaction).toBe(false);
    expect(db.sync.all(`SELECT name FROM t`)).toEqual([{ name: "s1" }]);
  });

  it("a savepoint outside a transaction commits on its own", async () => {
    await db.savepoint(async () => { db.run(`INSERT INTO t (name) VALUES ('sp')`); });
    expect(db.inTransaction).toBe(false);
    expect(db.sync.get<{ name: string }>(`SELECT name FROM t`)).toEqual({ name: "sp" });
  });

  it("takes the write lock up front by default and defers it on request", async () => {
    const seen: string[] = [];
    db.trace((sql) => seen.push(sql));
    await db.transaction(async () => {});
    await db.transaction(async () => {}, { immediate: false });
    db.trace(null);
    expect(seen).toEqual(["BEGIN IMMEDIATE", "COMMIT", "BEGIN", "COMMIT"]);
  });

  it("traces every statement", () => {
    const seen: string[] = [];
    db.trace((sql) => seen.push(sql));
    db.all(`SELECT 1`);
    db.get(`SELECT 2`);
    db.run(`UPDATE t SET n = 3`);
    db.exec(`UPDATE t SET n = 4`);
    db.describe(`SELECT 5 AS five`);
    db.trace(null);
    db.all(`SELECT 6`);
    expect(seen).toEqual(["SELECT 1", "SELECT 2", "UPDATE t SET n = 3", "UPDATE t SET n = 4", "SELECT 5 AS five"]);
  });

  it("the schema token moves on DDL from any connection and not on data", () => {
    const t0 = db.schemaToken();
    db.run(`INSERT INTO t (name) VALUES (?)`, ["a"]);
    expect(db.schemaToken()).toBe(t0);
    getRawClient().exec(`ALTER TABLE t ADD COLUMN extra TEXT`);
    expect(db.schemaToken()).not.toBe(t0);
  });

  it("shares the connection with the raw client", () => {
    getRawClient().exec(`INSERT INTO t (name) VALUES ('raw')`);
    expect(db.sync.get<{ name: string }>(`SELECT name FROM t`)).toEqual({ name: "raw" });
  });
});
