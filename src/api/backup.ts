import { copyFileSync, existsSync, renameSync, rmSync } from "fs";
import Elysia from "elysia";
import { closeDb, getRawClient, initDb } from "../db/client.ts";
import { withExclusiveWrite } from "../core/write-gate.ts";
import { _resetCollectionCache, invalidateSensitiveSchema } from "../core/collections.ts";
import { invalidateHookCache } from "../core/hooks.ts";
import { invalidateRoutesCache } from "../core/routes.ts";
import { invalidateJobsCache } from "../core/jobs.ts";
import { invalidateWorkerCache } from "../core/queues.ts";
import { invalidateWebhookCache } from "../core/webhooks.ts";
import { invalidateFlagCache } from "../core/flags.ts";
import { clearFilterCache } from "../core/filter-cache.ts";
import { _resetVectorCache } from "../core/vector-cache.ts";
import { invalidatePreparedStatements } from "../core/records.ts";
import { invalidateUserTableColumnCache } from "../core/users-table.ts";
import { invalidateRateLimitCache } from "./ratelimit.ts";
import { invalidateEmailCache } from "../core/email.ts";
import { invalidateStorageCache } from "../core/storage.ts";
import { invalidateEgressCache } from "../core/hook-egress.ts";
import { invalidateCorsCache } from "../core/cors.ts";
import { runMigrations } from "../db/migrate.ts";
import { verifyAuthToken } from "../core/sec.ts";
import { backupPath, deleteBackup, getBackupStatus, listBackups, runBackup, snapshotTo } from "../core/backups.ts";

async function isAdmin(request: Request, jwtSecret: string): Promise<boolean> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return false;
  // Centralized verifier — fixes N-1 admin-token-bypass.
  return (await verifyAuthToken(token, jwtSecret, { audience: "admin" })) !== null;
}

// SQLite magic header — used to verify uploads
const SQLITE_MAGIC = "SQLite format 3\0";

/**
 * Replace the live DB with `staging`. The old file is kept as
 * `<db>.bak.<ms>`. Returns an error message, or null on success.
 */
async function swapInDb(dbPath: string, staging: string): Promise<string | null> {
  // Close current DB so we can replace the file on Windows
  try { closeDb(); } catch { /* ignore */ }
  // Statements still referencing the old handle keep the file open (a
  // locked file on Windows); collect them before the rename.
  Bun.gc(true);

  try {
    if (existsSync(dbPath)) {
      // remove sidecar files (WAL/SHM) so SQLite doesn't get confused
      for (const sfx of ["-shm", "-wal"]) {
        try { rmSync(`${dbPath}${sfx}`, { force: true }); } catch { /* ignore */ }
      }
      renameSync(dbPath, `${dbPath}.bak.${Date.now()}`);
    }
    renameSync(staging, dbPath);
  } catch (e) {
    // Re-init the original DB to keep the server alive
    initDb(`file:${dbPath}`);
    await runMigrations();
    return e instanceof Error ? e.message : String(e);
  }

  // Re-open and verify schema
  initDb(`file:${dbPath}`);
  await runMigrations();
  return null;
}

/**
 * Swap in a restored database safely, in a single process:
 * - with the exclusive write gate, so no write lands on the closing handle;
 * - keeping every token revocation made since the backup was taken — a
 *   restore used to bring back sessions that had been signed out or
 *   revoked, API tokens included;
 * - dropping every in-memory cache built from the old database (collections,
 *   hooks, routes, jobs, workers, settings-derived caches), which kept
 *   serving the replaced schema and code until restart.
 */
async function restoreDatabase(dbPath: string, staging: string): Promise<string | null> {
  return withExclusiveWrite(async () => {
    const now = Math.floor(Date.now() / 1000);
    const revoked = getRawClient()
      .prepare(`SELECT jti, expires_at, revoked_at FROM vaultbase_token_revocations WHERE expires_at > ?`)
      .all(now) as Array<{ jti: string; expires_at: number; revoked_at: number }>;
    // "Sign out everywhere" and password resets work by raising a
    // principal's password_reset_at; the restored rows would lower it again
    // and revive every token those ended (API tokens follow their admin).
    const resets = currentResetStamps();
    const err = await swapInDb(dbPath, staging);
    if (err) return err;
    const keep = getRawClient().prepare(
      `INSERT OR IGNORE INTO vaultbase_token_revocations (jti, expires_at, revoked_at) VALUES (?, ?, ?)`,
    );
    for (const r of revoked) keep.run(r.jti, r.expires_at, r.revoked_at);
    reapplyResetStamps(resets);
    for (const reset of [
      _resetCollectionCache, invalidateSensitiveSchema, invalidateHookCache, invalidateRoutesCache,
      invalidateJobsCache, invalidateWorkerCache, invalidateWebhookCache, invalidateFlagCache,
      clearFilterCache, _resetVectorCache, invalidatePreparedStatements, () => invalidateUserTableColumnCache(),
      invalidateRateLimitCache, invalidateEmailCache, invalidateStorageCache, invalidateEgressCache,
      invalidateCorsCache,
    ]) {
      try { reset(); } catch { /* a cache that isn't loaded */ }
    }
    return null;
  });
}

type ResetStamps = Array<{ table: string; rows: Array<{ id: string; password_reset_at: number }> }>;

/** password_reset_at of every admin and every auth-collection user. */
function currentResetStamps(): ResetStamps {
  const db = getRawClient();
  const tables = ["vaultbase_admin"];
  try {
    const cols = db.prepare(`SELECT name FROM vaultbase_collections WHERE type = 'auth'`).all() as Array<{ name: string }>;
    for (const c of cols) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.name)) tables.push(`vb_${c.name}`);
  } catch { /* no collections table */ }
  const out: ResetStamps = [];
  for (const table of tables) {
    try {
      const rows = db.prepare(`SELECT id, password_reset_at FROM "${table}" WHERE password_reset_at > 0`).all() as Array<{ id: string; password_reset_at: number }>;
      out.push({ table, rows });
    } catch { /* table or column missing */ }
  }
  return out;
}

/** Raise password_reset_at back to the pre-restore value where the restore lowered it. */
function reapplyResetStamps(stamps: ResetStamps): void {
  const db = getRawClient();
  for (const { table, rows } of stamps) {
    let stmt;
    try {
      stmt = db.prepare(`UPDATE "${table}" SET password_reset_at = ? WHERE id = ? AND password_reset_at < ?`);
    } catch { continue; /* table not in the restored database */ }
    for (const r of rows) stmt.run(r.password_reset_at, r.id, r.password_reset_at);
  }
}

/**
 * In cluster mode each worker holds its own connection and caches; a swap
 * in one worker leaves the others on the old database file (and their writes
 * landing in it). Restore offline instead: stop the service, replace
 * data.db, start it.
 */
function clusterRestoreRefusal(set: { status?: number | string }) {
  if (!process.env["VAULTBASE_WORKER_ID"]) return null;
  set.status = 409;
  return {
    error: "Online restore isn't supported in cluster mode. Stop the service, replace data.db with the backup, and start it again.",
    code: 409,
  };
}

export function makeBackupPlugin(jwtSecret: string, dbPath: string) {
  return new Elysia({ name: "backup" })
    // Download SQLite snapshot
    .get("/admin/backup", async ({ request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401;
        return { error: "Unauthorized", code: 401 };
      }
      if (!existsSync(dbPath)) {
        set.status = 404;
        return { error: "Database file not found", code: 404 };
      }
      // Snapshot rather than stream the live file: under WAL the main file
      // alone can miss committed pages.
      const snap = `${dbPath}.download-${Date.now()}`;
      let bytes: Uint8Array;
      try {
        snapshotTo(snap);
        bytes = await Bun.file(snap).bytes();
      } finally {
        rmSync(snap, { force: true });
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      set.headers["Content-Type"] = "application/octet-stream";
      set.headers["Content-Disposition"] = `attachment; filename="vaultbase-backup-${stamp}.db"`;
      return new Response(bytes);
    })

    // Stored backups + schedule status
    .get("/admin/backups", async ({ request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401;
        return { error: "Unauthorized", code: 401 };
      }
      return { data: { items: listBackups(), status: getBackupStatus() } };
    })

    // Take a backup now (same pipeline as the schedule: local, S3, prune)
    .post("/admin/backups", async ({ request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401;
        return { error: "Unauthorized", code: 401 };
      }
      try {
        return { data: await runBackup() };
      } catch (e) {
        set.status = 500;
        return { error: `Backup failed: ${e instanceof Error ? e.message : String(e)}`, code: 500 };
      }
    })

    .get("/admin/backups/:name", async ({ request, params, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401;
        return { error: "Unauthorized", code: 401 };
      }
      const p = backupPath(params.name);
      if (!p) {
        set.status = 404;
        return { error: "Backup not found", code: 404 };
      }
      set.headers["Content-Type"] = "application/octet-stream";
      set.headers["Content-Disposition"] = `attachment; filename="${params.name}"`;
      return new Response(Bun.file(p));
    })

    .delete("/admin/backups/:name", async ({ request, params, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401;
        return { error: "Unauthorized", code: 401 };
      }
      if (!deleteBackup(params.name)) {
        set.status = 404;
        return { error: "Backup not found", code: 404 };
      }
      return { data: { deleted: params.name } };
    })

    .post("/admin/backups/:name/restore", async ({ request, params, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401;
        return { error: "Unauthorized", code: 401 };
      }
      const refused = clusterRestoreRefusal(set);
      if (refused) return refused;
      const p = backupPath(params.name);
      if (!p) {
        set.status = 404;
        return { error: "Backup not found", code: 404 };
      }
      const staging = `${dbPath}.restore`;
      copyFileSync(p, staging);
      const err = await restoreDatabase(dbPath, staging);
      if (err) {
        set.status = 500;
        return { error: `Restore failed: ${err}`, code: 500 };
      }
      return { data: { message: "Restore complete. Sessions revoked since the backup stay revoked." } };
    })

    // Restore from uploaded SQLite file
    .post("/admin/restore", async ({ request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401;
        return { error: "Unauthorized", code: 401 };
      }

      const refused = clusterRestoreRefusal(set);
      if (refused) return refused;
      const formData = await request.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        set.status = 400;
        return { error: "No file uploaded (expected multipart 'file' field)", code: 400 };
      }

      // Magic header check
      const sliced = file.slice(0, SQLITE_MAGIC.length);
      const header = sliced instanceof Blob ? await sliced.text() : String(sliced);
      if (header !== SQLITE_MAGIC) {
        set.status = 422;
        return { error: "File is not a valid SQLite database", code: 422 };
      }

      // Write to a staging path next to the live DB
      const staging = `${dbPath}.restore`;
      await Bun.write(staging, file);
      const err = await restoreDatabase(dbPath, staging);
      if (err) {
        set.status = 500;
        return { error: `Restore failed: ${err}`, code: 500 };
      }

      return { data: { message: "Restore complete. Sessions revoked since the backup stay revoked." } };
    });
}
