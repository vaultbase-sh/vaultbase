/**
 * Scheduled backups: snapshot, retention, schedule claim, admin API.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { createPublicCollection, onSqlite } from "./_helpers.ts";
import { createRecord, listRecords } from "../core/records.ts";
import { queryStatsReport, resetQueryStats } from "../core/query-stats.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";

import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { admin } from "../db/schema.ts";
import { getSetting, setSetting, makeSettingsPlugin } from "../api/settings.ts";
import { signAuthToken } from "../core/sec.ts";
import { makeBackupPlugin } from "../api/backup.ts";
import {
  backupTick, getBackupStatus, isBackupName, listBackups, runBackup, setBackupsDir,
} from "../core/backups.ts";
import { nextRunFromCron } from "../core/jobs.ts";

const SECRET = "test-secret-backups";
let tmpDir: string;
let dbPath: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-backups-"));
  setLogsDir(tmpDir);
  dbPath = join(tmpDir, "data.db");
  await initDb(`file:${dbPath}`);
  await runMigrations();
  await getDb().insert(admin).values({
    id: "a1", email: "ops@test.local", password_hash: "x", password_reset_at: 0, created_at: 0,
  });
  setBackupsDir(join(tmpDir, "backups"));
});

afterEach(async () => {
  await closeDb();
  // Windows keeps the mmap'd DB locked until GC; leave the tmp dir behind there.
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* EBUSY on Windows */ }
});

async function adminReq(method: string, path: string, body?: unknown): Promise<Request> {
  const { token } = await signAuthToken({ payload: { id: "a1" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET });
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost${path}`, {
    method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe.skipIf(!onSqlite)("runBackup", () => {
  it("writes a restorable snapshot", async () => {
    setSetting("probe", "hello");
    const info = await runBackup();
    expect(isBackupName(info.name)).toBe(true);
    const snap = new Database(join(tmpDir, "backups", info.name), { readonly: true });
    const row = snap.prepare(`SELECT value FROM vaultbase_settings WHERE key = 'probe'`).get() as { value: string };
    snap.close();
    expect(row.value).toBe("hello");
    expect(getSetting("backups.last_error", "x")).toBe("");
  });

  it("keeps only backups.keep snapshots", async () => {
    setSetting("backups.keep", "2");
    for (let i = 0; i < 4; i++) await runBackup();
    const items = listBackups();
    expect(items.length).toBe(2);
    // Newest first; runs in the same millisecond still get distinct names.
    expect(items[0]!.name > items[1]!.name).toBe(true);
  });

  it("records the error when S3 is enabled without credentials", async () => {
    setSetting("backups.s3.enabled", "1");
    await expect(runBackup()).rejects.toThrow(/credentials/);
    expect(getBackupStatus().last_error).toMatch(/credentials/);
    // The local snapshot still exists.
    expect(listBackups().length).toBe(1);
  });
});

describe.skipIf(!onSqlite)("backup after the index-suggestions report", () => {
  // EXPLAIN QUERY PLAN over an FTS5 MATCH stays "in progress" after its last
  // row; held in the statement cache it made every VACUUM INTO fail
  // ("SQL statements in progress") until restart.
  it("still works once a search query's plan has been read", async () => {
    resetQueryStats();
    await createPublicCollection({ name: "notes", fields: JSON.stringify([{ name: "title", type: "text", options: { searchable: true } }]) });
    await createRecord("notes", { title: "quick brown fox" });
    await listRecords("notes", { search: "fox" });
    await queryStatsReport();
    expect((await runBackup()).size).toBeGreaterThan(0);
  });
});

describe.skipIf(!onSqlite)("backupTick", () => {
  it("does nothing while disabled", async () => {
    expect(await backupTick()).toBeNull();
    expect(getSetting("backups.next_run", "")).toBe("");
  });

  it("plans, then runs once when due", async () => {
    setSetting("backups.enabled", "1");
    setSetting("backups.cron", "0 * * * *");
    const now = 1_800_000_000;
    expect(await backupTick(now)).toBeNull();
    const due = nextRunFromCron("0 * * * *", now);
    expect(getSetting("backups.next_run", "")).toBe(`0 * * * *|${due}`);

    // Two workers racing the same due tick: one claim wins.
    const [a, b] = await Promise.all([backupTick(due), backupTick(due)]);
    expect([a, b].filter(Boolean).length).toBe(1);
    expect(listBackups().length).toBe(1);
    expect(getSetting("backups.next_run", "")).toBe(`0 * * * *|${nextRunFromCron("0 * * * *", due)}`);
  });

  it("re-plans when the cron changes", async () => {
    setSetting("backups.enabled", "1");
    setSetting("backups.next_run", "0 3 * * *|1");
    setSetting("backups.cron", "30 4 * * *");
    expect(await backupTick(1_800_000_000)).toBeNull();
    expect(getSetting("backups.next_run", "")).toStartWith("30 4 * * *|");
  });
});

describe.skipIf(!onSqlite)("admin API", () => {
  it("rejects anonymous callers", async () => {
    const res = await makeBackupPlugin(SECRET, dbPath).handle(new Request("http://localhost/admin/backups"));
    expect(res.status).toBe(401);
  });

  it("creates, lists, downloads and deletes", async () => {
    const app = makeBackupPlugin(SECRET, dbPath);
    const created = await (await app.handle(await adminReq("POST", "/admin/backups"))).json() as { data: { name: string } };
    const name = created.data.name;

    const list = await (await app.handle(await adminReq("GET", "/admin/backups"))).json() as {
      data: { items: { name: string }[]; status: { enabled: boolean } };
    };
    expect(list.data.items.map((i) => i.name)).toEqual([name]);
    expect(list.data.status.enabled).toBe(false);

    const dl = await app.handle(await adminReq("GET", `/admin/backups/${name}`));
    expect(dl.status).toBe(200);
    expect(new TextDecoder().decode((await dl.arrayBuffer()).slice(0, 15))).toBe("SQLite format 3");

    expect((await app.handle(await adminReq("DELETE", `/admin/backups/${name}`))).status).toBe(200);
    expect(listBackups().length).toBe(0);
  });

  it("refuses names outside the backups directory", async () => {
    const app = makeBackupPlugin(SECRET, dbPath);
    for (const name of ["..%2Fdata.db", "data.db", "vaultbase-x.db", "vaultbase-20261011-030000.db"]) {
      expect((await app.handle(await adminReq("GET", `/admin/backups/${name}`))).status).toBe(404);
    }
  });

  it("restores a stored backup", async () => {
    const app = makeBackupPlugin(SECRET, dbPath);
    setSetting("probe", "before");
    const { name } = await runBackup();
    setSetting("probe", "after");
    const res = await app.handle(await adminReq("POST", `/admin/backups/${name}/restore`));
    expect(await res.text()).toContain("Restore complete");
    expect(getSetting("probe", "")).toBe("before");
    expect(existsSync(join(tmpDir, "backups", name))).toBe(true);
  });

  it("legacy download is a consistent snapshot", async () => {
    setSetting("probe", "wal-only");
    const res = await makeBackupPlugin(SECRET, dbPath).handle(await adminReq("GET", "/admin/backup"));
    expect(res.status).toBe(200);
    const out = join(tmpDir, "dl.db");
    await Bun.write(out, await res.arrayBuffer());
    const db = new Database(out, { readonly: true });
    const row = db.prepare(`SELECT value FROM vaultbase_settings WHERE key = 'probe'`).get() as { value: string };
    db.close();
    expect(row.value).toBe("wal-only");
    expect(readFileSync(out).length).toBeGreaterThan(0);
  });
});

describe.skipIf(!onSqlite)("settings validation", () => {
  it("rejects a bad cron or keep", async () => {
    const app = makeSettingsPlugin(SECRET);
    expect((await app.handle(await adminReq("PATCH", "/admin/settings", { "backups.cron": "nope" }))).status).toBe(422);
    expect((await app.handle(await adminReq("PATCH", "/admin/settings", { "backups.keep": "0" }))).status).toBe(422);
    expect((await app.handle(await adminReq("PATCH", "/admin/settings", { "backups.keep": "14" }))).status).toBe(200);
  });
});
