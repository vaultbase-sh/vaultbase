/**
 * Two findings from the Shannon pentest, verified here.
 *
 * 1. DROP INDEX endpoint (src/api/indexes.ts): validated the index name only by
 *    an idx_/uniq_ prefix, then interpolated it into SQL. An admin managing one
 *    collection's indexes could drop *any* prefixed index DB-wide — including
 *    uniq_vaultbase_admin_email — and a name with a `"` could break out of the
 *    identifier into stacked SQL via Bun's multi-statement exec().
 *
 * 2. validateViewQuery (src/core/collections.ts): the banned-keyword regex used
 *    \bpragma\b, which does not match pragma_table_info()/pragma_database_list()
 *    because `_` is a word char — letting an admin-authored view disclose the DB
 *    schema and absolute file path to unauthenticated readers.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { onSqlite } from "./_helpers.ts";
import { initDb, closeDb, getDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import {
  createCollection,
  _resetCollectionCache,
  validateViewQuery,
  userTableName,
} from "../core/collections.ts";
import { makeIndexesPlugin } from "../api/indexes.ts";
import { signAuthToken } from "../core/sec.ts";
import { admin } from "../db/schema.ts";

const SECRET = "test-secret-shannon";

async function adminToken(): Promise<string> {
  const { token } = await signAuthToken({
    payload: { id: "admin-1", email: "a@test.local" },
    audience: "admin",
    expiresInSeconds: 3600,
    jwtSecret: SECRET,
  });
  return token;
}

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  _resetCollectionCache();
  await getDb().insert(admin).values({
    id: "admin-1", email: "a@test.local", password_hash: "x",
    password_reset_at: 0, created_at: Math.floor(Date.now() / 1000),
  });
});
afterEach(() => closeDb());

// ── 1. DROP INDEX scoping ─────────────────────────────────────────────────────
describe.skipIf(!onSqlite)("DROP INDEX is bound to the named collection", () => {
  async function setup() {
    await createCollection({
      name: "posts", type: "base",
      fields: JSON.stringify([{ name: "title", type: "text" }]),
    });
    await createCollection({
      name: "notes", type: "base",
      fields: JSON.stringify([{ name: "body", type: "text" }]),
    });
    _resetCollectionCache();
    const c = getRawClient();
    c.exec(`CREATE INDEX idx_posts_title ON "${userTableName("posts")}" ("title")`);
    c.exec(`CREATE INDEX idx_notes_body  ON "${userTableName("notes")}" ("body")`);
  }

  async function dropIndex(collection: string, indexName: string): Promise<Response> {
    return makeIndexesPlugin(SECRET).handle(
      new Request(`http://localhost/admin/collections/${collection}/indexes/${encodeURIComponent(indexName)}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${await adminToken()}` },
      }),
    );
  }

  const indexExists = (name: string) =>
    (getRawClient().prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name=?`).get(name)) != null;

  it("drops an index that belongs to the collection", async () => {
    await setup();
    const res = await dropIndex("posts", "idx_posts_title");
    expect(res.status).toBe(200);
    expect(indexExists("idx_posts_title")).toBe(false);
  });

  it("refuses to drop another collection's index via a mismatched :name", async () => {
    await setup();
    // The old handler would have dropped idx_notes_body here.
    const res = await dropIndex("posts", "idx_notes_body");
    expect(res.status).toBe(404);
    expect(indexExists("idx_notes_body")).toBe(true);
  });

  it("refuses to drop a system index like uniq_vaultbase_admin_email", async () => {
    await setup();
    const c = getRawClient();
    const before = c.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'uniq_%'`).all() as { name: string }[];
    if (before.length > 0) {
      const sysIdx = before[0]!.name;
      const res = await dropIndex("posts", sysIdx);
      expect(res.status).toBe(404);
      expect(indexExists(sysIdx)).toBe(true);
    }
  });

  it("does not let a quote in the index name break out of the identifier", async () => {
    await setup();
    // A stacked-query payload. It is not a real index on posts, so it is
    // rejected before any SQL runs; the table must survive regardless.
    const res = await dropIndex("posts", `idx_x"; DROP TABLE "${userTableName("notes")}"; --`);
    expect(res.status).toBe(404);
    const notesTableGone = getRawClient()
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
      .get(userTableName("notes")) == null;
    expect(notesTableGone).toBe(false);
  });
});

// ── 2. pragma view-query bypass ───────────────────────────────────────────────
describe("view queries cannot reference SQLite metadata", () => {
  it("rejects pragma_database_list() (the \\bpragma\\b bypass)", () => {
    expect(() => validateViewQuery("SELECT name, file FROM pragma_database_list()")).toThrow();
  });

  it("rejects pragma_table_info()", () => {
    expect(() => validateViewQuery("SELECT name FROM pragma_table_info('vaultbase_admin')")).toThrow();
  });

  it("rejects the sqlite_master / sqlite_schema metadata tables", () => {
    expect(() => validateViewQuery("SELECT sql FROM sqlite_master")).toThrow();
    expect(() => validateViewQuery("SELECT sql FROM sqlite_schema")).toThrow();
  });

  it("still rejects a bare PRAGMA statement", () => {
    expect(() => validateViewQuery("PRAGMA database_list")).toThrow();
  });

  it("still accepts an ordinary SELECT over a real table", () => {
    expect(() => validateViewQuery("SELECT id, title FROM vb_posts WHERE published = 1")).not.toThrow();
  });
});
