import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, closeDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createRecord, deleteRecord, listRecords , _countCacheStats } from "../core/records.ts";
import { createPublicCollection } from "./_helpers.ts";

// Deep pages fetch rowids first; totals come from a cache keyed on the
// database version. Both must return exactly what the plain queries would.

let dir: string;
let dbPath: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "vb-list-"));
  dbPath = join(dir, "data.db");
  initDb(`file:${dbPath}`);
  await runMigrations();
});

afterEach(() => {
  closeDb();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: cached statements hold the file */ }
});

/** Bulk rows with few distinct sort values, so ties cross page edges. */
function seed(table: string, n: number, cols = `"n", "status"`): void {
  const c = getRawClient();
  const ins = c.prepare(`INSERT INTO ${table} ("id", ${cols}, "created_at", "updated_at") VALUES (?, ?, ?, 1700000000, 1700000000)`);
  c.transaction(() => {
    for (let i = 0; i < n; i++) ins.run(crypto.randomUUID(), i % 7, i % 3 === 0 ? "published" : "draft");
  })();
}

async function allPages(collection: string, opts: { sort?: string; filter?: string }, perPage: number): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 1; ; page++) {
    const r = await listRecords(collection, { ...opts, page, perPage, skipTotal: true });
    ids.push(...r.data.map((x) => x.id));
    if (r.data.length < perPage) return ids;
  }
}

describe("deep pages (rowid first)", () => {
  const fields = JSON.stringify([{ name: "n", type: "number" }, { name: "status", type: "text" }]);

  it("pages past the threshold match one full ordered scan, ties included", async () => {
    await createPublicCollection({ name: "items", fields });
    seed("vb_items", 4200);
    const c = getRawClient();
    const cases: Array<{ sort?: string; filter?: string; sql: string }> = [
      { sql: `SELECT id FROM vb_items ORDER BY created_at DESC, rowid DESC` },
      { sort: "n", sql: `SELECT id FROM vb_items ORDER BY n ASC, rowid ASC` },
      { sort: "-n,created", sql: `SELECT id FROM vb_items ORDER BY n DESC, created_at ASC, rowid ASC` },
      { filter: "status='draft'", sql: `SELECT id FROM vb_items WHERE status = 'draft' ORDER BY created_at DESC, rowid DESC` },
    ];
    for (const { sql, ...opts } of cases) {
      const want = (c.prepare(sql).all() as Array<{ id: string }>).map((r) => r.id);
      const got = await allPages("items", opts, 100);
      expect(got.length).toBe(want.length);
      expect(got).toEqual(want);
    }
  });

  it("works when a field is named rowid", async () => {
    await createPublicCollection({ name: "odd", fields: JSON.stringify([{ name: "rowid", type: "number" }, { name: "n", type: "number" }, { name: "status", type: "text" }]) });
    seed("vb_odd", 3500, `"rowid", "status"`);
    const want = (getRawClient().prepare(`SELECT id FROM vb_odd ORDER BY created_at DESC, _rowid_ DESC`).all() as Array<{ id: string }>).map((r) => r.id);
    expect(await allPages("odd", {}, 500)).toEqual(want);
  });
});

describe("list totals cache", () => {
  const fields = JSON.stringify([{ name: "n", type: "number" }, { name: "status", type: "text" }]);
  const total = async (filter?: string) => (await listRecords("items", { perPage: 1, ...(filter ? { filter } : {}) })).totalItems;

  beforeEach(async () => {
    await createPublicCollection({ name: "items", fields });
    seed("vb_items", 30);
  });

  it("keys on the filter values", async () => {
    expect(await total("status='published'")).toBe(10);
    expect(await total("status='draft'")).toBe(20);
    expect(await total()).toBe(30);
  });

  it("follows record API writes", async () => {
    expect(await total("status='published'")).toBe(10);
    const rec = await createRecord("items", { n: 1, status: "published" });
    expect(await total("status='published'")).toBe(11);
    await deleteRecord("items", rec.id);
    expect(await total("status='published'")).toBe(10);
  });

  it("follows raw SQL writes on the same connection", async () => {
    expect(await total()).toBe(30);
    getRawClient().exec(`DELETE FROM vb_items WHERE status = 'draft'`);
    expect(await total()).toBe(10);
  });

  it("follows commits from another connection", async () => {
    expect(await total()).toBe(30);
    const other = new Database(dbPath);
    other.exec(`DELETE FROM vb_items WHERE n = 0`);
    other.close();
    expect(await total()).toBe(30 - Math.ceil(30 / 7));
  });

  it("a write to another collection keeps this collection's totals cached", async () => {
    await createPublicCollection({ name: "other", fields });
    expect(await total("status='published'")).toBe(10);
    let before = _countCacheStats();
    expect(await total("status='published'")).toBe(10);
    expect(_countCacheStats().hits).toBe(before.hits + 1);
    await createRecord("other", { n: 1, status: "published" });
    before = _countCacheStats();
    expect(await total("status='published'")).toBe(10);
    expect(_countCacheStats()).toEqual({ hits: before.hits + 1, misses: before.misses });
    // The written collection itself is recounted.
    await createRecord("items", { n: 1, status: "published" });
    before = _countCacheStats();
    expect(await total("status='published'")).toBe(11);
    expect(_countCacheStats().misses).toBe(before.misses + 1);
  });

  it("a write nobody reported (raw SQL) empties every collection's totals", async () => {
    await createPublicCollection({ name: "other", fields });
    expect(await total()).toBe(30);
    expect((await listRecords("other", { perPage: 1 })).totalItems).toBe(0);
    getRawClient().exec(`INSERT INTO vb_other ("id", "n", "status") VALUES ('x', 1, 'draft')`);
    const before = _countCacheStats();
    expect(await total()).toBe(30);
    expect((await listRecords("other", { perPage: 1 })).totalItems).toBe(1);
    expect(_countCacheStats().misses).toBe(before.misses + 2);
  });

  it("does not keep a total seen inside a transaction that rolls back", async () => {
    expect(await total()).toBe(30);
    const c = getRawClient();
    c.exec("BEGIN");
    c.exec(`DELETE FROM vb_items`);
    expect(await total()).toBe(0);
    c.exec("ROLLBACK");
    expect(await total()).toBe(30);
  });
});
