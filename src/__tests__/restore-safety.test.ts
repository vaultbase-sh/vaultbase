/**
 * Restoring a backup brought back every session revoked since the backup
 * (sign-outs, password resets' explicit revocations, revoked API tokens),
 * kept serving collections and hooks from the in-memory caches of the
 * database it replaced, and ran with no write gate. In cluster mode it
 * swapped the database under one worker only.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb, getDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { admin } from "../db/schema.ts";
import { signAuthToken, revokeToken } from "../core/sec.ts";
import { makeBackupPlugin } from "../api/backup.ts";
import { listBackups, runBackup, setBackupsDir } from "../core/backups.ts";
import { createCollection, getCollection } from "../core/collections.ts";

const SECRET = "test-secret-restore";
let tmpDir: string;
let dbPath: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-restore-"));
  setLogsDir(tmpDir);
  dbPath = join(tmpDir, "data.db");
  initDb(`file:${dbPath}`);
  await runMigrations();
  await getDb().insert(admin).values({ id: "a1", email: "ops@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
  setBackupsDir(join(tmpDir, "backups"));
});

afterEach(() => {
  delete process.env["VAULTBASE_WORKER_ID"];
  closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

async function restoreLatest(): Promise<Response> {
  const { token } = await signAuthToken({ payload: { id: "a1" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET });
  const name = (await listBackups())[0]!.name;
  return makeBackupPlugin(SECRET, dbPath).handle(new Request(`http://localhost/admin/backups/${name}/restore`, {
    method: "POST", headers: { authorization: `Bearer ${token}` },
  }));
}

describe("restore", () => {
  it("keeps revocations made after the backup", async () => {
    await runBackup();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    await revokeToken("jti-signed-out-after-backup", exp);
    expect((await restoreLatest()).status).toBe(200);
    const row = getRawClient().prepare(`SELECT jti FROM vaultbase_token_revocations WHERE jti = ?`).get("jti-signed-out-after-backup");
    expect(row).not.toBeNull();
  });

  it("drops cached collections from the replaced database", async () => {
    await runBackup();
    await createCollection({ name: "made_after_backup", fields: "[]" });
    expect(await getCollection("made_after_backup")).not.toBeNull();
    expect((await restoreLatest()).status).toBe(200);
    expect(await getCollection("made_after_backup")).toBeNull();
  });

  it("is refused in cluster mode", async () => {
    await runBackup();
    process.env["VAULTBASE_WORKER_ID"] = "1";
    expect((await restoreLatest()).status).toBe(409);
  });
});
