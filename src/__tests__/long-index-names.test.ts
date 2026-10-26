/**
 * Index names built from long collection and field names. Postgres cuts a
 * name to 63 bytes, so `idx_vb_<60 chars>_created_at` and `..._updated_at`
 * were one name: the second index was silently skipped, a rename mapped
 * nothing, and an admin index came back under a name that didn't exist.
 * Names that don't fit now end in a short hash (db.dialect.fitIdent). The
 * table name itself can't be fitted, so Postgres refuses a collection name
 * past 60 characters.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, initDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import {
  createCollection, getCollection, updateCollection, CollectionValidationError, _resetCollectionCache,
} from "../core/collections.ts";
import { createRecord, listRecords } from "../core/records.ts";
import { createCollectionIndex } from "../api/indexes.ts";
import { aggregateRecords } from "../core/aggregate.ts";
import { onSqlite } from "./_helpers.ts";

const F = (fields: object[]) => JSON.stringify(fields);
const open = { list_rule: null, view_rule: null, create_rule: null, update_rule: null, delete_rule: null };

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
});
afterEach(async () => {
  _resetCollectionCache();
  await closeDb();
});

/** The server's index names on one table → their columns (tie-break tail left out). */
async function indexesOf(table: string): Promise<Map<string, string[]>> {
  const tail = new Set(db.dialect.indexTail.map((c) => c.replace(/"/g, "")));
  const out = new Map<string, string[]>();
  for (const r of await db.all<{ name: string; sql: string | null }>(db.dialect.listIndexesSql(), [table])) {
    // The server's own; not the primary key's (Postgres lists it).
    if (!r.sql || !/^(idx|uq|uniq)_/.test(r.name)) continue;
    const on = r.sql.search(/\bON\b/i);
    const inner = r.sql.slice(r.sql.indexOf("(", on) + 1, r.sql.indexOf(")", on));
    let cols = inner.split(",").map((c) => c.trim().replace(/^"(.*)"$/, "$1"));
    while (cols.length > 1 && tail.has(cols[cols.length - 1]!)) cols = cols.slice(0, -1);
    out.set(r.name, cols);
  }
  return out;
}

/** The single-column indexes of a table, as a set of their columns. */
const indexedColumns = async (table: string) =>
  new Set([...(await indexesOf(table)).values()].filter((c) => c.length === 1).map((c) => c[0]!));

// The longest collection names Postgres takes: `vb_` + 60 = 63 bytes.
const A = "a".repeat(60);
const B = "b".repeat(60);
const REL = "r".repeat(60);

/**
 * A collection with a relation and a unique field. Unique is turned on after
 * creation: a field created unique gets an inline constraint, not the named
 * `uq_` index under test.
 */
async function longCollection(name: string) {
  if (!(await getCollection("target"))) {
    await createCollection({ name: "target", type: "base", fields: F([{ name: "t", type: "text" }]), ...open });
  }
  const fields = (unique: boolean) => F([
    { name: "title", type: "text", options: { unique } },
    { name: REL, type: "relation", collection: "target" },
  ]);
  const col = await createCollection({ name, type: "base", fields: fields(false), ...open });
  return updateCollection(col.id, { fields: fields(true) });
}

/** A short-named collection with a unique field, the same way. */
async function posts() {
  const col = await createCollection({ name: "posts", type: "base", fields: F([{ name: "title", type: "text" }]), ...open });
  return updateCollection(col.id, { fields: F([{ name: "title", type: "text", options: { unique: true } }]) });
}

describe("long index names", () => {
  it("a 60-character collection gets every index it should", async () => {
    await longCollection(A);
    const cols = await indexedColumns(`vb_${A}`);
    for (const c of ["created_at", "updated_at", "title", REL]) expect(cols.has(c)).toBe(true);
    // Postgres would cut a longer one; SQLite keeps names whole.
    if (!onSqlite) for (const name of (await indexesOf(`vb_${A}`)).keys()) expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
  });

  it("names that fit are unchanged", async () => {
    await posts();
    expect([...(await indexesOf("vb_posts")).keys()].sort()).toEqual(
      ["idx_vb_posts_created_at", "idx_vb_posts_updated_at", "uq_vb_posts_title"].sort(),
    );
  });

  it("a rename between long names keeps every index, and the old name can be used again", async () => {
    const col = await longCollection(A);
    const before = await indexedColumns(`vb_${A}`);
    await updateCollection(col.id, { name: B });
    expect(await indexedColumns(`vb_${B}`)).toEqual(before);
    // Nothing on the renamed table still carries the old collection's prefix.
    for (const name of (await indexesOf(`vb_${B}`)).keys()) expect(name.includes("a".repeat(20))).toBe(false);
    // A new collection by the old name gets its own indexes, not none.
    await longCollection(A);
    expect(await indexedColumns(`vb_${A}`)).toEqual(before);
    // And a restart finds nothing to do.
    const token = db.schemaToken();
    await runMigrations();
    expect(db.schemaToken()).toBe(token);
  });

  it("a rename from a short name to a long one and back", async () => {
    const col = await posts();
    await createRecord("posts", { title: "x" });
    await updateCollection(col.id, { name: A });
    expect(await indexedColumns(`vb_${A}`)).toEqual(new Set(["created_at", "updated_at", "title"]));
    await updateCollection(col.id, { name: "posts" });
    expect([...(await indexesOf("vb_posts")).keys()].sort()).toEqual(
      ["idx_vb_posts_created_at", "idx_vb_posts_updated_at", "uq_vb_posts_title"].sort(),
    );
    expect((await listRecords("posts")).totalItems).toBe(1);
  });

  it("toggling unique off on a long-named collection drops its index", async () => {
    const col = await longCollection(A);
    await updateCollection(col.id, { fields: F([
      { name: "title", type: "text" },
      { name: REL, type: "relation", collection: "target" },
    ]) });
    expect((await indexedColumns(`vb_${A}`)).has("title")).toBe(false);
    // Duplicates are allowed again.
    await createRecord(A, { title: "same" });
    await createRecord(A, { title: "same" });
  });

  it("admin indexes whose names differ past 63 bytes are both made, under the names returned", async () => {
    const f1 = "f".repeat(30) + "_one";
    const f2 = "f".repeat(30) + "_two";
    await createCollection({ name: A, type: "base", fields: F([
      { name: "lead", type: "text" }, { name: f1, type: "text" }, { name: f2, type: "text" },
    ]), ...open });
    const col = (await getCollection(A))!;
    const one = await createCollectionIndex(col, ["lead", f1]);
    const two = await createCollectionIndex(col, ["lead", f2]);
    expect(one.name).not.toBe(two.name);
    const have = await indexesOf(`vb_${A}`);
    expect(have.get(one.name)).toEqual(["lead", f1]);
    expect(have.get(two.name)).toEqual(["lead", f2]);
  });

  it("a longer collection name: refused on Postgres, whose table name it would cut; kept on SQLite", async () => {
    const long = "c".repeat(61);
    const short = await createCollection({ name: "short", type: "base", fields: F([]), ...open });
    if (onSqlite) {
      await createCollection({ name: long, type: "base", fields: F([]), ...open });
      await updateCollection(short.id, { name: "d".repeat(63) });
      return;
    }
    await expect(createCollection({ name: long, type: "base", fields: F([]), ...open })).rejects.toThrow(CollectionValidationError);
    await expect(updateCollection(short.id, { name: long })).rejects.toThrow(CollectionValidationError);
    expect(await getCollection(long)).toBeNull();
    expect(await getCollection("short")).not.toBeNull();
  });

  it("an aggregate over a long field comes back under its full key", async () => {
    const field = "m".repeat(60);
    await createCollection({ name: "sales", type: "base", fields: F([{ name: "region", type: "text" }, { name: field, type: "number" }]), ...open });
    await createRecord("sales", { region: "n", [field]: 2 });
    await createRecord("sales", { region: "n", [field]: 3 });
    const res = await aggregateRecords((await getCollection("sales"))!, { agg: `sum(${field}),count`, groupBy: "region", sort: `-sum_${field}` });
    expect(res.data).toEqual([{ region: "n", [`sum_${field}`]: 5, count: 2 }]);
  });

  it("an auth collection with a long name keeps its unique email index across a rename", async () => {
    const col = await createCollection({ name: A, type: "auth", fields: F([]), ...open });
    await updateCollection(col.id, { name: B });
    expect((await indexedColumns(`vb_${B}`)).has("email")).toBe(true);
  });
});

describe.skipIf(onSqlite)("long index names made by earlier releases (Postgres)", () => {
  /** Drop the server's indexes on `table`, then make `defs` as an earlier release named them. */
  async function asEarlierRelease(table: string, defs: string[]) {
    for (const name of (await indexesOf(table)).keys()) await db.exec(`DROP INDEX "${name}"`);
    for (const d of defs) await db.exec(d);
  }

  it("renames indexes whose names Postgres cut, once, and makes the ones the cut lost", async () => {
    await longCollection(A);
    await createCollection({ name: B, type: "auth", fields: F([]), ...open });
    const table = `vb_${A}`;
    // An earlier release: every idx_vb_<A>_* name cut to the same 63 bytes,
    // so only the first (created_at) was made; uq_ cut to a name of its own.
    await asEarlierRelease(table, [
      `CREATE INDEX "idx_${table}_created_at" ON "${table}" ("created_at", "id")`,
      `CREATE UNIQUE INDEX "uq_${table}_title" ON "${table}" ("title")`,
    ]);
    // A long auth collection: created_at's index took the email index's name.
    await asEarlierRelease(`vb_${B}`, [`CREATE INDEX "idx_vb_${B}_created_at" ON "vb_${B}" ("created_at", "id")`]);
    await db.exec(`DELETE FROM vaultbase_migrations WHERE key = 'v0_29_0_fit_index_names'`);
    _resetCollectionCache();

    await runMigrations();
    const after = await indexesOf(table);
    expect(new Set([...after.values()].map((c) => c[0]))).toEqual(new Set(["created_at", "updated_at", "title", REL]));
    // One index per column: renamed, not duplicated.
    expect(after.size).toBe(4);
    for (const name of after.keys()) expect(name).toBe(db.dialect.fitIdent(name.startsWith("uq_") ? `uq_${table}_title` : `idx_${table}_${after.get(name)![0]}`));
    // The renamed unique index still holds.
    await createRecord(A, { title: "same" });
    await expect(createRecord(A, { title: "same" })).rejects.toThrow();
    // The auth collection has its unique email index again.
    expect((await indexedColumns(`vb_${B}`)).has("email")).toBe(true);

    // Once: a later start changes nothing.
    const token = db.schemaToken();
    await runMigrations();
    expect(db.schemaToken()).toBe(token);
  });

  it("a 52-character collection: each cut name was its own, and each is renamed", async () => {
    const name = "e".repeat(52);
    const table = `vb_${name}`;
    await createCollection({ name: "target", type: "base", fields: F([{ name: "t", type: "text" }]), ...open });
    const fields = (unique: boolean) => F([
      { name: "title", type: "text", options: { unique, searchable: true } },
      { name: "tags", type: "text", options: { unique } },
      { name: "owner", type: "relation", collection: "target" },
    ]);
    const col = await createCollection({ name, type: "base", fields: fields(false), ...open });
    await updateCollection(col.id, { fields: fields(true) });
    const admin = await createCollectionIndex((await getCollection(name))!, ["title", "owner"]);
    const fitted = new Map([...(await indexesOf(table))].map(([n, c]) => [c.join(","), n]));
    expect(fitted.size).toBe(7); // timestamps, owner, title, tags, search, the admin's
    // Each under the name an earlier release gave it: in full, cut by Postgres.
    for (const [cols, n] of fitted) {
      const base = n === admin.name ? `idx_${name}_title_owner`
        : cols === "vb_search" ? `idx_${table}_search`
        : n.startsWith("uq_") ? `uq_${table}_${cols}` : `idx_${table}_${cols}`;
      if (base !== n) await db.exec(`ALTER INDEX "${n}" RENAME TO "${base}"`); // uq_…_tags fits: 63 bytes
    }
    await db.exec(`DELETE FROM vaultbase_migrations WHERE key = 'v0_29_0_fit_index_names'`);
    _resetCollectionCache();

    await runMigrations();
    const after = new Map([...(await indexesOf(table))].map(([n, c]) => [c.join(","), n]));
    expect(after).toEqual(fitted);
    expect((await listRecords(name, { search: "x" })).totalItems).toBe(0);
  });

  it("two unique fields on a 60-character collection: the lost index is made, or reported when data has duplicates", async () => {
    const name = "u".repeat(60);
    const table = `vb_${name}`;
    const fields = (unique: boolean) => F([{ name: "x", type: "text", options: { unique } }, { name: "y", type: "text", options: { unique } }]);
    const col = await createCollection({ name, type: "base", fields: fields(false), ...open });
    await updateCollection(col.id, { fields: fields(true) });
    // An earlier release made only x's: uq_vb_<60>_x and _y cut to one name.
    await asEarlierRelease(table, [
      `CREATE INDEX "idx_${table}_created_at" ON "${table}" ("created_at", "id")`,
      `CREATE UNIQUE INDEX "uq_${table}_x" ON "${table}" ("x")`,
    ]);
    // Without its index, duplicates got in (written past the server here).
    await db.exec(`INSERT INTO "${table}" (id, x, y, created_at, updated_at) VALUES ('r1', 'a', 'same', 1, 1), ('r2', 'b', 'same', 1, 1)`);
    await db.exec(`DELETE FROM vaultbase_migrations WHERE key = 'v0_29_0_fit_index_names'`);
    _resetCollectionCache();

    const logged: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };
    try { await runMigrations(); } finally { console.error = orig; }
    expect(logged.some((l) => l.includes(`'${name}.y'`))).toBe(true);
    expect((await indexedColumns(table)).has("y")).toBe(false);

    // Duplicates resolved, the next migration-free path still makes it: toggling.
    await db.exec(`UPDATE "${table}" SET y = 'other' WHERE id = 'r2'`);
    await db.exec(`DELETE FROM vaultbase_migrations WHERE key = 'v0_29_0_fit_index_names'`);
    await runMigrations();
    expect(await indexedColumns(table)).toEqual(new Set(["created_at", "updated_at", "x", "y"]));
  });

  it("a 62-character collection made by an earlier release keeps working, and a start changes nothing", async () => {
    const name = "z".repeat(62);
    // Now refused; an earlier release made it. Its table name, cut, is vb_ + 60.
    const col = await createCollection({ name: "short", type: "base", fields: F([{ name: "t", type: "text" }]), ...open });
    await createRecord("short", { t: "kept" });
    await db.exec(`ALTER TABLE vb_short RENAME TO "vb_${name}"`);
    await db.exec(`UPDATE vaultbase_collections SET name = '${name}' WHERE id = '${col.id}'`);
    await asEarlierRelease(`vb_${name}`, [`CREATE INDEX "idx_vb_${name}_created_at" ON "vb_${name}" ("created_at", "id")`]);
    await db.exec(`DELETE FROM vaultbase_migrations WHERE key = 'v0_29_0_fit_index_names'`);
    _resetCollectionCache();

    await runMigrations();
    expect(await indexedColumns(`vb_${name}`)).toEqual(new Set(["created_at", "updated_at"]));
    await createRecord(name, { t: "new" });
    expect((await listRecords(name)).totalItems).toBe(2);
    const token = db.schemaToken();
    await runMigrations();
    expect(db.schemaToken()).toBe(token);
  });

  it("a relation index an admin dropped stays dropped", async () => {
    await longCollection(A);
    const table = `vb_${A}`;
    const rel = [...(await indexesOf(table))].find(([, c]) => c[0] === REL)![0];
    await db.exec(`DROP INDEX "${rel}"`);
    await db.exec(`DELETE FROM vaultbase_migrations WHERE key = 'v0_29_0_fit_index_names'`);
    _resetCollectionCache();
    await runMigrations();
    expect((await indexedColumns(table)).has(REL)).toBe(false);
  });
});
