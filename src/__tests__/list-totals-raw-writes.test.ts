/**
 * List totals after a write that doesn't say which table it touched: raw SQL
 * from a hook (`helpers.sql.exec`) or MCP `allow_write`. The totals cache
 * keys each count on the table's write version; a write nobody reports
 * doesn't move it. SQLite catches such writes through its change counter;
 * Postgres has none, so the count stayed at its old value.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { createRecord, listRecords } from "../core/records.ts";
import { createPublicCollection, onSqlite } from "./_helpers.ts";
import { rawWriteTarget } from "../db/postgres.ts";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  await createPublicCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
  await createRecord("posts", { title: "one" }, null);
  await createRecord("posts", { title: "two" }, null);
});
afterEach(() => closeDb());

const total = async () => (await listRecords("posts", { perPage: 1 })).totalItems;

describe("list totals follow raw writes", () => {
  it("an insert that reports no table", async () => {
    expect(await total()).toBe(2);
    await db.run(`INSERT INTO vb_posts (id, title, created_at, updated_at) VALUES ('raw-1', 'raw', 0, 0)`);
    expect(await total()).toBe(3);
  });

  it("a delete that reports no table", async () => {
    expect(await total()).toBe(2);
    await db.run(`DELETE FROM vb_posts WHERE title = 'one'`);
    expect(await total()).toBe(1);
  });

  it("a raw write inside a transaction, seen once it commits", async () => {
    expect(await total()).toBe(2);
    await db.transaction(async () => {
      await db.run(`INSERT INTO vb_posts (id, title, created_at, updated_at) VALUES ('raw-2', 'raw', 0, 0)`);
    });
    expect(await total()).toBe(3);
  });

  // SQLite has no writes inside a WITH.
  it.skipIf(onSqlite)("a write the driver can't tie to one table (a CTE returning rows)", async () => {
    expect(await total()).toBe(2);
    await db.all(`WITH d AS (DELETE FROM vb_posts WHERE title = 'one' RETURNING id) SELECT count(*) AS n FROM d`);
    expect(await total()).toBe(1);
  });

  it.skipIf(onSqlite)("a multi-statement exec() is reported", async () => {
    expect(await total()).toBe(2);
    await db.exec(`DELETE FROM vb_posts WHERE title = 'one'; DELETE FROM vb_posts WHERE title = 'two'`);
    expect(await total()).toBe(0);
  });

  it("a filtered total too", async () => {
    expect((await listRecords("posts", { perPage: 1, filter: "title = 'raw'" })).totalItems).toBe(0);
    await db.run(`INSERT INTO vb_posts (id, title, created_at, updated_at) VALUES ('raw-3', 'raw', 0, 0)`);
    expect((await listRecords("posts", { perPage: 1, filter: "title = 'raw'" })).totalItems).toBe(1);
  });
});

describe("rawWriteTarget (Postgres)", () => {
  it.each([
    ["INSERT INTO vb_posts (id) VALUES ('x')", "vb_posts"],
    [`insert into "vb_posts" values ('x')`, "vb_posts"],
    ["UPDATE ONLY vb_posts SET title = 'a'", "vb_posts"],
    [`UPDATE myschema."vb_posts" SET title = 'a'`, "vb_posts"],
    ["DELETE FROM vb_posts WHERE id = 'x'", "vb_posts"],
    ["TRUNCATE TABLE vb_posts", "vb_posts"],
    ["MERGE INTO vb_posts t USING (SELECT 1) s ON false WHEN NOT MATCHED THEN DO NOTHING", "vb_posts"],
    ["-- note\n/* more */ DELETE FROM vb_posts", "vb_posts"],
    ["WITH d AS (DELETE FROM vb_posts RETURNING id) SELECT count(*) FROM d", "*"],
    ["INSERT INTO vaultbase_settings (key, value) VALUES ('a', 'b')", null],
    ["UPDATE vaultbase_admin SET email = 'x'", null],
    ["SELECT * FROM vb_posts WHERE title = 'delete me'", null],
    ["SELECT 1", null],
    ["WITH t AS (SELECT 1) SELECT * FROM t", null],
    [`UPDATE "vb_Posts" SET title = 'a'`, "vb_Posts"],
    ["UPDATE VB_POSTS SET title = 'a'", "vb_posts"],
    ["TRUNCATE vb_a, vb_b", "*"],
    ["SET work_mem = '8MB'; DELETE FROM vb_posts", "*"],
    ["BEGIN; DELETE FROM vb_posts; COMMIT", "*"],
    ["DELETE FROM vb_posts;", "vb_posts"],
    ["SET work_mem = '8MB'; SELECT 1", null],
    ["TRUNCATE vb_a CASCADE", "*"],
    ["EXPLAIN ANALYZE DELETE FROM vb_posts", "*"],
    ["EXPLAIN SELECT * FROM vb_posts", null],
    ["COPY vb_posts FROM STDIN", "*"],
    ["COPY vb_posts TO STDOUT", null],
  ])("%s → %s", (sql, expected) => {
    expect(rawWriteTarget(sql)).toBe(expected);
  });
});
