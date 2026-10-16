/**
 * Backups on Postgres: pg_dump archives of the server's schema, through the
 * same pipeline as SQLite's (local copies, keep count, download). Runs when
 * VAULTBASE_TEST_DB is Postgres and VAULTBASE_PG_DUMP (or pg_dump on the
 * PATH) is there; restore from the admin stays SQLite-only (501 on both routes).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDb, getDb, initDb } from "../db/client.ts";
import { admin } from "../db/schema.ts";
import { signAuthToken } from "../core/sec.ts";
import { makeBackupPlugin } from "../api/backup.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { backupEngine, isBackupName, listBackups, runBackup, setBackupsDir } from "../core/backups.ts";
import { createPublicCollection, onSqlite } from "./_helpers.ts";

const hasDump = !onSqlite && (!!process.env["VAULTBASE_PG_DUMP"] || !!Bun.which("pg_dump"));

describe.skipIf(!hasDump)("backups on Postgres", () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "vb-pgdump-"));
    setBackupsDir(dir);
    await initDb(":memory:");
    await runMigrations();
  });
  afterEach(async () => {
    _resetCollectionCache();
    await closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a pg_dump archive of the schema, named and kept like SQLite's", async () => {
    expect(backupEngine()).toBe("pg_dump");
    await createPublicCollection({ name: "notes", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    await createRecord("notes", { title: "kept in the dump" });
    const info = await runBackup();
    expect(info.name.endsWith(".dump")).toBe(true);
    expect(isBackupName(info.name)).toBe(true);
    expect(info.size).toBeGreaterThan(0);
    const bytes = readFileSync(join(dir, info.name));
    expect(bytes.subarray(0, 5).toString()).toBe("PGDMP"); // the custom-format header
    expect(bytes.includes(Buffer.from("vb_notes"))).toBe(true);
    expect(listBackups().map((b) => b.name)).toEqual([info.name]);
  });
});

describe.skipIf(onSqlite)("restore on Postgres", () => {
  beforeEach(async () => {
    await initDb(":memory:");
    await runMigrations();
    await getDb().insert(admin).values({ id: "a1", email: "ops@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
  });
  afterEach(async () => {
    await closeDb();
  });

  it("answers 501 with pg_restore guidance, for a stored backup and an upload", async () => {
    const SECRET = "test-secret-pg-restore";
    const { token } = await signAuthToken({ payload: { id: "a1" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET });
    const plugin = makeBackupPlugin(SECRET, join(tmpdir(), `vb-pg-restore-${Date.now()}.db`));
    const form = new FormData();
    form.append("file", new File(["SQLite format 3\0"], "data.db"));
    for (const req of [
      new Request("http://localhost/admin/backups/vaultbase-x.dump/restore", { method: "POST", headers: { authorization: `Bearer ${token}` } }),
      new Request("http://localhost/admin/restore", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form }),
    ]) {
      const res = await plugin.handle(req);
      expect(res.status).toBe(501);
      expect(((await res.json()) as { error: string }).error).toContain("pg_restore");
    }
  });
});
