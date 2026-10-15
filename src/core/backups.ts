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
 * Cluster mode: every worker runs the ticker, but a run is claimed with a
 * conditional UPDATE on `backups.next_run`, so exactly one worker wins.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "fs";
import { join } from "path";
import { getRawClient } from "../db/client.ts";
import { db } from "../db/index.ts";
import { getSetting, setSetting, invalidateSetting } from "../api/settings.ts";
import { nextRunFromCron, validateCron } from "./jobs.ts";

export const DEFAULT_BACKUP_CRON = "0 3 * * *";
export const DEFAULT_BACKUP_KEEP = 7;
export const MAX_BACKUP_KEEP = 1000;

const NAME_RE = /^vaultbase-\d{8}-\d{6}-\d{3}\.db$/;

let backupsDir = "";
let ticker: ReturnType<typeof setInterval> | null = null;
let running: Promise<BackupInfo> | null = null;

export interface BackupInfo {
  name: string;
  size: number;
  created_at: number;
}

export interface BackupStatus {
  enabled: boolean;
  cron: string;
  keep: number;
  s3: boolean;
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
function stampName(ms: number): string {
  const iso = new Date(ms).toISOString(); // 2026-10-11T03:00:00.000Z
  return `vaultbase-${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}-${iso.slice(20, 23)}.db`;
}

/**
 * Atomic snapshot of the live DB. `VACUUM INTO` writes committed state with
 * WAL pages merged, so the file is restorable on its own.
 */
export function snapshotTo(path: string): void {
  if (existsSync(path)) rmSync(path);
  getRawClient().exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
}

export function listBackups(): BackupInfo[] {
  if (!backupsDir || !existsSync(backupsDir)) return [];
  const out: BackupInfo[] = [];
  for (const name of readdirSync(backupsDir)) {
    if (!isBackupName(name)) continue;
    const st = statSync(join(backupsDir, name));
    out.push({ name, size: st.size, created_at: Math.floor(st.mtimeMs / 1000) });
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : -1));
}

export function deleteBackup(name: string): boolean {
  const p = backupPath(name);
  if (!p) return false;
  rmSync(p);
  return true;
}

// ── S3 copy ─────────────────────────────────────────────────────────────────

interface S3Like {
  write(key: string, data: Blob, opts?: { type?: string }): Promise<unknown>;
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

async function pruneS3(target: { client: S3Like; prefix: string }, keep: number): Promise<void> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const page = await target.client.list({ prefix: target.prefix, ...(token ? { continuationToken: token } : {}) });
    for (const o of page.contents ?? []) {
      if (isBackupName(o.key.slice(target.prefix.length))) keys.push(o.key);
    }
    token = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (token);
  keys.sort().reverse();
  for (const key of keys.slice(keep)) await target.client.delete(key);
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function doBackup(): Promise<BackupInfo> {
  if (!backupsDir) throw new Error("backups directory not configured");
  if (!existsSync(backupsDir)) mkdirSync(backupsDir, { recursive: true });

  let ms = Date.now();
  while (existsSync(join(backupsDir, stampName(ms)))) ms++;
  const name = stampName(ms);
  const final = join(backupsDir, name);
  const tmp = join(backupsDir, `.${name}.tmp`);
  try {
    snapshotTo(tmp);
    renameSync(tmp, final);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }

  const keep = keepCount();
  for (const old of listBackups().slice(keep)) deleteBackup(old.name);

  const s3 = s3Target();
  if (s3) {
    await s3.client.write(`${s3.prefix}${name}`, Bun.file(final), { type: "application/vnd.sqlite3" });
    await pruneS3(s3, keep);
  }

  const st = statSync(final);
  return { name, size: st.size, created_at: Math.floor(st.mtimeMs / 1000) };
}

/**
 * Take a backup now. Concurrent callers share the in-flight run. Outcome is
 * recorded in `backups.last_run_at` / `backups.last_error` either way.
 */
export function runBackup(): Promise<BackupInfo> {
  if (running) return running;
  running = doBackup()
    .then(async (info) => {
      await setSetting("backups.last_error", "");
      return info;
    })
    .catch(async (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      await setSetting("backups.last_error", msg);
      console.error(`[backups] ${msg}`);
      throw e;
    })
    .finally(async () => {
      await setSetting("backups.last_run_at", String(Math.floor(Date.now() / 1000)));
      running = null;
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
  // Claim: only the worker whose UPDATE matches the old value runs.
  const claimed = getRawClient()
    .prepare(`UPDATE vaultbase_settings SET value = ?, updated_at = unixepoch() WHERE key = 'backups.next_run' AND value = ?`)
    .run(`${cron}|${nextRunFromCron(cron, nowSec)}`, raw).changes;
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
    next_run_at: enabled ? (next && next.cron === cron ? next.at : nextRunFromCron(cron)) : null,
    last_run_at: Number.isFinite(last) ? last : null,
    last_error: getSetting("backups.last_error", "") || null,
  };
}

export function startBackupScheduler(): void {
  if (ticker) return;
  if (!db.capabilities.fileBackups) return; // nothing this process can snapshot
  const tick = () => { void backupTick().catch(() => { /* recorded in backups.last_error */ }); };
  ticker = setInterval(tick, 60_000);
  ticker.unref?.();
}

export function stopBackupScheduler(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
}
