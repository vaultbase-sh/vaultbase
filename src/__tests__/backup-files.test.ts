/**
 * Uploaded files in backups (backup-files.ts): a manifest per backup and a
 * store shared by every backup, each file kept once; restored with a stored
 * backup; pruned when no manifest lists them; mirrored to S3.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { onSqlite, testDb } from "./_helpers.ts";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { admin } from "../db/schema.ts";
import { setSetting } from "../api/settings.ts";
import { signAuthToken } from "../core/sec.ts";
import { makeBackupPlugin } from "../api/backup.ts";
import { setUploadDir, invalidateStorageCache } from "../core/storage.ts";
import { restoreTools } from "../core/pg-restore.ts";
import {
  copyFilesToS3, getBackupStatus, listBackups, pruneS3, pruneS3Files, runBackup, setBackupsDir, type S3Like,
} from "../core/backups.ts";
import { BackupBusyError, blobPath, manifestName, manifestSummary, pruneBlobs, readManifest, restoreFiles, snapshotFiles, withBackupLock } from "../core/backup-files.ts";
import { getSetting } from "../api/settings.ts";

const SECRET = "test-secret-backup-files";
let tmpDir: string;
let uploads: string;
let backups: string;
let dbPath: string;

const canBackUp = onSqlite || !!(process.env["VAULTBASE_PG_DUMP"] || Bun.which("pg_dump"));
const blobs = () => {
  const store = join(backups, "files");
  return existsSync(store) ? readdirSync(store).flatMap((s) => readdirSync(join(store, s))) : [];
};

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-backup-files-"));
  setLogsDir(tmpDir);
  uploads = join(tmpDir, "uploads");
  backups = join(tmpDir, "backups");
  mkdirSync(uploads, { recursive: true });
  dbPath = join(tmpDir, "data.db");
  await initDb(testDb(`file:${dbPath}`));
  await runMigrations();
  await getDb().insert(admin).values({ id: "a1", email: "ops@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
  setBackupsDir(backups);
  setUploadDir(uploads);
  invalidateStorageCache();
});

afterEach(async () => {
  setUploadDir("");
  await closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

describe("the file store", () => {
  it("keeps each file once, skips thumbnails and dotfiles, and reuses hashes", async () => {
    mkdirSync(backups, { recursive: true });
    writeFileSync(join(uploads, "a.png"), "aaa");
    writeFileSync(join(uploads, "b.pdf"), "bbbb");
    writeFileSync(join(uploads, "dup.png"), "aaa");
    mkdirSync(join(uploads, ".thumbs"));
    writeFileSync(join(uploads, ".thumbs", "a.png__10x10"), "t");
    writeFileSync(join(uploads, ".hidden"), "h");
    const m1 = await snapshotFiles(uploads, backups, join(backups, "one.files.json"), null);
    expect(m1.files.map((f) => f.name)).toEqual(["a.png", "b.pdf", "dup.png"]);
    expect(m1.bytes).toBe(10);
    // a.png and dup.png have the same contents: stored once.
    expect(blobs()).toHaveLength(2);
    expect(readFileSync(blobPath(backups, m1.files[0]!.sha256), "utf8")).toBe("aaa");

    writeFileSync(join(uploads, "c.txt"), "cc");
    const m2 = await snapshotFiles(uploads, backups, join(backups, "two.files.json"), m1);
    expect(m2.count).toBe(4);
    expect(blobs()).toHaveLength(3);
    expect(readManifest(join(backups, "two.files.json"))!.count).toBe(4);
  });

  it("puts back missing files, leaves the rest, and refuses names that leave the folder", async () => {
    mkdirSync(backups, { recursive: true });
    writeFileSync(join(uploads, "keep.png"), "k");
    writeFileSync(join(uploads, "lost.png"), "lost!");
    const m = await snapshotFiles(uploads, backups, join(backups, "x.files.json"), null);
    rmSync(join(uploads, "lost.png"));
    writeFileSync(join(uploads, "new.png"), "added later");
    const evil = { ...m, files: [...m.files, { name: "../escape.txt", sha256: m.files[0]!.sha256, size: 1, mtime: 0 }] };
    expect(await restoreFiles(evil, backups, uploads)).toEqual({ restored: 1, present: 1, missing: 0 });
    expect(readFileSync(join(uploads, "lost.png"), "utf8")).toBe("lost!");
    expect(existsSync(join(uploads, "new.png"))).toBe(true);
    expect(existsSync(join(tmpDir, "escape.txt"))).toBe(false);
  });

  it("prunes only files no manifest lists, and nothing when a manifest doesn't read", async () => {
    mkdirSync(backups, { recursive: true });
    writeFileSync(join(uploads, "a.png"), "a");
    await snapshotFiles(uploads, backups, join(backups, "one.files.json"), null);
    writeFileSync(join(uploads, "b.png"), "b");
    await snapshotFiles(uploads, backups, join(backups, "two.files.json"), null);
    writeFileSync(join(backups, "broken.files.json"), "{not json");
    expect(pruneBlobs(backups)).toBe(0);
    rmSync(join(backups, "broken.files.json"));
    rmSync(join(backups, "two.files.json"));
    expect(pruneBlobs(backups)).toBe(1);
    expect(blobs()).toHaveLength(1);
  });
});

describe.skipIf(!canBackUp)("backups with files", () => {
  it("keep the uploads with each backup, and prune them with it", async () => {
    await setSetting("backups.keep", "1");
    writeFileSync(join(uploads, "a.png"), "aaa");
    const first = await runBackup();
    expect(first.files).toEqual({ count: 1, bytes: 3, skipped: 0 });
    expect(existsSync(join(backups, manifestName(first.name)))).toBe(true);
    expect(getBackupStatus().files).toBe(true);

    rmSync(join(uploads, "a.png"));
    writeFileSync(join(uploads, "b.png"), "bb");
    const second = await runBackup();
    // The first backup is pruned, its manifest with it, and a.png's stored copy after.
    expect(listBackups().map((b) => b.name)).toEqual([second.name]);
    expect(existsSync(join(backups, manifestName(first.name)))).toBe(false);
    expect(blobs()).toHaveLength(1);
    expect(listBackups()[0]!.files).toEqual({ count: 1, bytes: 2, skipped: 0 });
  });

  it("can be turned off, and do nothing with storage that isn't local", async () => {
    writeFileSync(join(uploads, "a.png"), "aaa");
    await setSetting("backups.files", "0");
    expect((await runBackup()).files).toBeUndefined();
    await setSetting("backups.files", "1");
    await setSetting("storage.driver", "s3");
    invalidateStorageCache();
    expect(getBackupStatus().files).toBe(false);
  });

  it("are restored with a stored backup", async () => {
    if (!onSqlite && !restoreTools()) return;
    writeFileSync(join(uploads, "photo.png"), "pixels");
    const { name } = await runBackup();
    rmSync(join(uploads, "photo.png"));
    const { token } = await signAuthToken({ payload: { id: "a1" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET });
    const res = await makeBackupPlugin(SECRET, dbPath).handle(new Request(`http://localhost/admin/backups/${name}/restore`, {
      method: "POST", headers: { authorization: `Bearer ${token}` },
    }));
    const text = await res.text();
    expect(text).toContain("Files: 1 put back, 0 already in place.");
    expect(readFileSync(join(uploads, "photo.png"), "utf8")).toBe("pixels");
  });
});


describe("review fixes", () => {
  const root = process.getuid?.() === 0;

  it("skip a file that can't be read, and say so, without failing the backup", async () => {
    if (root || process.platform === "win32") return;
    writeFileSync(join(uploads, "ok.png"), "ok");
    writeFileSync(join(uploads, "locked.png"), "locked");
    chmodSync(join(uploads, "locked.png"), 0o000);
    try {
      const info = await runBackup();
      expect(info.files).toEqual({ count: 1, bytes: 2, skipped: 1 });
      expect(getSetting("backups.last_error", "")).toContain("1 uploaded file couldn't be read");
      const m = readManifest(join(backups, manifestName(info.name)))!;
      expect(m.skipped_files![0]!.name).toBe("locked.png");
    } finally {
      chmodSync(join(uploads, "locked.png"), 0o644);
    }
  });

  it("restore a file whose contents changed at the same size", async () => {
    mkdirSync(backups, { recursive: true });
    writeFileSync(join(uploads, "same.png"), "good!");
    const m = await snapshotFiles(uploads, backups, join(backups, "x.files.json"), null);
    writeFileSync(join(uploads, "same.png"), "bad!!");
    expect(await restoreFiles(m, backups, uploads)).toEqual({ restored: 1, present: 0, missing: 0 });
    expect(readFileSync(join(uploads, "same.png"), "utf8")).toBe("good!");
  });

  it("refuse names that would leave the uploads folder on Windows too", async () => {
    mkdirSync(backups, { recursive: true });
    writeFileSync(join(uploads, "a.png"), "a");
    const m = await snapshotFiles(uploads, backups, join(backups, "x.files.json"), null);
    rmSync(join(uploads, "a.png"));
    const sha = m.files[0]!.sha256;
    const evil = { ...m, files: [{ name: "..\\..\\x.txt", sha256: sha, size: 1, mtime: 0 }, { name: "C:x.txt", sha256: sha, size: 1, mtime: 0 }, { name: "a.png:ads", sha256: sha, size: 1, mtime: 0 }] };
    expect(await restoreFiles(evil, backups, uploads)).toEqual({ restored: 0, present: 0, missing: 0 });
  });

  it("let one backup at a time use the folder, and take over a lock whose process is gone", async () => {
    let inner: unknown = null;
    await withBackupLock(backups, async () => {
      inner = await withBackupLock(backups, async () => "ran").catch((e) => e);
    });
    expect(inner).toBeInstanceOf(BackupBusyError);
    writeFileSync(join(backups, ".lock"), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    expect(await withBackupLock(backups, async () => "taken over")).toBe("taken over");
    expect(existsSync(join(backups, ".lock"))).toBe(false);
  });

  it("prune temp files left by a run that died, after a day", async () => {
    mkdirSync(join(backups, "files", "tmp"), { recursive: true });
    const old = join(backups, "files", "tmp", "1-old.tmp");
    const fresh = join(backups, "files", "tmp", "1-fresh.tmp");
    writeFileSync(old, "x");
    writeFileSync(fresh, "x");
    const twoDays = Date.now() / 1000 - 2 * 86_400;
    utimesSync(old, twoDays, twoDays);
    pruneBlobs(backups);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("keep serving while it snapshots: timers fire during the run", async () => {
    mkdirSync(backups, { recursive: true });
    for (let i = 0; i < 300; i++) writeFileSync(join(uploads, `f${i}.bin`), `content ${i}`);
    let ticks = 0;
    const t = setInterval(() => { ticks++; }, 1);
    try {
      await snapshotFiles(uploads, backups, join(backups, "x.files.json"), null);
    } finally {
      clearInterval(t);
    }
    expect(ticks).toBeGreaterThan(0);
    expect(manifestSummary(join(backups, "x.files.json"))).toEqual({ count: 300, bytes: readManifest(join(backups, "x.files.json"))!.bytes, skipped: 0 });
  });

  it("report a file error after the database came back as part of a successful restore", async () => {
    if (root || process.platform === "win32" || (!onSqlite && !restoreTools())) return;
    writeFileSync(join(uploads, "photo.png"), "pixels");
    const { name } = await runBackup();
    rmSync(join(uploads, "photo.png"));
    chmodSync(uploads, 0o500);
    try {
      const { token } = await signAuthToken({ payload: { id: "a1" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET });
      const res = await makeBackupPlugin(SECRET, dbPath).handle(new Request(`http://localhost/admin/backups/${name}/restore`, {
        method: "POST", headers: { authorization: `Bearer ${token}` },
      }));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("The files couldn't all be put back");
    } finally {
      chmodSync(uploads, 0o755);
    }
  });
});

describe("the S3 copy", () => {
  // In memory, with the S3 client's shape.
  const fakeS3 = () => {
    const objects = new Map<string, string>();
    const client: S3Like = {
      async write(key, data) { objects.set(key, typeof data === "string" ? data : await data.text()); },
      async delete(key) { objects.delete(key); },
      async list(opts) {
        const contents = [...objects.keys()].filter((k) => k.startsWith(opts?.prefix ?? "")).sort().map((key) => ({ key }));
        return { contents, isTruncated: false };
      },
      file(key) { return { text: async () => objects.get(key) ?? "" }; },
    };
    return { objects, target: { client, prefix: "vb/" } };
  };

  it("uploads only files the bucket lacks, the manifest last, and prunes with the backups", async () => {
    mkdirSync(backups, { recursive: true });
    const { objects, target } = fakeS3();
    writeFileSync(join(uploads, "a.png"), "aaa");
    const m1 = await snapshotFiles(uploads, backups, join(backups, manifestName("vaultbase-20260101-000000-000.db")), null);
    await target.client.write("vb/vaultbase-20260101-000000-000.db", "db1");
    await copyFilesToS3(target, "vaultbase-20260101-000000-000.db", m1);
    writeFileSync(join(uploads, "b.png"), "bb");
    const m2 = await snapshotFiles(uploads, backups, join(backups, manifestName("vaultbase-20260102-000000-000.db")), m1);
    await target.client.write("vb/vaultbase-20260102-000000-000.db", "db2");
    let writes = 0;
    const write = target.client.write.bind(target.client);
    target.client.write = async (k, d, o) => { writes++; return write(k, d, o); };
    await copyFilesToS3(target, "vaultbase-20260102-000000-000.db", m2);
    // b.png and the manifest: a.png is there already.
    expect(writes).toBe(2);
    expect([...objects.keys()].filter((k) => k.startsWith("vb/files/"))).toHaveLength(2);

    // An empty prefix (a shared bucket) never prunes stored files.
    await pruneS3Files({ client: target.client, prefix: "" });
    expect([...objects.keys()].filter((k) => k.startsWith("vb/files/"))).toHaveLength(2);

    // Keep 1: the older backup and its manifest go, then the file only it listed.
    rmSync(join(uploads, "a.png"));
    const m3 = await snapshotFiles(uploads, backups, join(backups, manifestName("vaultbase-20260103-000000-000.db")), m2);
    await target.client.write("vb/vaultbase-20260103-000000-000.db", "db3");
    await copyFilesToS3(target, "vaultbase-20260103-000000-000.db", m3);
    await pruneS3(target, 1);
    await pruneS3Files(target);
    expect([...objects.keys()].sort()).toEqual([
      `vb/files/${m3.files[0]!.sha256.slice(0, 2)}/${m3.files[0]!.sha256}`,
      "vb/vaultbase-20260103-000000-000.db",
      "vb/vaultbase-20260103-000000-000.files.json",
    ]);
  });
});
