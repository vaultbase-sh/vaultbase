import { existsSync, renameSync } from "fs";
import Elysia from "elysia";
import { closeDb, initDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { verifyAuthToken } from "../core/sec.ts";

async function isAdmin(request: Request, jwtSecret: string): Promise<boolean> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return false;
  // Centralized verifier — fixes N-1 admin-token-bypass.
  return (await verifyAuthToken(token, jwtSecret, { audience: "admin" })) !== null;
}

// SQLite magic header — used to verify uploads
const SQLITE_MAGIC = "SQLite format 3\0";

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
      const file = Bun.file(dbPath);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      set.headers["Content-Type"] = "application/octet-stream";
      set.headers["Content-Disposition"] = `attachment; filename="vaultbase-backup-${stamp}.db"`;
      return new Response(file);
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

      // Close current DB so we can replace the file on Windows
      try { closeDb(); } catch { /* ignore */ }

      try {
        // Replace live DB with uploaded copy
        if (existsSync(dbPath)) {
          // remove sidecar files (WAL/SHM) so SQLite doesn't get confused
          for (const sfx of ["-shm", "-wal"]) {
            const sidecar = `${dbPath}${sfx}`;
            if (existsSync(sidecar)) {
              try { (await import("fs")).rmSync(sidecar); } catch { /* ignore */ }
            }
          }
          renameSync(dbPath, `${dbPath}.bak.${Date.now()}`);
        }
        renameSync(staging, dbPath);
      } catch (e) {
        // Re-init the original DB to keep the server alive
        initDb(`file:${dbPath}`);
        await runMigrations();
        set.status = 500;
        return { error: `Restore failed: ${e instanceof Error ? e.message : String(e)}`, code: 500 };
      }

      // Re-open and verify schema
      initDb(`file:${dbPath}`);
      await runMigrations();

      return { data: { message: "Restore complete. Existing tokens are still valid." } };
    });
}
