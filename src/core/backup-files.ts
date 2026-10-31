/**
 * Uploaded files in backups. Next to each database snapshot a backup keeps a
 * manifest (`<backup>.files.json`) of the files in the uploads folder: name,
 * size and SHA-256. The files themselves go in a store shared by every
 * backup, `<backups>/files/<aa>/<sha256>`, once each: stored names are
 * unique and never rewritten, so after the first backup a run copies only
 * new uploads. A file whose name, size and mtime match the previous manifest
 * isn't read again.
 *
 * Restoring a stored backup puts back each file of its manifest that is
 * missing or whose contents differ; files uploaded since are left in place.
 * Pruning deletes a backup's manifest with it, then the stored files no
 * manifest still lists.
 *
 * The work is asynchronous and yields to the event loop as it goes: a first
 * backup of a large uploads folder copies gigabytes, and requests keep being
 * served meanwhile. A file that vanishes during the run (deleted by the file
 * sweep, say) is skipped; one that can't be read is skipped and counted.
 *
 * Only local storage: with S3 (or another driver) the files already live
 * off the server. The thumbnail cache (`.thumbs`), dotfiles and symlinks are
 * skipped.
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "fs";
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from "fs/promises";
import { dirname, join, relative, resolve, sep } from "path";

export interface ManifestEntry {
  /** Path inside the uploads folder, with `/`. */
  name: string;
  sha256: string;
  size: number;
  mtime: number;
}

export interface FilesManifest {
  version: 1;
  count: number;
  bytes: number;
  /** Files that couldn't be read, and so aren't in this backup. */
  skipped: number;
  files: ManifestEntry[];
  /** The first few skipped files and why. */
  skipped_files?: Array<{ name: string; error: string }>;
}

const SHA_RE = /^[0-9a-f]{64}$/;
/** Yield to the event loop at least this often, in files and in bytes. */
const YIELD_FILES = 25;
const YIELD_BYTES = 8 * 1024 * 1024;

const yieldNow = () => new Promise<void>((r) => setImmediate(r));

/** The manifest's file name for a backup's database snapshot. */
export function manifestName(backupName: string): string {
  return backupName.replace(/\.(db|dump)$/, ".files.json");
}

export function blobPath(backupsDir: string, sha256: string): string {
  return join(backupsDir, "files", sha256.slice(0, 2), sha256);
}

/** Every regular file in the uploads folder but the thumbnail cache and dotfiles. Symlinks aren't followed. */
async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) await visit(p);
      else if (e.isFile()) out.push(p);
    }
  };
  await visit(root);
  return out.sort();
}

async function sha256Of(path: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  let since = 0;
  for await (const chunk of Bun.file(path).stream()) {
    h.update(chunk);
    since += chunk.byteLength;
    if (since >= YIELD_BYTES) { since = 0; await yieldNow(); }
  }
  return h.digest("hex");
}

/**
 * Copy `src` into the store and return its hash. The copy is hashed, not the
 * source: an upload still being written can't leave a stored file whose
 * contents don't match its name.
 */
async function storeBlob(backupsDir: string, src: string): Promise<{ sha256: string; size: number }> {
  const tmpDir = join(backupsDir, "files", "tmp");
  await mkdir(tmpDir, { recursive: true, mode: 0o700 });
  const tmp = join(tmpDir, `${process.pid}-${crypto.randomUUID()}.tmp`);
  try {
    await copyFile(src, tmp);
    const [sha256, st] = await Promise.all([sha256Of(tmp), stat(tmp)]);
    const dest = blobPath(backupsDir, sha256);
    if (existsSync(dest)) await rm(tmp, { force: true });
    else {
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      await rename(tmp, dest);
    }
    return { sha256, size: st.size };
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export function readManifest(path: string): FilesManifest | null {
  try {
    const m = JSON.parse(readFileSync(path, "utf8")) as FilesManifest;
    return m && m.version === 1 && Array.isArray(m.files) ? m : null;
  } catch {
    return null;
  }
}

/** A manifest's counts, read from its first bytes (written first) without parsing the whole file. */
export function manifestSummary(path: string): { count: number; bytes: number; skipped: number } | null {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return null; }
  try {
    const buf = Buffer.alloc(256);
    const n = readSync(fd, buf, 0, 256, 0);
    const m = /^\{"version":1,"count":(\d+),"bytes":(\d+),"skipped":(\d+)/.exec(buf.subarray(0, n).toString("utf8"));
    return m ? { count: Number(m[1]), bytes: Number(m[2]), skipped: Number(m[3]) } : null;
  } finally {
    closeSync(fd);
  }
}

/** The newest manifest in `backupsDir`, to reuse its hashes. */
export function latestManifest(backupsDir: string): FilesManifest | null {
  let names: string[];
  try { names = readdirSync(backupsDir).filter((n) => n.endsWith(".files.json")).sort(); } catch { return null; }
  for (let i = names.length - 1; i >= 0; i--) {
    const m = readManifest(join(backupsDir, names[i]!));
    if (m) return m;
  }
  return null;
}

/**
 * Store the uploads folder's files and write the manifest at `manifestPath`.
 * Reads only files new or changed since `previous`.
 */
export async function snapshotFiles(uploadDir: string, backupsDir: string, manifestPath: string, previous: FilesManifest | null): Promise<FilesManifest> {
  const known = new Map((previous?.files ?? []).map((f) => [f.name, f]));
  const files: ManifestEntry[] = [];
  const skipped: Array<{ name: string; error: string }> = [];
  let skippedCount = 0;
  let bytes = 0;
  let n = 0;
  for (const path of await walk(uploadDir)) {
    if (++n % YIELD_FILES === 0) await yieldNow();
    const name = relative(uploadDir, path).split(sep).join("/");
    try {
      const st = await stat(path);
      const mtime = Math.floor(st.mtimeMs);
      const prev = known.get(name);
      let entry: ManifestEntry;
      if (prev && prev.size === st.size && prev.mtime === mtime && existsSync(blobPath(backupsDir, prev.sha256))) {
        entry = prev;
      } else {
        const stored = await storeBlob(backupsDir, path);
        entry = { name, sha256: stored.sha256, size: stored.size, mtime };
      }
      files.push(entry);
      bytes += entry.size;
    } catch (e) {
      const code = (e as { code?: string }).code;
      // Gone since the folder was listed (deleted meanwhile): not part of this backup.
      if (code === "ENOENT") continue;
      skippedCount++;
      if (skipped.length < 20) skipped.push({ name, error: code ?? (e instanceof Error ? e.message : String(e)) });
    }
  }
  // count, bytes and skipped first: manifestSummary reads them without parsing the list.
  const manifest: FilesManifest = { version: 1, count: files.length, bytes, skipped: skippedCount, files };
  if (skipped.length > 0) manifest.skipped_files = skipped;
  const tmp = `${manifestPath}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(manifest), { mode: 0o600 });
    await rename(tmp, manifestPath);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return manifest;
}

/**
 * Delete stored files no manifest in `backupsDir` lists, and temp files left
 * by a run that died more than a day ago. Returns how many stored files went.
 */
export function pruneBlobs(backupsDir: string): number {
  const store = join(backupsDir, "files");
  if (!existsSync(store)) return 0;
  const dayAgo = Date.now() - 86_400_000;
  try {
    for (const t of readdirSync(join(store, "tmp"))) {
      const p = join(store, "tmp", t);
      try { if (statSync(p).mtimeMs < dayAgo) rmSync(p, { force: true }); } catch { /* gone */ }
    }
  } catch { /* no tmp folder */ }
  const kept = new Set<string>();
  for (const n of readdirSync(backupsDir)) {
    if (!n.endsWith(".files.json")) continue;
    const m = readManifest(join(backupsDir, n));
    // A manifest that doesn't read keeps everything: never prune on a guess.
    if (!m) {
      console.warn(`[backups] not pruning stored files: ${n} can't be read`);
      return 0;
    }
    for (const f of m.files) kept.add(f.sha256);
  }
  let removed = 0;
  for (const shard of readdirSync(store)) {
    if (shard === "tmp") continue;
    const dir = join(store, shard);
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const b of entries) {
      if (SHA_RE.test(b) && !kept.has(b)) { rmSync(join(dir, b), { force: true }); removed++; }
    }
  }
  return removed;
}

export interface FilesRestoreResult {
  /** Files written back (missing or different). */
  restored: number;
  /** Files already in place. */
  present: number;
  /** Files the store no longer has. */
  missing: number;
}

/** Where a manifest name lands in the uploads folder, or null if it would land outside it. */
function destinationOf(uploadDir: string, name: string): string | null {
  const parts = name.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".." || p.startsWith(".") || /[\\:\0]/.test(p))) return null;
  const root = resolve(uploadDir);
  const dest = resolve(root, ...parts);
  return dest.startsWith(root + sep) ? dest : null;
}

/** Put the manifest's files back into the uploads folder. */
export async function restoreFiles(manifest: FilesManifest, backupsDir: string, uploadDir: string): Promise<FilesRestoreResult> {
  const result: FilesRestoreResult = { restored: 0, present: 0, missing: 0 };
  let n = 0;
  for (const f of manifest.files) {
    if (++n % YIELD_FILES === 0) await yieldNow();
    const dest = SHA_RE.test(f.sha256) ? destinationOf(uploadDir, f.name) : null;
    if (!dest) continue;
    try {
      // Same size isn't enough: compare contents (restores are rare).
      if ((await stat(dest)).size === f.size && (await sha256Of(dest)) === f.sha256) { result.present++; continue; }
    } catch { /* not there */ }
    const src = blobPath(backupsDir, f.sha256);
    if (!existsSync(src)) { result.missing++; continue; }
    await mkdir(dirname(dest), { recursive: true });
    const tmp = join(dirname(dest), `.${f.name.split("/").at(-1)}.${process.pid}.restore`);
    try {
      await copyFile(src, tmp);
      await rename(tmp, dest);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    result.restored++;
  }
  return result;
}

/**
 * Hold the backups folder for `fn`, across processes (cluster workers, two
 * admins at once): a backup storing files and another pruning them would
 * delete files the first is about to list. A lock whose process is gone,
 * or older than a day, is taken over.
 */
export async function withBackupLock<T>(backupsDir: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const lock = join(backupsDir, ".lock");
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST" || attempt > 0) {
        if ((e as { code?: string }).code === "EEXIST") throw new BackupBusyError();
        throw e;
      }
      let held: { pid?: number; at?: number } = {};
      try { held = JSON.parse(readFileSync(lock, "utf8")); } catch { /* half-written: treat as stale */ }
      const alive = typeof held.pid === "number" && (() => { try { process.kill(held.pid, 0); return true; } catch { return false; } })();
      if (alive && typeof held.at === "number" && Date.now() - held.at < 86_400_000) throw new BackupBusyError();
      rmSync(lock, { force: true });
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

export class BackupBusyError extends Error {
  constructor() { super("another backup is running"); this.name = "BackupBusyError"; }
}
