/**
 * A restore brings back data, not credentials: a password changed after the
 * backup (after a leak, say) stayed the leaked one once the backup was
 * restored, and an admin deleted after the backup came back whole with the
 * API tokens they had minted.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { onSqlite, seedAuthUser } from "./_helpers.ts";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb, getDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { admin } from "../db/schema.ts";
import { signAuthToken, verifyAuthToken } from "../core/sec.ts";
import { makeBackupPlugin } from "../api/backup.ts";
import { listBackups, runBackup, setBackupsDir } from "../core/backups.ts";
import { getCollection } from "../core/collections.ts";
import { findUserById, updateUserById } from "../core/users-table.ts";
import { mintApiToken } from "../core/api-tokens.ts";

const SECRET = "test-secret-restore-creds";
let tmpDir: string;
let dbPath: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-restore-creds-"));
  setLogsDir(tmpDir);
  dbPath = join(tmpDir, "data.db");
  await initDb(`file:${dbPath}`);
  await runMigrations();
  await getDb().insert(admin).values({ id: "a1", email: "ops@test.local", password_hash: "a1-old", password_reset_at: 0, created_at: 0 });
  getRawClient().prepare(`INSERT INTO vaultbase_install (key, id) VALUES ('install', 'install-1')`).run();
  setBackupsDir(join(tmpDir, "backups"));
});

afterEach(async () => {
  await closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

async function restoreLatest(): Promise<{ status: number; message: string }> {
  const { token } = await signAuthToken({ payload: { id: "a1", email: "ops@test.local" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET });
  const name = (await listBackups())[0]!.name;
  const res = await makeBackupPlugin(SECRET, dbPath).handle(new Request(`http://localhost/admin/backups/${name}/restore`, {
    method: "POST", headers: { authorization: `Bearer ${token}` },
  }));
  const body = await res.json() as { data?: { message: string }; error?: string };
  return { status: res.status, message: body.data?.message ?? body.error ?? "" };
}

const raw = () => getRawClient();

describe.skipIf(!onSqlite)("restore keeps credentials changed since the backup", () => {
  it("keeps a user's new password, MFA, recovery codes and provider links", async () => {
    const uid = await seedAuthUser({ collection: "users", email: "u@test.local", passwordHash: "leaked" });
    const col = (await getCollection("users"))!;
    raw().prepare(`INSERT INTO vaultbase_oauth_links (id, user_id, collection_id, provider, provider_user_id, created_at) VALUES ('l-old', ?, ?, 'github', 'attacker', 1)`).run(uid, col.id);
    await runBackup();

    // After the backup: the owner resets (new hash, links dropped), enrols TOTP, gets recovery codes.
    await updateUserById(col, uid, { password_hash: "fresh", password_reset_at: Date.now(), totp_enabled: 1, totp_secret: "SECRET" });
    raw().prepare(`DELETE FROM vaultbase_oauth_links WHERE user_id = ?`).run(uid);
    raw().prepare(`INSERT INTO vaultbase_mfa_recovery_codes (id, user_id, collection_id, code_hash, created_at) VALUES ('rc1', ?, ?, 'h1', 1)`).run(uid, col.id);

    const r = await restoreLatest();
    expect(r.status).toBe(200);
    expect(r.message).toContain("1 account kept the password and MFA set since the backup");
    const u = (await findUserById((await getCollection("users"))!, uid))!;
    expect(u.password_hash).toBe("fresh");
    expect(u.totp_enabled).toBe(1);
    expect(u.totp_secret).toBe("SECRET");
    expect(raw().prepare(`SELECT id FROM vaultbase_oauth_links WHERE user_id = ?`).all(uid)).toEqual([]);
    expect((raw().prepare(`SELECT id FROM vaultbase_mfa_recovery_codes WHERE user_id = ?`).all(uid) as Array<{ id: string }>).map((x) => x.id)).toEqual(["rc1"]);
  });

  it("restores an account whose credentials didn't change", async () => {
    const uid = await seedAuthUser({ collection: "users", email: "same@test.local", passwordHash: "kept" });
    await runBackup();
    raw().prepare(`UPDATE vb_users SET email = 'changed@test.local' WHERE id = ?`).run(uid);
    const r = await restoreLatest();
    expect(r.status).toBe(200);
    expect(r.message).not.toContain("kept the password");
    const u = (await findUserById((await getCollection("users"))!, uid))!;
    expect(u.email).toBe("same@test.local");
    expect(u.password_hash).toBe("kept");
  });

  it("keeps an admin's new password", async () => {
    await runBackup();
    raw().prepare(`UPDATE vaultbase_admin SET password_hash = 'a1-new', password_reset_at = ? WHERE id = 'a1'`).run(Date.now());
    await Bun.sleep(2); // the admin signs in again after the reset
    expect((await restoreLatest()).status).toBe(200);
    const row = raw().prepare(`SELECT password_hash FROM vaultbase_admin WHERE id = 'a1'`).get() as { password_hash: string };
    expect(row.password_hash).toBe("a1-new");
  });

  it("leaves an admin deleted since the backup deleted, with their API tokens revoked", async () => {
    await getDb().insert(admin).values({ id: "a2", email: "left@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
    const minted = await mintApiToken({ name: "ci", scopes: ["admin"], createdBy: "a2", createdByEmail: "left@test.local" }, SECRET);
    await runBackup();
    raw().prepare(`DELETE FROM vaultbase_admin WHERE id = 'a2'`).run();

    const r = await restoreLatest();
    expect(r.status).toBe(200);
    expect(r.message).toContain("left@test.local");
    expect(raw().prepare(`SELECT 1 FROM vaultbase_admin WHERE id = 'a2'`).get()).toBeNull();
    expect(await verifyAuthToken(minted.token, SECRET)).toBeNull();
    expect(raw().prepare(`SELECT 1 FROM vaultbase_admin WHERE id = 'a1'`).get()).not.toBeNull();
  });

  it("brings back another install's admins", async () => {
    await getDb().insert(admin).values({ id: "a2", email: "other@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
    await runBackup();
    raw().prepare(`DELETE FROM vaultbase_admin WHERE id = 'a2'`).run();
    raw().prepare(`UPDATE vaultbase_install SET id = 'install-2' WHERE key = 'install'`).run();
    expect((await restoreLatest()).status).toBe(200);
    expect(raw().prepare(`SELECT 1 FROM vaultbase_admin WHERE id = 'a2'`).get()).not.toBeNull();
  });

  it("never leaves the install without an admin", async () => {
    await runBackup();
    // Every admin in the backup is gone from the live database.
    await getDb().insert(admin).values({ id: "a3", email: "new@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
    raw().prepare(`DELETE FROM vaultbase_admin WHERE id = 'a1'`).run();
    const { token } = await signAuthToken({ payload: { id: "a3", email: "new@test.local" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET });
    const name = (await listBackups())[0]!.name;
    const res = await makeBackupPlugin(SECRET, dbPath).handle(new Request(`http://localhost/admin/backups/${name}/restore`, {
      method: "POST", headers: { authorization: `Bearer ${token}` },
    }));
    expect(res.status).toBe(200);
    expect(raw().prepare(`SELECT 1 FROM vaultbase_admin WHERE id = 'a1'`).get()).not.toBeNull();
  });
});
