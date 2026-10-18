/**
 * An online restore swapped the file under the main connection only. Read
 * workers and the checkpointer each hold their own connection and stayed on
 * the replaced file: after a successful restore every worker read answered
 * 500 ("disk I/O error") until a restart. Restore now stops them, swaps, and
 * starts them again on the restored file. A staged file that isn't a sound
 * Vaultbase database is refused before anything is touched.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { onSqlite } from "./_helpers.ts";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { initDb, closeDb, getDb, getRawClient, JOURNAL_SIZE_LIMIT } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { admin } from "../db/schema.ts";
import { signAuthToken } from "../core/sec.ts";
import { makeBackupPlugin } from "../api/backup.ts";
import { listBackups, runBackup, setBackupsDir } from "../core/backups.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { createServer } from "../server.ts";
import { startReadPool, stopReadPool, readPoolSize } from "../core/read-pool.ts";
import { startCheckpointer, stopCheckpointer, checkpointStats } from "../db/checkpointer.ts";
import { stopScheduler } from "../core/jobs.ts";
import { stopQueueScheduler } from "../core/queues.ts";
import { stopWebhookDispatcher } from "../core/webhooks.ts";
import { stopUpdateCheckScheduler } from "../core/update-check.ts";
import { _reset as resetRealtime } from "../realtime/manager.ts";
import { createPublicCollection } from "./_helpers.ts";

const SECRET = "test-secret-restore-live";
const WORKER_URL = new URL("../read-worker.ts", import.meta.url);
let dir: string;
let dbPath: string;
let app: ReturnType<typeof createServer>;

beforeAll(async () => {
  if (!onSqlite) return;
  dir = mkdtempSync(join(tmpdir(), "vb-restore-live-"));
  setLogsDir(dir);
  dbPath = join(dir, "data.db");
  await initDb(`file:${dbPath}`);
  await runMigrations();
  await getDb().insert(admin).values({ id: "a1", email: "ops@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
  setBackupsDir(join(dir, "backups"));
  await createPublicCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
  await createRecord("posts", { title: "in the backup" });
  const config = { port: 0, dataDir: dir, dbPath, uploadDir: join(dir, "u"), logsDir: join(dir, "l"), jwtSecret: SECRET, encryptionKey: undefined };
  app = createServer(config);
  await startCheckpointer(getRawClient(), dbPath, JOURNAL_SIZE_LIMIT);
  await startReadPool(2, { ...process.env as Record<string, string> }, config, WORKER_URL);
});

afterAll(async () => {
  if (!onSqlite) return;
  await stopReadPool();
  await stopCheckpointer();
  stopScheduler(); stopQueueScheduler(); stopWebhookDispatcher(); stopUpdateCheckScheduler();
  resetRealtime();
  _resetCollectionCache();
  await closeDb();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
});

const adminToken = async () => (await signAuthToken({ payload: { id: "a1" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET })).token;

const titles = async () => {
  const res = await app.handle(new Request("http://localhost/api/v1/posts"));
  return { status: res.status, worker: res.headers.get("x-vaultbase-read-worker"), body: res.status === 200 ? ((await res.json()) as { data: Array<{ title: string }> }).data.map((r) => r.title).sort() : null };
};

describe.skipIf(!onSqlite)("online restore with read workers and the checkpointer", () => {
  it("serves the restored data from the workers afterwards", async () => {
    await runBackup();
    await createRecord("posts", { title: "after the backup" });
    const before = await titles();
    expect(before.worker).not.toBeNull();
    expect(before.body).toEqual(["after the backup", "in the backup"]);

    const name = (await listBackups())[0]!.name;
    const res = await makeBackupPlugin(SECRET, dbPath).handle(new Request(`http://localhost/admin/backups/${name}/restore`, {
      method: "POST", headers: { authorization: `Bearer ${await adminToken()}` },
    }));
    expect(res.status).toBe(200);

    expect(readPoolSize()).toBe(2);
    expect(checkpointStats()?.mode).toBe("worker");
    // The restore emptied the collection cache: the first read fills it on main.
    expect((await titles()).body).toEqual(["in the backup"]);
    for (let i = 0; i < 4; i++) {
      const after = await titles();
      expect(after.status).toBe(200);
      expect(after.worker).not.toBeNull();
      expect(after.body).toEqual(["in the backup"]);
    }
    // Writes land in the restored file, and the workers see them.
    await createRecord("posts", { title: "after the restore" });
    expect((await titles()).body).toEqual(["after the restore", "in the backup"]);
  });

  it("refuses a staged file that isn't a Vaultbase database, without stopping anything", async () => {
    const other = join(dir, "other.db");
    const d = new Database(other); d.exec("CREATE TABLE t (x)"); d.close();
    const form = new FormData();
    form.set("file", new File([await Bun.file(other).arrayBuffer()], "other.db"));
    const res = await makeBackupPlugin(SECRET, dbPath).handle(new Request("http://localhost/admin/restore", {
      method: "POST", headers: { authorization: `Bearer ${await adminToken()}` }, body: form,
    }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain("vaultbase_collections");
    expect((await titles()).status).toBe(200);
  });

  it("refuses a damaged database file", async () => {
    const bad = Buffer.alloc(8192, 0);
    Buffer.from("SQLite format 3\0").copy(bad);
    writeFileSync(join(dir, "bad.db"), bad);
    const form = new FormData();
    form.set("file", new File([bad], "bad.db"));
    const res = await makeBackupPlugin(SECRET, dbPath).handle(new Request("http://localhost/admin/restore", {
      method: "POST", headers: { authorization: `Bearer ${await adminToken()}` }, body: form,
    }));
    expect(res.status).toBe(422);
    expect((await titles()).body).toEqual(["after the restore", "in the backup"]);
  });
});
