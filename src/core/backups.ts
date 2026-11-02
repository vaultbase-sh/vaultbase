/**
 * Scheduled database backups.
 *
 * Each run takes a `VACUUM INTO` snapshot of the live DB into
 * `<dataDir>/backups/`, optionally copies it to an S3-compatible bucket,
 * then prunes both locations down to `backups.keep` snapshots.
 *
 * Settings (all in `vaultbase_settings`):
 *   backups.enabled            "1" turns the schedule on
 *   backups.cron               5-field cron, UTC (default: daily 03:00)
 *   backups.keep               snapshots to keep per location (default 7)
 *   backups.s3.enabled         "1" also uploads to S3
 *   backups.s3.endpoint / bucket / region / access_key_id /
 *   backups.s3.secret_access_key / prefix
 *
 * The bucket is separate from file storage on purpose: a storage bucket is
 * often public behind a CDN, and a DB snapshot holds every password hash.
 *
 * With local file storage, each backup also keeps the uploaded files
 * (backup-files.ts; `backups.files`, on by default): a manifest next to the
 * snapshot and a store of the files shared by every backup. The S3 copy
 * mirrors that layout, so its prefix synced into a new server's backups
 * folder restores from the admin like a local backup.
 *
 * Cluster mode: every worker runs the ticker, but a run is claimed with a
 * conditional UPDATE on `backups.next_run`, so exactly one worker wins.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync } from "fs";
import { join } from "path";
import { getRawClient } from "../db/client.ts";
import { db, getDriver } from "../db/index.ts";
import { getSetting, setSetting, invalidateSetting } from "../api/settings.ts";
import { nextRunFromCron, validateCron } from "./jobs.ts";
import { blobPath, latestManifest, manifestName, manifestSummary, pruneBlobs, readManifest, restoreFiles, snapshotFiles, withBackupLock, type FilesManifest, type FilesRestoreResult } from "./backup-files.ts";
import { localUploadDir } from "./storage.ts";

export const DEFAULT_BACKUP_CRON = "0 3 * * *";
export const DEFAULT_BACKUP_KEEP = 7;
export const MAX_BACKUP_KEEP = 1000;

const NAME_RE = /^vaultbase-\d{8}-\d{6}-\d{3}\.(db|dump)$/;

let backupsDir = "";
let ticker: ReturnType<typeof setInterval> | null = null;
let running: Promise<BackupInfo> | null = null;

export interface BackupInfo {
  name: string;
  size: number;
  created_at: number;
  /** The uploaded files kept with it, when it has them; `skipped` couldn't be read. */
  files?: { count: number; bytes: number; skipped: number };
}

export interface BackupStatus {
  enabled: boolean;
  cron: string;
  keep: number;
  s3: boolean;
  /** Whether backups keep the uploaded files (local storage with `backups.files` on). */
  files: boolean;
  next_run_at: number | null;
  last_run_at: number | null;
  last_error: string | null;
}

export function setBackupsDir(dir: string): void {
  backupsDir = dir;
}

export function isBackupName(name: string): boolean {
  return NAME_RE.test(name);
}

export function backupPath(name: string): string | null {
  if (!isBackupName(name)) return null;
  const p = join(backupsDir, name);
  return existsSync(p) ? p : null;
}

/** The manifest of the files kept with a backup, if it has one. */
export function backupFiles(name: string): FilesManifest | null {
  if (!isBackupName(name)) return null;
  return readManifest(join(backupsDir, manifestName(name)));
}

/**
 * After a stored backup's database is restored, put back the uploaded files
 * it kept. Null when it kept none, or storage isn't local now.
 */
export async function restoreBackupFiles(name: string): Promise<FilesRestoreResult | { error: string } | null> {
  const manifest = backupFiles(name);
  const uploads = localUploadDir();
  if (!manifest || !uploads) return null;
  // The database is back by now: a file error is reported with the success, not as a failed restore.
  try {
    return await restoreFiles(manifest, backupsDir, uploads);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** A sentence for the restore's message, or "". */
export function filesRestoreMessage(r: FilesRestoreResult | { error: string } | null): string {
  if (!r) return "";
  if ("error" in r) return ` The files couldn't all be put back: ${r.error}`;
  const missing = r.missing > 0 ? ` ${r.missing} file${r.missing === 1 ? " was" : "s were"} missing from the backup store.` : "";
  return ` Files: ${r.restored} put back, ${r.present} already in place.${missing}`;
}

/** Where uploaded files are backed up from: local storage with `backups.files` on. */
function filesSource(): string | null {
  if (getSetting("backups.files", "1") === "0") return null;
  return localUploadDir();
}

export function validateBackupKeep(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_BACKUP_KEEP) return `must be a whole number between 1 and ${MAX_BACKUP_KEEP}`;
  return null;
}

function keepCount(): number {
  const n = parseInt(getSetting("backups.keep", String(DEFAULT_BACKUP_KEEP)), 10);
  return validateBackupKeep(n) === null ? n : DEFAULT_BACKUP_KEEP;
}

function cronExpr(): string {
  const c = getSetting("backups.cron", DEFAULT_BACKUP_CRON).trim();
  return validateCron(c) === null ? c : DEFAULT_BACKUP_CRON;
}

/** `vaultbase-20261011-030000-000.db` (UTC), so lexical order is chronological. */
function stampName(ms: number, ext: string): string {
  const iso = new Date(ms).toISOString(); // 2026-10-11T03:00:00.000Z
  return `vaultbase-${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}-${iso.slice(20, 23)}.${ext}`;
}

/** The pg_dump binary: `VAULTBASE_PG_DUMP`, or `pg_dump` on the PATH. Null when there is none. */
export function pgDumpBinary(): string | null {
  const named = process.env["VAULTBASE_PG_DUMP"];
  if (named) return existsSync(named) ? named : Bun.which(named);
  return Bun.which("pg_dump");
}

/**
 * The connection for a Postgres client tool (pg_dump, pg_restore): the URL
 * without its password, and the password in PGPASSWORD. Any user on the
 * host can read a command line (`ps`); a process's environment only its
 * owner. The query string is edited as text: re-encoding it would turn
 * `%20` in `options=-c%20search_path%3D…` into `+`, which libpq doesn't read
 * as a space.
 */
export function pgToolConnection(url: string): { dbname: string; env: Record<string, string> } {
  const decode = (v: string) => { try { return decodeURIComponent(v); } catch { return v; } };
  let password = "";
  let dbname = url;
  // user:password@ in the authority. The authority runs from :// to the
  // first / ? or #, and its user part to the last @ (a password may hold an
  // unencoded @); the password is percent-decoded, as libpq does.
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(url);
  if (scheme) {
    const from = scheme[0].length;
    const rest = url.slice(from);
    const authEnd = rest.search(/[/?#]/);
    const authority = authEnd < 0 ? rest : rest.slice(0, authEnd);
    const at = authority.lastIndexOf("@");
    if (at >= 0) {
      const userinfo = authority.slice(0, at);
      const colon = userinfo.indexOf(":");
      if (colon >= 0) {
        password = decode(userinfo.slice(colon + 1));
        dbname = url.slice(0, from) + userinfo.slice(0, colon) + authority.slice(at) + rest.slice(authority.length);
      }
    }
  }
  // password=… in the query string. libpq reads the query after the
  // authority, so it wins; percent-decoded, and + stays +.
  dbname = dbname.replace(/([?&])password=([^&#]*)(&?)/, (_m, sep: string, pw: string, amp: string) => {
    password = decode(pw);
    return amp ? sep : "";
  });
  return { dbname, env: password ? { PGPASSWORD: password } : {} };
}

/** A schema name as a pg_dump pattern: quoted, so case and `*` `?` `.` are taken literally. */
export function pgDumpSchemaPattern(schema: string): string {
  return `"${schema.replace(/"/g, '""')}"`;
}

/**
 * How this server takes a backup: SQLite copies its file (VACUUM INTO);
 * Postgres runs pg_dump over the server's schema when the binary is there.
 * Null when neither applies; the backups API then says so.
 */
export function backupEngine(): "sqlite" | "pg_dump" | null {
  const name = getDriver().name;
  if (name === "sqlite") return "sqlite";
  if (name === "postgres" && pgDumpBinary()) return "pg_dump";
  return null;
}

/** File extension and content type of a backup taken by the open driver. */
export function backupFormat(): { ext: string; type: string } {
  return backupEngine() === "pg_dump"
    ? { ext: "dump", type: "application/octet-stream" }
    : { ext: "db", type: "application/vnd.sqlite3" };
}

/**
 * Write a consistent copy of the database to `path`. SQLite: `VACUUM INTO`
 * writes committed state with WAL pages merged, so the file is restorable
 * on its own. Postgres: a pg_dump archive in the custom format of the
 * server's schema; restore it with pg_restore.
 */
export async function snapshotTo(path: string): Promise<void> {
  if (existsSync(path)) rmSync(path);
  const engine = backupEngine();
  if (engine === "sqlite") {
    getRawClient().exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
    return;
  }
  if (engine !== "pg_dump") throw new Error(`backups are not available on ${getDriver().name}`);
  const schema = (await db.get<{ s: string }>(`SELECT current_schema() AS s`))!.s;
  // Owner-only from the start: the archive holds password hashes and secrets.
  closeSync(openSync(path, "w", 0o600));
  const conn = pgToolConnection((getDriver() as unknown as { url: string }).url);
  const proc = Bun.spawn([pgDumpBinary()!, "--format=custom", "--no-owner", `--schema=${pgDumpSchemaPattern(schema)}`, `--dbname=${conn.dbname}`], {
    stdout: Bun.file(path),
    stderr: "pipe",
    env: { ...process.env, ...conn.env },
  });
  const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0) {
    if (existsSync(path)) rmSync(path);
    throw new Error(`pg_dump failed (exit ${code}): ${err.trim().slice(0, 300)}`);
  }
}

export function listBackups(): BackupInfo[] {
  if (!backupsDir || !existsSync(backupsDir)) return [];
  const out: BackupInfo[] = [];
  for (const name of readdirSync(backupsDir)) {
    if (!isBackupName(name)) continue;
    const st = statSync(join(backupsDir, name));
    const info: BackupInfo = { name, size: st.size, created_at: Math.floor(st.mtimeMs / 1000) };
    const m = manifestSummary(join(backupsDir, manifestName(name)));
    if (m) info.files = m;
    out.push(info);
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : -1));
}

/** Delete a backup and its manifest. The files it kept go with the next prune of the store. */
export function deleteBackup(name: string): boolean {
  const p = backupPath(name);
  if (!p) return false;
  rmSync(p);
  rmSync(join(backupsDir, manifestName(name)), { force: true });
  return true;
}

// ── S3 copy ─────────────────────────────────────────────────────────────────

export interface S3Like {
  write(key: string, data: Blob | string, opts?: { type?: string }): Promise<unknown>;
  file(key: string): { text(): Promise<string> };
  delete(key: string): Promise<unknown>;
  list(opts?: { prefix?: string; continuationToken?: string }): Promise<{
    contents?: { key: string }[];
    isTruncated?: boolean;
    nextContinuationToken?: string;
  }>;
}

function s3Target(): { client: S3Like; prefix: string } | null {
  if (getSetting("backups.s3.enabled", "0") !== "1") return null;
  const bucket = getSetting("backups.s3.bucket", "");
  const accessKeyId = getSetting("backups.s3.access_key_id", "");
  const secretAccessKey = getSetting("backups.s3.secret_access_key", "");
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error("S3 backup is enabled but bucket or credentials are missing");
  }
  const opts: Record<string, string> = { bucket, accessKeyId, secretAccessKey };
  const endpoint = getSetting("backups.s3.endpoint", "");
  const region = getSetting("backups.s3.region", "auto");
  if (endpoint) opts["endpoint"] = endpoint;
  if (region) opts["region"] = region;
  const Ctor = (Bun as unknown as { S3Client: new (o: Record<string, string>) => S3Like }).S3Client;
  let prefix = getSetting("backups.s3.prefix", "vaultbase-backups/").replace(/^\/+/, "");
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  return { client: new Ctor(opts), prefix };
}

async function listS3(target: { client: S3Like; prefix: string }, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await target.client.list({ prefix, ...(token ? { continuationToken: token } : {}) });
    for (const o of page.contents ?? []) keys.push(o.key);
    token = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (token);
  return keys;
}

/** Delete the backups past `keep`, each with its manifest. Returns how many went. */
export async function pruneS3(target: { client: S3Like; prefix: string }, keep: number): Promise<number> {
  const keys = (await listS3(target, target.prefix)).filter((k) => isBackupName(k.slice(target.prefix.length)));
  keys.sort().reverse();
  for (const key of keys.slice(keep)) {
    await target.client.delete(key);
    await target.client.delete(manifestName(key));
  }
  return Math.max(0, keys.length - keep);
}

/** Upload the files of `manifest` the bucket doesn't have yet, then the manifest. */
export async function copyFilesToS3(target: { client: S3Like; prefix: string }, name: string, manifest: FilesManifest): Promise<void> {
  const have = new Set((await listS3(target, `${target.prefix}files/`)).map((k) => k.slice(k.lastIndexOf("/") + 1)));
  for (const f of manifest.files) {
    if (have.has(f.sha256)) continue;
    await target.client.write(`${target.prefix}files/${f.sha256.slice(0, 2)}/${f.sha256}`, Bun.file(blobPath(backupsDir, f.sha256)));
    have.add(f.sha256);
  }
  // Last: a manifest in the bucket means its files are there.
  await target.client.write(`${target.prefix}${manifestName(name)}`, Bun.file(join(backupsDir, manifestName(name))), { type: "application/json" });
}

/**
 * Delete files in the bucket no manifest there lists. Keeps everything if a
 * manifest doesn't read, and with no prefix (a bucket shared with other data).
 */
export async function pruneS3Files(target: { client: S3Like; prefix: string }): Promise<void> {
  if (!target.prefix) return;
  const keys = await listS3(target, target.prefix);
  const kept = new Set<string>();
  for (const k of keys) {
    if (!k.endsWith(".files.json") || k.slice(target.prefix.length).includes("/")) continue;
    let m: FilesManifest;
    try { m = JSON.parse(await target.client.file(k).text()) as FilesManifest; } catch { return; }
    if (!m || !Array.isArray(m.files)) return;
    for (const f of m.files) kept.add(f.sha256);
  }
  for (const k of keys) {
    if (!k.startsWith(`${target.prefix}files/`)) continue;
    const sha = k.slice(k.lastIndexOf("/") + 1);
    if (/^[0-9a-f]{64}$/.test(sha) && !kept.has(sha)) await target.client.delete(k);
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function doBackup(): Promise<BackupInfo> {
  if (!backupsDir) throw new Error("backups directory not configured");
  return withBackupLock(backupsDir, backupLocked);
}

async function backupLocked(): Promise<BackupInfo> {

  const { ext, type } = backupFormat();
  let ms = Date.now();
  while (existsSync(join(backupsDir, stampName(ms, ext)))) ms++;
  const name = stampName(ms, ext);
  const final = join(backupsDir, name);
  const tmp = join(backupsDir, `.${name}.tmp`);
  try {
    await snapshotTo(tmp);
    renameSync(tmp, final);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }

  // The uploaded files, after the snapshot: a record in it may point at a
  // file uploaded a moment before, never at one that doesn't exist yet.
  const uploads = filesSource();
  let manifest: FilesManifest | null = null;
  if (uploads) manifest = await snapshotFiles(uploads, backupsDir, join(backupsDir, manifestName(name)), latestManifest(backupsDir));

  const keep = keepCount();
  for (const old of listBackups().slice(keep)) deleteBackup(old.name);
  pruneBlobs(backupsDir);

  const s3 = s3Target();
  if (s3) {
    // Files and manifest first, the snapshot last: a snapshot in the bucket
    // means everything it needs is there too.
    if (manifest) await copyFilesToS3(s3, name, manifest);
    await s3.client.write(`${s3.prefix}${name}`, Bun.file(final), { type });
    if ((await pruneS3(s3, keep)) > 0) await pruneS3Files(s3);
  }

  const st = statSync(final);
  const info: BackupInfo = { name, size: st.size, created_at: Math.floor(st.mtimeMs / 1000) };
  if (manifest) info.files = { count: manifest.count, bytes: manifest.bytes, skipped: manifest.skipped };
  return info;
}

/**
 * Take a backup now. Concurrent callers share the in-flight run. Outcome is
 * recorded in `backups.last_run_at` / `backups.last_error` either way.
 */
export function runBackup(): Promise<BackupInfo> {
  if (running) return running;
  running = doBackup()
    .then(async (info) => {
      // A backup that skipped unreadable files worked, but someone should look.
      const skipped = info.files?.skipped ?? 0;
      await setSetting("backups.last_error", skipped > 0
        ? `${skipped} uploaded file${skipped === 1 ? "" : "s"} couldn't be read and ${skipped === 1 ? "isn't" : "aren't"} in the backup (see its manifest)`
        : "");
      return info;
    })
    .catch(async (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      await setSetting("backups.last_error", msg);
      console.error(`[backups] ${msg}`);
      throw e;
    })
    .finally(async () => {
      // Cleared first: if this write failed, every later backup returned the
      // same rejected promise until a restart.
      running = null;
      await setSetting("backups.last_run_at", String(Math.floor(Date.now() / 1000))).catch((e) => console.error("[backups] recording the run time failed:", e));
    });
  return running;
}

// ── Schedule ────────────────────────────────────────────────────────────────

/** `backups.next_run` holds "<cron>|<unix seconds>" so a cron edit re-plans. */
function parseNext(raw: string): { cron: string; at: number } | null {
  const i = raw.lastIndexOf("|");
  if (i < 0) return null;
  const at = Number(raw.slice(i + 1));
  return Number.isFinite(at) ? { cron: raw.slice(0, i), at } : null;
}

/**
 * One scheduler pass. Returns the run it started, if any. Exported for tests.
 */
export async function backupTick(nowSec = Math.floor(Date.now() / 1000)): Promise<BackupInfo | null> {
  if (getSetting("backups.enabled", "0") !== "1") return null;
  const cron = cronExpr();
  const raw = getSetting("backups.next_run", "");
  const next = parseNext(raw);
  if (!next || next.cron !== cron) {
    await setSetting("backups.next_run", `${cron}|${nextRunFromCron(cron, nowSec)}`);
    return null;
  }
  if (next.at > nowSec) return null;
  // Claim: only the process whose UPDATE matches the old value runs.
  const claimed = (await db.run(
    `UPDATE vaultbase_settings SET value = ?, updated_at = ${db.dialect.epochNow} WHERE key = 'backups.next_run' AND value = ?`,
    [`${cron}|${nextRunFromCron(cron, nowSec)}`, raw],
  )).changes;
  // The claim bypassed setSetting, so drop the cached value either way.
  await invalidateSetting("backups.next_run");
  if (claimed !== 1) return null;
  return runBackup();
}

export function getBackupStatus(): BackupStatus {
  const enabled = getSetting("backups.enabled", "0") === "1";
  const next = parseNext(getSetting("backups.next_run", ""));
  const cron = cronExpr();
  const last = parseInt(getSetting("backups.last_run_at", ""), 10);
  return {
    enabled,
    cron,
    keep: keepCount(),
    s3: getSetting("backups.s3.enabled", "0") === "1",
    files: filesSource() !== null,
    next_run_at: enabled ? (next && next.cron === cron ? next.at : nextRunFromCron(cron)) : null,
    last_run_at: Number.isFinite(last) ? last : null,
    last_error: getSetting("backups.last_error", "") || null,
  };
}

export function startBackupScheduler(): void {
  if (ticker) return;
  if (!backupEngine()) return; // nothing this process can snapshot
  const tick = () => { void backupTick().catch(() => { /* recorded in backups.last_error */ }); };
  ticker = setInterval(tick, 60_000);
  ticker.unref?.();
}

export function stopBackupScheduler(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
}
