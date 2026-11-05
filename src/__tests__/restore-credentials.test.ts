/**
 * A restore brings back data, not credentials: a password changed after the
 * backup (after a leak, say) stayed the leaked one once the backup was
 * restored, and an admin deleted after the backup came back whole with the
 * API tokens they had minted.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { onSqlite, seedAuthUser, signUserJwt } from "./_helpers.ts";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb, getDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { admin } from "../db/schema.ts";
import { decodeJwt } from "jose";
import { revokeToken, signAuthToken, verifyAuthToken } from "../core/sec.ts";
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
  return restoreNamed((await listBackups())[0]!.name);
}

async function restoreNamed(name: string, qs = ""): Promise<{ status: number; message: string }> {
  const { token } = await signAuthToken({ payload: { id: "a1", email: "ops@test.local" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET });
  const res = await makeBackupPlugin(SECRET, dbPath).handle(new Request(`http://localhost/admin/backups/${name}/restore${qs}`, {
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
    expect(r.message).toContain("1 account kept the password, email, MFA and provider links set since the backup");
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
    const before = (await findUserById((await getCollection("users"))!, uid))!.updated_at;
    raw().prepare(`UPDATE vb_users SET updated_at = 1 WHERE id = ?`).run(uid);
    const r = await restoreLatest();
    expect(r.status).toBe(200);
    expect(r.message).not.toContain("kept the password");
    const u = (await findUserById((await getCollection("users"))!, uid))!;
    expect(u.updated_at).toBe(before);
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

  it("a provider identity moved between accounts doesn't fail the restore, and revocations and resets stay", async () => {
    const x = await seedAuthUser({ collection: "users", email: "x@test.local" });
    const y = await seedAuthUser({ collection: "users", email: "y@test.local" });
    const z = await seedAuthUser({ collection: "users", email: "z@test.local" });
    const col = (await getCollection("users"))!;
    const link = raw().prepare(`INSERT INTO vaultbase_oauth_links (id, user_id, collection_id, provider, provider_user_id, created_at) VALUES (?, ?, ?, ?, ?, 1)`);
    link.run("l-y", y, col.id, "github", "P1");
    await runBackup();

    // Tokens ended since the backup: z by a reset, y by a revocation.
    const zToken = await signUserJwt(z, "z@test.local", "users", SECRET);
    const yToken = await signUserJwt(y, "y@test.local", "users", SECRET);
    await Bun.sleep(5);
    await updateUserById(col, z, { password_reset_at: Date.now() });
    const yClaims = decodeJwt(yToken);
    await revokeToken(String(yClaims.jti), Number(yClaims.exp));
    expect(await verifyAuthToken(zToken, SECRET)).toBeNull();
    expect(await verifyAuthToken(yToken, SECRET)).toBeNull();
    // The identity moves from y to x; x resets its password too.
    raw().prepare(`DELETE FROM vaultbase_oauth_links WHERE id = 'l-y'`).run();
    link.run("l-x", x, col.id, "github", "P1");
    await updateUserById(col, x, { password_hash: "x-new", password_reset_at: Date.now() });

    const r = await restoreLatest();
    expect(r.status).toBe(200);
    expect(r.message).not.toContain("Not carried over");
    const links = raw().prepare(`SELECT id, user_id FROM vaultbase_oauth_links ORDER BY id`).all();
    expect(links).toEqual([{ id: "l-x", user_id: x }]);
    expect(await verifyAuthToken(zToken, SECRET)).toBeNull();
    expect(await verifyAuthToken(yToken, SECRET)).toBeNull();
    expect((await findUserById((await getCollection("users"))!, x))!.password_hash).toBe("x-new");
  });

  it("keeps MFA changes, unlinks and spent recovery codes that didn't raise the reset stamp", async () => {
    const uid = await seedAuthUser({ collection: "users", email: "m@test.local", passwordHash: "same" });
    const col = (await getCollection("users"))!;
    await updateUserById(col, uid, { totp_enabled: 1, totp_secret: "OLDLEAKED" });
    const link = raw().prepare(`INSERT INTO vaultbase_oauth_links (id, user_id, collection_id, provider, provider_user_id, created_at) VALUES (?, ?, ?, ?, ?, 1)`);
    link.run("l-gh", uid, col.id, "github", "gh-attacker");
    link.run("l-go", uid, col.id, "google", "go-own");
    raw().prepare(`INSERT INTO vaultbase_mfa_recovery_codes (id, user_id, collection_id, code_hash, created_at) VALUES ('rc1', ?, ?, 'h1', 1)`).run(uid, col.id);
    raw().prepare(`INSERT INTO vaultbase_mfa_recovery_lookup (hmac, recovery_id) VALUES ('hm1', 'rc1')`).run();
    await runBackup();

    await updateUserById(col, uid, { totp_secret: "FRESH" });
    raw().prepare(`DELETE FROM vaultbase_oauth_links WHERE id = 'l-gh'`).run();
    raw().prepare(`UPDATE vaultbase_mfa_recovery_codes SET used_at = 9 WHERE id = 'rc1'`).run();

    const r = await restoreLatest();
    expect(r.status).toBe(200);
    expect(r.message).toContain("1 account kept");
    const u = (await findUserById((await getCollection("users"))!, uid))!;
    expect(u.totp_secret).toBe("FRESH");
    expect(u.password_hash).toBe("same");
    expect(raw().prepare(`SELECT id FROM vaultbase_oauth_links WHERE user_id = ?`).all(uid)).toEqual([{ id: "l-go" }]);
    expect(raw().prepare(`SELECT used_at FROM vaultbase_mfa_recovery_codes WHERE id = 'rc1'`).get()).toEqual({ used_at: 9 });
  });

  it("keeps an email changed since the backup, swapped between accounts too", async () => {
    const a = await seedAuthUser({ collection: "users", email: "a@test.local", emailVerified: true });
    const b = await seedAuthUser({ collection: "users", email: "b@test.local" });
    await runBackup();
    // a moves to a new mailbox, b takes a's old one and verifies it.
    raw().prepare(`UPDATE vb_users SET email = 'a-new@test.local', email_verified = 0 WHERE id = ?`).run(a);
    raw().prepare(`UPDATE vb_users SET email = 'a@test.local', email_verified = 1 WHERE id = ?`).run(b);

    const r = await restoreLatest();
    expect(r.status).toBe(200);
    expect(r.message).toContain("2 accounts kept");
    const col = (await getCollection("users"))!;
    expect((await findUserById(col, a))!).toMatchObject({ email: "a-new@test.local", email_verified: 0 });
    expect((await findUserById(col, b))!).toMatchObject({ email: "a@test.local", email_verified: 1 });
  });

  it("an email taken over from an account deleted since the backup moves, the deleted account staying deleted", async () => {
    const a = await seedAuthUser({ collection: "users", email: "a@test.local" });
    const gone = await seedAuthUser({ collection: "users", email: "taken@test.local" });
    await runBackup();
    raw().prepare(`DELETE FROM vb_users WHERE id = ?`).run(gone);
    raw().prepare(`UPDATE vb_users SET email = 'taken@test.local' WHERE id = ?`).run(a);
    const r = await restoreLatest();
    expect(r.status).toBe(200);
    expect(r.message).not.toContain("Not carried over");
    const col = (await getCollection("users"))!;
    expect((await findUserById(col, a))!.email).toBe("taken@test.local");
    expect(await findUserById(col, gone)).toBeNull();
  });

  it("an email held by an account the restore brings back stays with it", async () => {
    const a = await seedAuthUser({ collection: "users", email: "a@test.local" });
    const gone = await seedAuthUser({ collection: "users", email: "taken@test.local" });
    await runBackup();
    raw().prepare(`DELETE FROM vb_users WHERE id = ?`).run(gone);
    raw().prepare(`UPDATE vb_users SET email = 'taken@test.local' WHERE id = ?`).run(a);
    const r = await restoreNamed((await listBackups())[0]!.name, "?bring_back_deleted_users=1");
    expect(r.status).toBe(200);
    expect(r.message).toContain("Not carried over");
    const col = (await getCollection("users"))!;
    expect((await findUserById(col, a))!.email).toBe("a@test.local");
    expect((await findUserById(col, gone))!.email).toBe("taken@test.local");
  });

  it("carried recovery codes keep their lookup rows", async () => {
    const uid = await seedAuthUser({ collection: "users", email: "rc@test.local" });
    const col = (await getCollection("users"))!;
    raw().prepare(`INSERT INTO vaultbase_mfa_recovery_codes (id, user_id, collection_id, code_hash, created_at) VALUES ('rc-old', ?, ?, 'h-old', 1)`).run(uid, col.id);
    raw().prepare(`INSERT INTO vaultbase_mfa_recovery_lookup (hmac, recovery_id) VALUES ('hm-old', 'rc-old')`).run();
    await runBackup();
    // Regenerated since the backup.
    raw().prepare(`DELETE FROM vaultbase_mfa_recovery_lookup`).run();
    raw().prepare(`DELETE FROM vaultbase_mfa_recovery_codes`).run();
    raw().prepare(`INSERT INTO vaultbase_mfa_recovery_codes (id, user_id, collection_id, code_hash, created_at) VALUES ('rc-new', ?, ?, 'h-new', 2)`).run(uid, col.id);
    raw().prepare(`INSERT INTO vaultbase_mfa_recovery_lookup (hmac, recovery_id) VALUES ('hm-new', 'rc-new')`).run();

    expect((await restoreLatest()).status).toBe(200);
    expect(raw().prepare(`SELECT id FROM vaultbase_mfa_recovery_codes`).all()).toEqual([{ id: "rc-new" }]);
    expect(raw().prepare(`SELECT hmac, recovery_id FROM vaultbase_mfa_recovery_lookup`).all()).toEqual([{ hmac: "hm-new", recovery_id: "rc-new" }]);
  });

  it("restoring a newer backup after an older one keeps the admins created between them", async () => {
    const older = (await runBackup()).name;
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(admin).values({ id: "c2", email: "second-admin@test.local", password_hash: "x", password_reset_at: 0, created_at: now });
    const minted = await mintApiToken({ name: "ci", scopes: ["admin"], createdBy: "c2", createdByEmail: "second-admin@test.local" }, SECRET);
    await Bun.sleep(5); // distinct backup names
    const newer = (await runBackup()).name;

    expect((await restoreNamed(older)).status).toBe(200);
    expect(raw().prepare(`SELECT 1 FROM vaultbase_admin WHERE id = 'c2'`).get()).toBeNull();
    const r = await restoreNamed(newer);
    expect(r.status).toBe(200);
    expect(r.message).not.toContain("second-admin@test.local");
    expect(raw().prepare(`SELECT 1 FROM vaultbase_admin WHERE id = 'c2'`).get()).not.toBeNull();
    expect(await verifyAuthToken(minted.token, SECRET)).not.toBeNull();
  });

  it("an admin created after the others and deleted since the backup stays deleted, by its audit record", async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(admin).values({ id: "a2", email: "late@test.local", password_hash: "x", password_reset_at: 0, created_at: now });
    await runBackup();
    raw().prepare(`DELETE FROM vaultbase_admin WHERE id = 'a2'`).run();
    raw().prepare(`INSERT INTO vaultbase_audit_log (id, method, path, action, target, status, at) VALUES ('del', 'DELETE', '/api/admin/admins/a2', 'admins.delete', 'a2', 200, ?)`).run(now);
    const r = await restoreLatest();
    expect(r.message).toContain("late@test.local");
    expect(raw().prepare(`SELECT 1 FROM vaultbase_admin WHERE id = 'a2'`).get()).toBeNull();
    // Its record is in the restored log now: an older backup restored next keeps it deleted too.
    expect(raw().prepare(`SELECT 1 FROM vaultbase_audit_log WHERE action = 'admins.delete' AND target = 'a2'`).get()).not.toBeNull();
  });

  it("an admin created before something both databases share and missing live was deleted", async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(admin).values({ id: "a2", email: "late@test.local", password_hash: "x", password_reset_at: 0, created_at: now });
    // An admin action after a2 existed, in the backup and live alike.
    raw().prepare(`INSERT INTO vaultbase_audit_log (id, method, path, action, status, at) VALUES ('shared', 'PATCH', '/api/admin/settings', 'settings.update', 200, ?)`).run(now + 1);
    await runBackup();
    raw().prepare(`DELETE FROM vaultbase_admin WHERE id = 'a2'`).run();
    const r = await restoreLatest();
    expect(r.message).toContain("late@test.local");
    expect(raw().prepare(`SELECT 1 FROM vaultbase_admin WHERE id = 'a2'`).get()).toBeNull();
  });
});

describe.skipIf(!onSqlite)("restore leaves maintenance mode and finished background work as they are", () => {
  const setting = (key: string, value: string) =>
    raw().prepare(`INSERT INTO vaultbase_settings (key, value, updated_at) VALUES (?, ?, 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
  const job = (id: string, status: string) =>
    raw().prepare(`INSERT INTO vaultbase_jobs_log (id, queue, payload, status, scheduled_at, enqueued_at) VALUES (?, 'emails', '{}', ?, 0, 0)`).run(id, status);
  const delivery = (id: string, status: string) =>
    raw().prepare(`INSERT INTO vaultbase_webhook_deliveries (id, webhook_id, event, payload, status, scheduled_at) VALUES (?, 'w1', 'create', '{}', ?, 0)`).run(id, status);
  const statusOf = (table: string, id: string) =>
    (raw().prepare(`SELECT status, error FROM ${table} WHERE id = ?`).get(id) as { status: string; error: string | null } | null);

  it("maintenance mode turned on before the restore stays on", async () => {
    const { backgroundPaused } = await import("../core/maintenance-mode.ts");
    const { _reloadSettings } = await import("../api/settings.ts");
    await runBackup();
    setting("maintenance_mode.enabled", "1");
    await _reloadSettings();
    expect(backgroundPaused()).toBe(true);
    const r = await restoreLatest();
    expect(r.status).toBe(200);
    expect(backgroundPaused()).toBe(true);
    expect(r.message).toContain("Maintenance mode is still on");
  });

  it("maintenance mode on in the backup but off now stays off", async () => {
    const { backgroundPaused } = await import("../core/maintenance-mode.ts");
    const { _reloadSettings } = await import("../api/settings.ts");
    setting("maintenance_mode.enabled", "1");
    await runBackup();
    raw().prepare(`DELETE FROM vaultbase_settings WHERE key LIKE 'maintenance_mode.%'`).run();
    await _reloadSettings();
    const r = await restoreLatest();
    expect(r.status).toBe(200);
    expect(backgroundPaused()).toBe(false);
    expect(r.message).not.toContain("Maintenance mode");
  });

  it("a job queued at backup time that has run since is marked dead, one still waiting stays queued", async () => {
    job("ran-since", "queued");
    job("still-waiting", "queued");
    job("pruned-since", "queued");
    await runBackup();
    raw().prepare(`UPDATE vaultbase_jobs_log SET status = 'succeeded', finished_at = 5 WHERE id = 'ran-since'`).run();
    raw().prepare(`DELETE FROM vaultbase_jobs_log WHERE id = 'pruned-since'`).run();
    job("enqueued-after", "queued");

    const r = await restoreLatest();
    expect(r.status).toBe(200);
    expect(statusOf("vaultbase_jobs_log", "ran-since")!.status).toBe("dead");
    expect(statusOf("vaultbase_jobs_log", "ran-since")!.error).toContain("Not run again after a restore");
    expect(statusOf("vaultbase_jobs_log", "pruned-since")!.status).toBe("dead");
    expect(statusOf("vaultbase_jobs_log", "still-waiting")!.status).toBe("queued");
    // Work queued after the backup belongs to data the restore rolled back.
    expect(statusOf("vaultbase_jobs_log", "enqueued-after")).toBeNull();
    expect(r.message).toContain("2 queued jobs");
  });

  it("a job running now keeps its live state and lease", async () => {
    job("running-now", "queued");
    await runBackup();
    raw().prepare(`UPDATE vaultbase_jobs_log SET status = 'running', lease_owner = 'p1', lease_until = 99, attempt = 2 WHERE id = 'running-now'`).run();
    expect((await restoreLatest()).status).toBe(200);
    expect(raw().prepare(`SELECT status, lease_owner, attempt FROM vaultbase_jobs_log WHERE id = 'running-now'`).get())
      .toEqual({ status: "running", lease_owner: "p1", attempt: 2 });
  });

  it("a webhook delivery pending at backup time and sent since isn't sent again", async () => {
    delivery("sent-since", "pending");
    delivery("still-pending", "pending");
    await runBackup();
    raw().prepare(`UPDATE vaultbase_webhook_deliveries SET status = 'succeeded' WHERE id = 'sent-since'`).run();
    const r = await restoreLatest();
    expect(r.status).toBe(200);
    expect(statusOf("vaultbase_webhook_deliveries", "sent-since")!.status).toBe("dead");
    expect(statusOf("vaultbase_webhook_deliveries", "still-pending")!.status).toBe("pending");
    expect(r.message).toContain("1 webhook delivery");
  });
});

describe.skipIf(!onSqlite)("restore and users deleted since the backup", () => {
  const verifies = async (token: string) => !!(await verifyAuthToken(token, SECRET));

  it("a member deleted since the backup stays deleted, and their old session doesn't work", async () => {
    await seedAuthUser({ collection: "members", id: "keep", email: "keep@test.local" });
    const gone = await seedAuthUser({ collection: "members", id: "gone", email: "gone@test.local" });
    const col = (await getCollection("members"))!;
    raw().prepare(`INSERT INTO vaultbase_oauth_links (id, user_id, collection_id, provider, provider_user_id, created_at) VALUES ('l1', ?, ?, 'github', 'gh-gone', 1)`).run(gone, col.id);
    const token = await signUserJwt(gone, "gone@test.local", "members", SECRET);
    await runBackup();
    raw().prepare(`DELETE FROM vb_members WHERE id = ?`).run(gone);
    raw().prepare(`DELETE FROM vaultbase_oauth_links WHERE user_id = ?`).run(gone);

    const r = await restoreLatest();
    expect(r.status).toBe(200);
    expect(r.message).toContain("Users deleted since the backup stay deleted: gone@test.local (members)");
    expect(raw().prepare(`SELECT 1 FROM vb_members WHERE id = 'gone'`).get()).toBeNull();
    expect(raw().prepare(`SELECT 1 FROM vb_members WHERE id = 'keep'`).get()).not.toBeNull();
    expect(raw().prepare(`SELECT 1 FROM vaultbase_oauth_links WHERE id = 'l1'`).get()).toBeNull();
    expect(await verifies(token)).toBe(false);
  });

  it("bring_back_deleted_users=1 brings them back, signed out of every session", async () => {
    await seedAuthUser({ collection: "members", id: "keep", email: "keep@test.local" });
    const gone = await seedAuthUser({ collection: "members", id: "gone", email: "gone@test.local" });
    const token = await signUserJwt(gone, "gone@test.local", "members", SECRET);
    await runBackup();
    raw().prepare(`DELETE FROM vb_members WHERE id = ?`).run(gone);
    await Bun.sleep(1100); // the session predates the restore's sign-out stamp by a whole second

    const r = await restoreNamed((await listBackups())[0]!.name, "?bring_back_deleted_users=1");
    expect(r.status).toBe(200);
    expect(r.message).toContain("Users deleted since the backup are back, signed out of every session: gone@test.local (members)");
    expect(raw().prepare(`SELECT 1 FROM vb_members WHERE id = 'gone'`).get()).not.toBeNull();
    expect(await verifies(token)).toBe(false);
  });

  it("restoring a newer backup after an older one keeps the users created between them", async () => {
    await seedAuthUser({ collection: "members", id: "first", email: "first@test.local" });
    raw().prepare(`UPDATE vb_members SET created_at = 1000 WHERE id = 'first'`).run();
    await runBackup();
    const older = (await listBackups())[0]!.name;
    await Bun.sleep(1100); // backup names are per second
    await seedAuthUser({ collection: "members", id: "second", email: "second@test.local" });
    raw().prepare(`UPDATE vb_members SET created_at = 2000 WHERE id = 'second'`).run();
    await runBackup();
    const newer = (await listBackups()).find((b) => b.name !== older)!.name;

    expect((await restoreNamed(older)).status).toBe(200);
    const r = await restoreNamed(newer);
    expect(r.status).toBe(200);
    expect(r.message).not.toContain("stay deleted");
    expect(raw().prepare(`SELECT 1 FROM vb_members WHERE id = 'second'`).get()).not.toBeNull();
  });
});
