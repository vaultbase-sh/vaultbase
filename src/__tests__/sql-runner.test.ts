/**
 * SQL runner — read-only enforcement, sandbox isolation, row cap, timeout,
 * saved-query CRUD.
 *
 * Drives the runner directly (no HTTP). Each test gets an on-disk DB so the
 * sandbox VACUUM INTO has a real source file to copy. The HTTP plugin is
 * exercised separately in sql-http.test.ts.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { admin } from "../db/schema.ts";
import {
  detectMutation,
  runSql,
  MAX_SQL_RESULT_ROWS,
} from "../core/sql-runner.ts";
import {
  setSandboxDir,
  resetSandbox,
  describeSandbox,
  dropSandbox,
  pruneStaleSandboxes,
  _resetSandboxRegistryForTests,
} from "../core/sql-sandbox.ts";
import {
  createSavedQuery,
  listSavedQueries,
  getSavedQuery,
  updateSavedQuery,
  deleteSavedQuery,
  recordSavedQueryRun,
} from "../core/sql-queries.ts";

let tmpDir: string;
let dbPath: string;

async function seedAdmin(id = "a1"): Promise<{ id: string; email: string }> {
  const email = `${id}@test.local`;
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(admin).values({
    id, email, password_hash: "x", password_reset_at: 0, created_at: now,
  });
  return { id, email };
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-sql-"));
  setLogsDir(tmpDir);
  setSandboxDir(join(tmpDir, "sandboxes"));
  dbPath = join(tmpDir, "data.db");
  initDb(dbPath);
  await runMigrations();
});

afterEach(() => {
  _resetSandboxRegistryForTests();
  closeDb();
  // Windows occasionally holds a brief lock on the sqlite file just after
  // close; tolerate flaky rm here. Tests should not fail on cleanup.
  try { rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  catch { /* leave it for OS tmp cleanup */ }
});

// ── detectMutation ───────────────────────────────────────────────────────

describe("detectMutation", () => {
  it("flags INSERT/UPDATE/DELETE/DROP", () => {
    expect(detectMutation("INSERT INTO t VALUES (1)")).toBe("INSERT");
    expect(detectMutation("update t set x = 1")).toBe("UPDATE");
    expect(detectMutation("DELETE FROM t")).toBe("DELETE");
    expect(detectMutation("drop table t")).toBe("DROP");
  });
  it("flags ALTER/CREATE/ATTACH/VACUUM/REINDEX", () => {
    expect(detectMutation("ALTER TABLE t ADD COLUMN x")).toBe("ALTER");
    expect(detectMutation("CREATE INDEX foo ON t(x)")).toBe("CREATE");
    expect(detectMutation("ATTACH DATABASE 'evil.db' AS evil")).toBe("ATTACH");
    expect(detectMutation("VACUUM")).toBe("VACUUM");
    expect(detectMutation("REINDEX t")).toBe("REINDEX");
  });
  it("allows SELECT/EXPLAIN", () => {
    expect(detectMutation("SELECT * FROM t")).toBeNull();
    expect(detectMutation("EXPLAIN QUERY PLAN SELECT * FROM t")).toBeNull();
  });
  it("ignores keywords inside string literals + comments", () => {
    expect(detectMutation("SELECT 'DROP TABLE x' FROM t")).toBeNull();
    expect(detectMutation("-- DELETE comment\nSELECT 1")).toBeNull();
    expect(detectMutation("SELECT 1 /* ALTER TABLE */ FROM t")).toBeNull();
  });
});

// ── readonly mode ────────────────────────────────────────────────────────

describe("runSql — read-only mode", () => {
  it("returns rows with columns + row count for a SELECT", async () => {
    const res = await runSql({
      sql: "SELECT 1 AS one, 'two' AS two",
      mode: "readonly",
      dbPath,
    });
    expect(res.ok).toBe(true);
    expect(res.columns).toEqual(["one", "two"]);
    expect(res.rows).toEqual([[1, "two"]]);
    expect(res.rowCount).toBe(1);
    expect(res.truncated).toBe(false);
  });

  it("blocks INSERT/UPDATE/DELETE before reaching SQLite", async () => {
    const res = await runSql({
      sql: "INSERT INTO vaultbase_admin (id) VALUES ('x')",
      mode: "readonly",
      dbPath,
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("VAULTBASE_READONLY");
    expect(res.error).toContain("INSERT");
  });

  it("returns SQLite error inline for invalid SQL", async () => {
    const res = await runSql({
      sql: "SELEKT bad syntax",
      mode: "readonly",
      dbPath,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBeTruthy();
  });

  it("caps result at MAX_SQL_RESULT_ROWS and flags truncated", async () => {
    // Build a recursive CTE that produces > MAX rows.
    const res = await runSql({
      sql: `
        WITH RECURSIVE seq(n) AS (
          SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ${MAX_SQL_RESULT_ROWS + 50}
        )
        SELECT n FROM seq
      `,
      mode: "readonly",
      dbPath,
    });
    expect(res.ok).toBe(true);
    expect(res.truncated).toBe(true);
    expect(res.rows.length).toBe(MAX_SQL_RESULT_ROWS);
    expect(res.rowCount).toBe(MAX_SQL_RESULT_ROWS + 50);
  });
});

// ── sandbox mode ─────────────────────────────────────────────────────────

describe("runSql — sandbox mode", () => {
  it("returns 'no sandbox' error when adminId missing or sandbox unset", async () => {
    const res = await runSql({
      sql: "SELECT 1",
      mode: "sandbox",
      dbPath,
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("VAULTBASE_NO_SANDBOX");

    const res2 = await runSql({
      sql: "SELECT 1",
      mode: "sandbox",
      dbPath,
      adminId: "no-sandbox-yet",
    });
    expect(res2.ok).toBe(false);
    expect(res2.errorCode).toBe("VAULTBASE_NO_SANDBOX");
  });

  it("allows mutations and isolates them from live DB", async () => {
    const me = await seedAdmin();
    resetSandbox(me.id, dbPath);

    // Sandbox: drop the admin table.
    const drop = await runSql({
      sql: "DROP TABLE vaultbase_admin",
      mode: "sandbox",
      dbPath,
      adminId: me.id,
    });
    if (!drop.ok) console.error("DROP failed:", drop.error, drop.errorCode);
    expect(drop.ok).toBe(true);

    // Live DB still has it.
    const live = new Database(dbPath, { readonly: true, create: false });
    try {
      const r = live.prepare("SELECT count(*) AS n FROM vaultbase_admin").get() as { n: number };
      expect(r.n).toBeGreaterThanOrEqual(1);
    } finally {
      live.close();
    }
  });

  it("INSERT in sandbox is reflected in subsequent sandbox SELECT", async () => {
    const me = await seedAdmin();
    resetSandbox(me.id, dbPath);

    const ins = await runSql({
      sql: `INSERT INTO vaultbase_admin (id, email, password_hash, password_reset_at, created_at)
            VALUES ('zzz', 'sandbox@x', 'h', 0, 0)`,
      mode: "sandbox",
      dbPath,
      adminId: me.id,
    });
    expect(ins.ok).toBe(true);
    expect(ins.changes).toBe(1);

    const sel = await runSql({
      sql: "SELECT id FROM vaultbase_admin WHERE id = 'zzz'",
      mode: "sandbox",
      dbPath,
      adminId: me.id,
    });
    expect(sel.ok).toBe(true);
    expect(sel.rows).toEqual([["zzz"]]);
  });
});

// ── sandbox lifecycle ────────────────────────────────────────────────────

describe("sandbox lifecycle", () => {
  it("describe + reset + drop", async () => {
    const me = await seedAdmin();

    expect(describeSandbox(me.id).exists).toBe(false);

    const info = resetSandbox(me.id, dbPath);
    expect(info.exists).toBe(true);
    expect(info.sizeBytes).toBeGreaterThan(0);

    expect(dropSandbox(me.id)).toBe(true);
    expect(describeSandbox(me.id).exists).toBe(false);
  });

  it("pruneStaleSandboxes removes nothing when within TTL", async () => {
    const me = await seedAdmin();
    resetSandbox(me.id, dbPath);
    const removed = pruneStaleSandboxes(3600);
    expect(removed).toBe(0);
    expect(describeSandbox(me.id).exists).toBe(true);
  });

  it("pruneStaleSandboxes removes when over TTL", async () => {
    const me = await seedAdmin();
    resetSandbox(me.id, dbPath);
    // ttl=-1 → everything counts as stale.
    const removed = pruneStaleSandboxes(-1);
    expect(removed).toBeGreaterThanOrEqual(1);
  });
});

// ── saved queries ────────────────────────────────────────────────────────

describe("saved queries — CRUD", () => {
  it("create + list scoped to owner", async () => {
    const a1 = await seedAdmin("a1");
    const a2 = await seedAdmin("a2");

    await createSavedQuery({
      name: "all admins", sql: "SELECT * FROM vaultbase_admin",
      ownerAdminId: a1.id, ownerAdminEmail: a1.email,
    });
    await createSavedQuery({
      name: "a2 only", sql: "SELECT 2",
      ownerAdminId: a2.id, ownerAdminEmail: a2.email,
    });

    const a1List = await listSavedQueries(a1.id);
    expect(a1List.length).toBe(1);
    expect(a1List[0]!.name).toBe("all admins");

    const a2List = await listSavedQueries(a2.id);
    expect(a2List.length).toBe(1);
    expect(a2List[0]!.name).toBe("a2 only");
  });

  it("get returns null cross-owner", async () => {
    const a1 = await seedAdmin("a1");
    const a2 = await seedAdmin("a2");
    const q = await createSavedQuery({
      name: "private", sql: "SELECT 1",
      ownerAdminId: a1.id, ownerAdminEmail: a1.email,
    });
    expect(await getSavedQuery(q.id, a1.id)).not.toBeNull();
    expect(await getSavedQuery(q.id, a2.id)).toBeNull();
  });

  it("update changes name + sql + bumps updated_at", async () => {
    const a1 = await seedAdmin("a1");
    const q = await createSavedQuery({
      name: "v1", sql: "SELECT 1",
      ownerAdminId: a1.id, ownerAdminEmail: a1.email,
    });
    const original = q.updated_at;
    // Bun's clock is high-res but second-grain on disk; pause briefly.
    await new Promise((r) => setTimeout(r, 1100));
    const updated = await updateSavedQuery(q.id, a1.id, { name: "v2", sql: "SELECT 2" });
    expect(updated?.name).toBe("v2");
    expect(updated?.sql).toBe("SELECT 2");
    expect(updated!.updated_at).toBeGreaterThanOrEqual(original);
  });

  it("delete is idempotent + cross-owner safe", async () => {
    const a1 = await seedAdmin("a1");
    const a2 = await seedAdmin("a2");
    const q = await createSavedQuery({
      name: "x", sql: "SELECT 1",
      ownerAdminId: a1.id, ownerAdminEmail: a1.email,
    });
    expect(await deleteSavedQuery(q.id, a2.id)).toBe(false);   // wrong owner
    expect(await deleteSavedQuery(q.id, a1.id)).toBe(true);
    expect(await deleteSavedQuery(q.id, a1.id)).toBe(false);   // already gone
  });

  it("recordSavedQueryRun populates last_*", async () => {
    const a1 = await seedAdmin("a1");
    const q = await createSavedQuery({
      name: "x", sql: "SELECT 1",
      ownerAdminId: a1.id, ownerAdminEmail: a1.email,
    });
    await recordSavedQueryRun(q.id, a1.id, { ok: true, durationMs: 12, rowCount: 3 });
    const after = await getSavedQuery(q.id, a1.id);
    expect(after?.last_run_ms).toBe(12);
    expect(after?.last_row_count).toBe(3);
    expect(after?.last_error).toBeNull();

    await recordSavedQueryRun(q.id, a1.id, { ok: false, durationMs: 5, rowCount: 0, error: "boom" });
    const after2 = await getSavedQuery(q.id, a1.id);
    expect(after2?.last_error).toBe("boom");
    expect(after2?.last_row_count).toBeNull();
  });
});

// ── /admin/sql/schema introspection ─────────────────────────────────────

import Elysia from "elysia";
import { signAuthToken } from "../core/sec.ts";
import { makeSqlPlugin } from "../api/sql.ts";

describe("/admin/sql/schema endpoint", () => {
  function mkApp(): Elysia {
    return new Elysia()
      .group("/api/v1", (app) => app.use(makeSqlPlugin("test-secret-sql-schema", dbPath))) as unknown as Elysia;
  }

  async function adminToken(adminId: string, email: string): Promise<string> {
    const { token } = await signAuthToken({
      payload: { id: adminId, email },
      audience: "admin",
      expiresInSeconds: 3600,
      jwtSecret: "test-secret-sql-schema",
    });
    return token;
  }

  it("requires admin auth", async () => {
    const app = mkApp();
    const res = await app.handle(new Request("http://localhost/api/v1/admin/sql/schema"));
    expect(res.status).toBe(401);
  });

  it("returns enriched table info — columns, indexes, FKs", async () => {
    const me = await seedAdmin("a1");
    const tok = await adminToken(me.id, me.email);

    // Seed a small user table so we get back something predictable.
    getDb().run(`CREATE TABLE _test_widgets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner TEXT REFERENCES vaultbase_admin(id)
    )` as never);
    getDb().run("CREATE INDEX idx_widgets_name ON _test_widgets(name)" as never);

    const app = mkApp();
    const res = await app.handle(new Request("http://localhost/api/v1/admin/sql/schema", {
      headers: { Authorization: `Bearer ${tok}` },
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { tables: Array<{ name: string; columns: Array<{ name: string; type: string; notnull: boolean; pk: boolean; indexed: boolean }>; indexes: Array<{ name: string; cols: string[] }>; foreignKeys: Array<{ col: string; refTable: string; refCol: string }>; kind: string }> } };
    const widgets = body.data.tables.find((t) => t.name === "_test_widgets");
    expect(widgets).toBeTruthy();
    expect(widgets!.kind).toBe("user");
    const idCol = widgets!.columns.find((c) => c.name === "id");
    expect(idCol?.pk).toBe(true);
    expect(idCol?.indexed).toBe(true);
    const nameCol = widgets!.columns.find((c) => c.name === "name");
    expect(nameCol?.notnull).toBe(true);
    expect(nameCol?.indexed).toBe(true);
    expect(widgets!.indexes.some((i) => i.name === "idx_widgets_name")).toBe(true);
    expect(widgets!.foreignKeys.some((f) => f.col === "owner" && f.refTable === "vaultbase_admin")).toBe(true);

    const adminTable = body.data.tables.find((t) => t.name === "vaultbase_admin");
    expect(adminTable?.kind).toBe("system");
  });
});
