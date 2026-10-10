import { copyFileSync, existsSync, renameSync, rmSync } from "fs";
import Elysia from "elysia";
import { closeDb, initDb } from "../db/client.ts";
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
      const p = backupPath(params.name);
      if (!p) {
        set.status = 404;
        return { error: "Backup not found", code: 404 };
      }
      const staging = `${dbPath}.restore`;
      copyFileSync(p, staging);
      const err = await swapInDb(dbPath, staging);
      if (err) {
        set.status = 500;
        return { error: `Restore failed: ${err}`, code: 500 };
      }
      return { data: { message: "Restore complete. Existing tokens are still valid." } };
    })

    // Restore from uploaded SQLite file
    .post("/admin/restore", async ({ request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401;
        return { error: "Unauthorized", code: 401 };
      }

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
      const err = await swapInDb(dbPath, staging);
      if (err) {
        set.status = 500;
        return { error: `Restore failed: ${err}`, code: 500 };
      }

      return { data: { message: "Restore complete. Existing tokens are still valid." } };
    });
}
