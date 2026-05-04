/**
 * v0.11 phase 1 — migration prep for auth-as-first-class-collection.
 *
 * Verifies that runMigrations() promotes a v0.10-shape DB:
 *   - vaultbase_users with rows
 *   - vb_<auth-col> exists but lacks auth columns
 * into the new shape:
 *   - vb_<auth-col> has auth columns + custom-field columns
 *   - rows from vaultbase_users copied in (with `data` JSON fanned out)
 *   - UNIQUE index on email
 *   - vaultbase_users still present (phase 1 is data-prep; readers haven't
 *     switched over yet — that lands in phase 2).
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { initDb, closeDb, getDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { createCollection } from "../core/collections.ts";
import { runDoctor } from "../scripts/doctor.ts";

let tmpDir: string;
let dbPath: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-v011-"));
  setLogsDir(tmpDir);
  dbPath = join(tmpDir, "data.db");
  initDb(dbPath);
  await runMigrations();
});

afterEach(() => {
  closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  catch { /* swallow */ }
});

describe("v0.11 phase 1 — auth columns added to vb_<col>", () => {
  it("createCollection(type='auth') puts auth columns on vb_<name>", async () => {
    await createCollection({
      name: "users", type: "auth",
      fields: JSON.stringify([{ name: "display_name", type: "text" }]),
      view_rule: null,
    });
    const cols = getRawClient().prepare(`PRAGMA table_info("vb_users")`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    // Custom field
    expect(names).toContain("display_name");
    // Auth columns
    expect(names).toContain("email");
    expect(names).toContain("password_hash");
    expect(names).toContain("email_verified");
    expect(names).toContain("totp_secret");
    expect(names).toContain("totp_enabled");
    expect(names).toContain("is_anonymous");
    expect(names).toContain("password_reset_at");
  });

  it("base collections do NOT get auth columns", async () => {
    await createCollection({
      name: "posts", type: "base",
      fields: JSON.stringify([{ name: "title", type: "text" }]),
      view_rule: null,
    });
    const cols = getRawClient().prepare(`PRAGMA table_info("vb_posts")`).all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("title");
    expect(names).not.toContain("password_hash");
    expect(names).not.toContain("email_verified");
  });
});

describe("v0.11 migration — vaultbase_users → vb_<col> + drop legacy", () => {
  it("on a fresh install drops the empty vaultbase_users at end of migration", async () => {
    // runMigrations already ran in beforeEach. With no v0.10 rows present,
    // FinalizeAuthMigration drops the legacy table.
    const exists = getRawClient().prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='vaultbase_users'`,
    ).get();
    expect(exists).toBeFalsy();
  });

  it("v0.10-shape rows get copied + the legacy table is dropped", async () => {
    // To simulate a v0.10 → v0.11 upgrade we need the legacy table back.
    // runMigrations already dropped it (fresh install path); recreate +
    // seed + run migrations again.
    const c = getRawClient();
    c.exec(`
      CREATE TABLE vaultbase_users (
        id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, email TEXT NOT NULL,
        password_hash TEXT NOT NULL, email_verified INTEGER NOT NULL DEFAULT 0,
        totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0,
        is_anonymous INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )
    `);
    const col = await createCollection({
      name: "members", type: "auth",
      fields: JSON.stringify([
        { name: "display_name", type: "text" },
        { name: "handle", type: "text" },
      ]),
      view_rule: null,
    });
    const now = Math.floor(Date.now() / 1000);
    c.prepare(
      `INSERT INTO vaultbase_users (id, collection_id, email, password_hash, email_verified,
        totp_enabled, is_anonymous, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 0, 0, ?, ?, ?)`,
    ).run("u1", col.id, "alice@x.com", "h$alice",
      JSON.stringify({ display_name: "Alice", handle: "alice" }), now, now);

    await runMigrations(); // copies + drops

    const rows = c.prepare(`SELECT * FROM vb_members`).all() as Array<{
      id: string; email: string; password_hash: string; email_verified: number;
      display_name: string; handle: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe("alice@x.com");
    expect(rows[0]!.display_name).toBe("Alice");

    const legacy = c.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='vaultbase_users'`,
    ).get();
    expect(legacy).toBeFalsy();
  });
});

describe("v0.11 phase 3 — records.ts handles auth collections", () => {
  it("listRecords on auth collection returns rows from vb_<col>, password_hash stripped", async () => {
    const { listRecords } = await import("../core/records.ts");
    await createCollection({
      name: "members", type: "auth",
      fields: JSON.stringify([{ name: "name", type: "text" }]),
      view_rule: null,
    });
    const now = Math.floor(Date.now() / 1000);
    getRawClient().prepare(
      `INSERT INTO vb_members (id, email, password_hash, email_verified, name, created_at, updated_at)
       VALUES ('u1', 'alice@x.com', 'h$secret', 1, 'Alice', ?, ?)`,
    ).run(now, now);

    const result = await listRecords("members", {});
    expect(result.data).toHaveLength(1);
    const row = result.data[0]!;
    expect(row.email).toBe("alice@x.com");
    expect(row.name).toBe("Alice");
    // Sensitive columns NEVER appear on the wire.
    expect(row.password_hash).toBeUndefined();
    expect(row.totp_secret).toBeUndefined();
    expect(row.password_reset_at).toBeUndefined();
  });

  it("createRecord refuses on auth collections — points to /auth/<col>/register", async () => {
    const { createRecord } = await import("../core/records.ts");
    await createCollection({
      name: "members", type: "auth",
      fields: JSON.stringify([]), view_rule: null,
    });
    await expect(createRecord("members", { email: "x@x.com" })).rejects.toThrow(/auth collection/);
  });

  it("updateRecord on auth strips auth-system columns from the patch", async () => {
    const { updateRecord } = await import("../core/records.ts");
    await createCollection({
      name: "members", type: "auth",
      fields: JSON.stringify([{ name: "name", type: "text" }]),
      view_rule: null,
    });
    const now = Math.floor(Date.now() / 1000);
    getRawClient().prepare(
      `INSERT INTO vb_members (id, email, password_hash, email_verified, name, created_at, updated_at)
       VALUES ('u1', 'a@x.com', 'h$ORIG', 1, 'A', ?, ?)`,
    ).run(now, now);

    // Try to forge a password_hash via update — must be ignored.
    await updateRecord("members", "u1", {
      name: "Alice",
      password_hash: "h$FORGED",
      email_verified: 0,
    });
    const after = getRawClient().prepare(`SELECT name, password_hash, email_verified FROM vb_members WHERE id = 'u1'`).get() as {
      name: string; password_hash: string; email_verified: number;
    };
    expect(after.name).toBe("Alice");                // legitimate update
    expect(after.password_hash).toBe("h$ORIG");      // forge rejected
    expect(after.email_verified).toBe(1);            // forge rejected
  });
});

describe("v0.11 — /register writes to vb_<col>", () => {
  it("/register on auth collection populates vb_<col> with auth + custom columns", async () => {
    const { makeAuthPlugin } = await import("../api/auth.ts");
    await createCollection({
      name: "members", type: "auth",
      fields: JSON.stringify([{ name: "name", type: "text" }]),
      view_rule: null,
    });
    const SECRET = "test-secret-v011";
    const app = makeAuthPlugin(SECRET);
    const res = await app.handle(new Request("http://localhost/auth/members/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@x.com", password: "hunter2!!hunter2!!", name: "Alice" }),
    }));
    expect(res.status).toBe(200);

    const newRow = getRawClient().prepare(
      `SELECT id, email, password_hash, email_verified, name FROM vb_members WHERE email = ?`,
    ).get("alice@x.com") as { id: string; email: string; password_hash: string; name: string } | undefined;
    expect(newRow?.email).toBe("alice@x.com");
    expect(newRow?.password_hash).toBeTruthy();
    expect(newRow?.name).toBe("Alice");
  });
});

describe("vaultbase doctor — pre-migration checks", () => {
  it("reports clean on a fresh install with no auth collections", async () => {
    closeDb();
    const r = runDoctor(dbPath);
    initDb(dbPath); // restore for afterEach
    expect(r.ok).toBe(true);
    expect(r.blockers).toHaveLength(0);
  });

  it("flags duplicate emails inside an auth collection as a blocker", async () => {
    const col = await createCollection({
      name: "members", type: "auth",
      fields: JSON.stringify([]), view_rule: null,
    });
    const now = Math.floor(Date.now() / 1000);
    const c = getRawClient();
    // Doctor inspects the legacy vaultbase_users table — re-create it for
    // this scenario (fresh installs auto-drop it after migration).
    c.exec(`
      CREATE TABLE vaultbase_users (
        id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, email TEXT NOT NULL,
        password_hash TEXT NOT NULL, email_verified INTEGER NOT NULL DEFAULT 0,
        totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0,
        is_anonymous INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )
    `);
    c.prepare(
      `INSERT INTO vaultbase_users (id, collection_id, email, password_hash, data, created_at, updated_at)
       VALUES ('u1', ?, 'dup@x.com', 'h', '{}', ?, ?)`,
    ).run(col.id, now, now);
    c.prepare(
      `INSERT INTO vaultbase_users (id, collection_id, email, password_hash, data, created_at, updated_at)
       VALUES ('u2', ?, 'dup@x.com', 'h', '{}', ?, ?)`,
    ).run(col.id, now, now);

    closeDb();
    const r = runDoctor(dbPath);
    initDb(dbPath);
    expect(r.ok).toBe(false);
    expect(r.blockers.some((b) => b.message.includes("duplicate email"))).toBe(true);
  });

  it("flags collisions between custom field name and auth column", async () => {
    // assertValidFieldsForType normally blocks reserved names at
    // createCollection time. Bypass that path by injecting the row
    // directly — simulating a pre-validation install where a custom field
    // happens to share an auth-column name (older bug or hand-edited DB).
    const now = Math.floor(Date.now() / 1000);
    getRawClient().prepare(
      `INSERT INTO vaultbase_collections (id, name, type, fields, created_at, updated_at)
       VALUES ('c1', 'members', 'auth', ?, ?, ?)`,
    ).run(JSON.stringify([{ name: "password_hash", type: "text" }]), now, now);

    closeDb();
    const r = runDoctor(dbPath);
    initDb(dbPath);
    expect(r.ok).toBe(false);
    expect(r.blockers.some((b) => b.message.includes("password_hash") && b.message.includes("collides"))).toBe(true);
  });

  it("warns on JSON `data` keys that don't map to any custom field", async () => {
    const col = await createCollection({
      name: "members", type: "auth",
      fields: JSON.stringify([{ name: "display_name", type: "text" }]),
      view_rule: null,
    });
    const now = Math.floor(Date.now() / 1000);
    const c = getRawClient();
    c.exec(`
      CREATE TABLE vaultbase_users (
        id TEXT PRIMARY KEY, collection_id TEXT NOT NULL, email TEXT NOT NULL,
        password_hash TEXT NOT NULL, email_verified INTEGER NOT NULL DEFAULT 0,
        totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0,
        is_anonymous INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )
    `);
    c.prepare(
      `INSERT INTO vaultbase_users (id, collection_id, email, password_hash, data, created_at, updated_at)
       VALUES ('u1', ?, 'x@x.com', 'h', ?, ?, ?)`,
    ).run(col.id, JSON.stringify({ display_name: "X", legacy_blob: "ignored" }), now, now);

    closeDb();
    const r = runDoctor(dbPath);
    initDb(dbPath);
    // Warning, not blocker.
    expect(r.warnings.some((w) => w.message.includes("legacy_blob"))).toBe(true);
  });
});
