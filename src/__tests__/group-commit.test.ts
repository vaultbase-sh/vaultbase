import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { onSqlite } from "./_helpers.ts";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDb, getRawClient, initDb } from "../db/client.ts";
import { afterCommit, withExclusiveWrite, withSharedWrite } from "../core/write-gate.ts";
import { groupCommitOpen } from "../core/group-commit.ts";

let dir = "";
let file = "";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "vb-gc-"));
  file = join(dir, "data.db");
  await initDb(file);
  getRawClient().exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT UNIQUE)");
});

afterEach(async () => {
  await closeDb();
  rmSync(dir, { recursive: true, force: true });
});

/** A second connection: sees only what is committed. */
function outside<T>(fn: (d: Database) => T): T {
  const d = new Database(file, { readonly: true });
  try { return fn(d); } finally { d.close(); }
}
const committedCount = () => outside((d) => (d.query("SELECT count(*) AS n FROM t").get() as { n: number }).n);

const insert = (v: string) => withSharedWrite(async () => {
  getRawClient().query("INSERT INTO t (v) VALUES (?)").run(v);
});

describe.skipIf(!onSqlite)("group commit", () => {
  test("concurrent writes share one transaction and are committed when they return", async () => {
    const commits: number[] = [];
    const writes = Array.from({ length: 20 }, (_, i) => insert(`v${i}`).then(() => commits.push(committedCount())));
    // All 20 joined the same open group before any of them returned.
    expect(groupCommitOpen()).toBe(true);
    await Promise.all(writes);
    // Every write saw all 20 committed by the time it returned.
    expect(commits.every((n) => n === 20)).toBe(true);
    expect(groupCommitOpen()).toBe(false);
  });

  test("a failing write only undoes itself, the rest of the group commits", async () => {
    await insert("taken");
    const results = await Promise.allSettled([insert("a"), insert("taken"), insert("b")]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(outside((d) => d.query("SELECT v FROM t ORDER BY v").all().map((r) => (r as { v: string }).v)))
      .toEqual(["a", "b", "taken"]);
  });

  test("if the COMMIT fails, every write in the group fails and nothing is kept", async () => {
    const c = getRawClient();
    // A deferred foreign key is only checked at COMMIT.
    c.exec("PRAGMA foreign_keys = ON");
    c.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
    c.exec("CREATE TABLE child (id INTEGER PRIMARY KEY, p INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)");
    const ok = insert("fine");
    const bad = withSharedWrite(async () => { c.query("INSERT INTO child (p) VALUES (999)").run(); });
    const results = await Promise.allSettled([ok, bad]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(committedCount()).toBe(0);
    expect(c.inTransaction).toBe(false);
  });

  test("side effects wait for the commit", async () => {
    const seen: number[] = [];
    await withSharedWrite(async () => {
      getRawClient().query("INSERT INTO t (v) VALUES ('x')").run();
      afterCommit(() => seen.push(committedCount()));
      expect(seen).toEqual([]); // not yet: the group is still open
    });
    expect(seen).toEqual([1]);
  });

  test("a batch commits the open group before its own BEGIN", async () => {
    const pending = insert("before-batch");
    const batch = withExclusiveWrite(async (tx) => {
      const c = getRawClient();
      expect(c.inTransaction).toBe(false); // group already committed
      c.exec("BEGIN");
      c.query("INSERT INTO t (v) VALUES ('in-batch')").run();
      c.exec("COMMIT");
      tx.commit();
    });
    await Promise.all([pending, batch]);
    expect(committedCount()).toBe(2);
  });

  test("VAULTBASE_GROUP_COMMIT=0 writes in autocommit", async () => {
    process.env["VAULTBASE_GROUP_COMMIT"] = "0";
    try {
      const w = insert("solo");
      expect(groupCommitOpen()).toBe(false);
      await w;
      expect(committedCount()).toBe(1);
    } finally {
      delete process.env["VAULTBASE_GROUP_COMMIT"];
    }
  });
});
