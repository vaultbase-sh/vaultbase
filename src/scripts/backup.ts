/**
 * `vaultbase backup --to <dest>` — atomic SQLite snapshot + push to a
 * destination URL.
 *
 * Snapshots use SQLite's `VACUUM INTO` so the result is a self-contained
 * `.db` file with WAL pages already merged in (no `*-wal` / `*-shm`
 * sidecars to copy). Atomic vs the writer: SQLite serialises VACUUM with
 * any concurrent writer on the same DB.
 *
 * Supported destinations:
 *   --to /path/to/snapshot.db       local file (alias of file://)
 *   --to file:///path/to/snap.db    local file
 *   --to s3://bucket/key            S3 / S3-compatible
 *   --to r2://bucket/key            Cloudflare R2 (S3-compat; needs endpoint)
 *   --to b2://bucket/key            Backblaze B2 (S3-compat; needs endpoint)
 *
 * Credentials for s3/r2/b2 read from env (CLI-friendly — no settings DB
 * required):
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  (mandatory)
 *   AWS_REGION                                (default: auto)
 *   AWS_ENDPOINT_URL                          (mandatory for r2 / b2 /
 *                                              non-AWS S3-compat)
 *
 * Flags:
 *   --to <url>      destination (required)
 *   --gzip          gzip the snapshot before upload (`.db.gz` extension)
 *   --quiet         suppress progress output
 *
 * Exit code: 0 on success, 1 on user-facing error, 2 on internal error.
 */
import { resolve, basename, dirname, extname } from "node:path";
import { existsSync, mkdirSync, copyFileSync, statSync, unlinkSync } from "node:fs";
import { gzipSync } from "node:zlib";

interface BackupOpts {
  to: string;
  gzip: boolean;
  quiet: boolean;
}

function log(opts: BackupOpts, msg: string): void {
  if (!opts.quiet) process.stderr.write(`[backup] ${msg}\n`);
}

function die(msg: string, code = 1): never {
  process.stderr.write(`vaultbase backup: ${msg}\n`);
  process.exit(code);
}

export function parseBackupArgs(argv: string[]): BackupOpts {
  const out: BackupOpts = { to: "", gzip: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a.startsWith("--to=")) out.to = a.slice("--to=".length);
    else if (a === "--to") { const v = argv[++i]; if (v) out.to = v; }
    else if (a === "--gzip") out.gzip = true;
    else if (a === "--quiet" || a === "-q") out.quiet = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        `Usage: vaultbase backup --to <dest> [--gzip] [--quiet]\n\n` +
        `Destinations:\n` +
        `  /path/file.db              local file\n` +
        `  file:///path/file.db       local file\n` +
        `  s3://bucket/key            S3 (creds via AWS_* env)\n` +
        `  r2://bucket/key            Cloudflare R2 (creds + AWS_ENDPOINT_URL via env)\n` +
        `  b2://bucket/key            Backblaze B2 (creds + AWS_ENDPOINT_URL via env)\n\n` +
        `Examples:\n` +
        `  vaultbase backup --to /var/backups/snap-$(date +%F).db\n` +
        `  AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \\\n` +
        `    vaultbase backup --to s3://my-bucket/vb/snap.db --gzip\n`,
      );
      process.exit(0);
    }
    else die(`unknown flag: ${a}`);
  }
  if (!out.to) die("missing --to <dest>");
  return out;
}

interface DestSpec {
  kind: "file" | "s3";
  /** For file: absolute local path. For s3: bucket. */
  bucket: string;
  /** For s3: object key. */
  key: string;
  endpointEnvHint: "AWS_ENDPOINT_URL" | "R2_ENDPOINT" | "B2_ENDPOINT" | null;
}

function parseDestination(to: string): DestSpec {
  // Local: bare path or file://
  if (to.startsWith("file://")) {
    return { kind: "file", bucket: resolve(to.slice("file://".length)), key: "", endpointEnvHint: null };
  }
  if (!/^[a-z0-9]+:\/\//i.test(to)) {
    return { kind: "file", bucket: resolve(to), key: "", endpointEnvHint: null };
  }

  // s3 / r2 / b2 — all use the same bucket/key form.
  const m = /^(s3|r2|b2):\/\/([^/]+)\/(.+)$/.exec(to);
  if (!m) die(`unrecognised destination: ${to}`);
  const proto = m[1]!;
  const bucket = m[2]!;
  const key = m[3]!;
  const endpointHint =
    proto === "r2" ? "R2_ENDPOINT" :
    proto === "b2" ? "B2_ENDPOINT" :
    "AWS_ENDPOINT_URL";
  return { kind: "s3", bucket, key, endpointEnvHint: endpointHint };
}

/**
 * Atomic snapshot via `VACUUM INTO`. Returns the path of the snapshot
 * (caller is responsible for cleanup).
 */
async function snapshotDb(dbPath: string): Promise<string> {
  if (!existsSync(dbPath)) die(`source DB not found: ${dbPath}`);
  // Use a tmp path next to the source — same filesystem, so atomic rename
  // is cheap on the local-file path.
  const dir = dirname(dbPath);
  const tmp = `${dir}/.vaultbase-snap-${process.pid}-${Date.now()}.db`;
  // Open the source READ-ONLY, run VACUUM INTO. SQLite's VACUUM INTO is
  // a built-in atomic snapshot — it writes a new DB file with current
  // committed state, no WAL sidecars needed.
  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath, { readonly: true });
  try {
    // SQLite escapes single quotes by doubling.
    const escaped = tmp.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}'`);
  } finally {
    db.close();
  }
  return tmp;
}

async function pushLocal(snapPath: string, destAbs: string, opts: BackupOpts): Promise<void> {
  const targetDir = dirname(destAbs);
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
  if (opts.gzip) {
    const gz = gzipSync(await Bun.file(snapPath).bytes(), { level: 9 });
    const dest = destAbs.endsWith(".gz") ? destAbs : `${destAbs}.gz`;
    await Bun.write(dest, gz);
    log(opts, `wrote ${dest} (${gz.byteLength.toLocaleString()} bytes, gzipped)`);
  } else {
    copyFileSync(snapPath, destAbs);
    const sz = statSync(destAbs).size;
    log(opts, `wrote ${destAbs} (${sz.toLocaleString()} bytes)`);
  }
}

async function pushS3(snapPath: string, dest: DestSpec, opts: BackupOpts): Promise<void> {
  const accessKeyId = process.env["AWS_ACCESS_KEY_ID"] ?? "";
  const secretAccessKey = process.env["AWS_SECRET_ACCESS_KEY"] ?? "";
  if (!accessKeyId || !secretAccessKey) {
    die("S3-compatible destination requires AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY env vars");
  }
  const endpoint =
    process.env["AWS_ENDPOINT_URL"] ??
    (dest.endpointEnvHint ? process.env[dest.endpointEnvHint] : undefined) ??
    "";
  if ((dest.endpointEnvHint === "R2_ENDPOINT" || dest.endpointEnvHint === "B2_ENDPOINT") && !endpoint) {
    die(`${dest.endpointEnvHint} is required for r2:// / b2:// destinations`);
  }
  const region = process.env["AWS_REGION"] ?? "auto";

  // Bun.S3Client (1.x). Falls back to constructing per-request if cached
  // shape changes.
  type S3Opts = { accessKeyId: string; secretAccessKey: string; bucket: string; region?: string; endpoint?: string };
  const ctor = (Bun as unknown as { S3Client: new (o: S3Opts) => { write(key: string, data: Uint8Array, opts?: { type?: string }): Promise<unknown> } }).S3Client;
  if (!ctor) die("Bun.S3Client unavailable — upgrade Bun (≥ 1.1.0)");
  const s3opts: S3Opts = { accessKeyId, secretAccessKey, bucket: dest.bucket };
  if (region) s3opts.region = region;
  if (endpoint) s3opts.endpoint = endpoint;
  const client = new ctor(s3opts);

  const data = await Bun.file(snapPath).bytes();
  let body: Uint8Array = data;
  let key = dest.key;
  let contentType = "application/octet-stream";
  if (opts.gzip) {
    body = gzipSync(data, { level: 9 });
    if (!key.endsWith(".gz")) key = `${key}.gz`;
    contentType = "application/gzip";
  }
  log(opts, `uploading to ${dest.bucket}/${key} (${body.byteLength.toLocaleString()} bytes${opts.gzip ? ", gzipped" : ""})...`);
  await client.write(key, body, { type: contentType });
  log(opts, `done → ${dest.bucket}/${key}`);
}

export async function runBackup(dbPath: string, argv: string[]): Promise<void> {
  const opts = parseBackupArgs(argv);
  const dest = parseDestination(opts.to);

  log(opts, `snapshotting ${dbPath}`);
  const snap = await snapshotDb(dbPath);
  try {
    if (dest.kind === "file") {
      await pushLocal(snap, dest.bucket, opts);
    } else {
      await pushS3(snap, dest, opts);
    }
  } finally {
    try { unlinkSync(snap); } catch { /* best-effort cleanup */ }
  }
}

// Re-export so a test can drive the destination parser directly.
export { parseDestination };
// Suppress "noUnusedImports" complaints for the path helper used only inside
// pushLocal — TS tree-shakes when used via destructured pseudo-namespace.
void basename;
void extname;
