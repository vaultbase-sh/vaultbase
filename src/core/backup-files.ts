/**
 * Uploaded files in backups. Next to each database snapshot a backup keeps a
 * manifest (`<backup>.files.json`) of the files in the uploads folder: name,
 * size and SHA-256. The files themselves go in a store shared by every
 * backup, `<backups>/files/<aa>/<sha256>`, once each: stored names are
 * unique and never rewritten, so after the first backup a run copies only
 * new uploads. A file whose name, size and mtime match the previous manifest
 * isn't hashed again.
 *
 * Restoring a stored backup puts back each file of its manifest that is
 * missing or differs; files added since are left (the file sweep removes
 * the ones no record points at). Pruning deletes a backup's manifest with
 * it, then the stored files no manifest still lists.
 *
 * Only local storage: with S3 (or another driver) the files already live
 * off the server. The thumbnail cache (`.thumbs`) and dotfiles are skipped.
 */
import { constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join, relative, sep } from "path";

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
  files: ManifestEntry[];
}

const SHA_RE = /^[0-9a-f]{64}$/;

/** The manifest's file name for a backup's database snapshot. */
export function manifestName(backupName: string): string {
  return backupName.replace(/\.(db|dump)$/, ".files.json");
}

export function blobPath(backupsDir: string, sha256: string): string {
  return join(backupsDir, "files", sha256.slice(0, 2), sha256);
}

/** Every file in the uploads folder but the thumbnail cache and dotfiles. */
function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) visit(p);
      else if (e.isFile()) out.push(p);
    }
  };
  visit(root);
  return out.sort();
}

async function sha256Of(path: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) h.update(chunk);
  return h.digest("hex");
}

/** Copy into the store under a temporary name, then rename: a half-copied file is never there. */
function storeBlob(backupsDir: string, src: string, sha256: string): void {
  const dest = blobPath(backupsDir, sha256);
  if (existsSync(dest)) return;
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  copyFileSync(src, tmp, constants.COPYFILE_FICLONE);
  renameSync(tmp, dest);
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

export function readManifest(path: string): FilesManifest | null {
  try {
    const m = JSON.parse(readFileSync(path, "utf8")) as FilesManifest;
    return m && m.version === 1 && Array.isArray(m.files) ? m : null;
  } catch {
    return null;
  }
}

/**
 * Store the uploads folder's files and write the manifest at `manifestPath`.
 * Hashes only files new or changed since `previous`.
 */
export async function snapshotFiles(uploadDir: string, backupsDir: string, manifestPath: string, previous: FilesManifest | null): Promise<FilesManifest> {
  const known = new Map((previous?.files ?? []).map((f) => [f.name, f]));
  const files: ManifestEntry[] = [];
  let bytes = 0;
  for (const path of walk(uploadDir)) {
    const name = relative(uploadDir, path).split(sep).join("/");
    const st = statSync(path);
    const mtime = Math.floor(st.mtimeMs);
    const prev = known.get(name);
    let sha256 = prev && prev.size === st.size && prev.mtime === mtime ? prev.sha256 : "";
    if (!sha256 || !existsSync(blobPath(backupsDir, sha256))) {
      sha256 = await sha256Of(path);
      storeBlob(backupsDir, path, sha256);
    }
    files.push({ name, sha256, size: st.size, mtime });
    bytes += st.size;
  }
  const manifest: FilesManifest = { version: 1, count: files.length, bytes, files };
  const tmp = `${manifestPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(manifest), { mode: 0o600 });
  renameSync(tmp, manifestPath);
  return manifest;
}

/** Delete stored files no manifest in `backupsDir` lists. Returns how many went. */
export function pruneBlobs(backupsDir: string): number {
  const store = join(backupsDir, "files");
  if (!existsSync(store)) return 0;
  const kept = new Set<string>();
  for (const n of readdirSync(backupsDir)) {
    if (!n.endsWith(".files.json")) continue;
    const m = readManifest(join(backupsDir, n));
    // A manifest that doesn't read keeps everything: never prune on a guess.
    if (!m) return 0;
    for (const f of m.files) kept.add(f.sha256);
  }
  let removed = 0;
  for (const shard of readdirSync(store)) {
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

/** Put the manifest's files back into the uploads folder. */
export function restoreFiles(manifest: FilesManifest, backupsDir: string, uploadDir: string): FilesRestoreResult {
  const result: FilesRestoreResult = { restored: 0, present: 0, missing: 0 };
  for (const f of manifest.files) {
    // Manifest names come from our own walk; refuse anything that leaves the folder.
    const parts = f.name.split("/");
    if (!SHA_RE.test(f.sha256) || parts.some((p) => p === "" || p === "." || p === ".." || p.startsWith("."))) continue;
    const dest = join(uploadDir, ...parts);
    try {
      if (statSync(dest).size === f.size) { result.present++; continue; }
    } catch { /* not there */ }
    const src = blobPath(backupsDir, f.sha256);
    if (!existsSync(src)) { result.missing++; continue; }
    mkdirSync(dirname(dest), { recursive: true });
    const tmp = join(dirname(dest), `.${parts.at(-1)}.${process.pid}.restore`);
    copyFileSync(src, tmp);
    renameSync(tmp, dest);
    result.restored++;
  }
  return result;
}
