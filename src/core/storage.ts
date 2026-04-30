import { existsSync, unlinkSync, statSync, rmSync } from "fs";
import { join, resolve, sep } from "path";
import { getAllSettings } from "../api/settings.ts";

/**
 * Path-traversal guard for local-mode keys. Rejects anything that resolves
 * outside the upload root; throws so callers do not silently land in /etc.
 */
function safeLocalPath(uploadDir: string, key: string): string {
  if (!key || key.includes("\0")) throw new Error("invalid key");
  const root = resolve(uploadDir);
  const full = resolve(join(root, key));
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error("path escapes upload directory");
  }
  return full;
}

/**
 * File storage abstraction. Backends:
 *   - "local": filesystem under <uploadDir>
 *   - "s3":    AWS S3 / Cloudflare R2 / any S3-compatible service via Bun's
 *             native Bun.S3Client (no SDK needed)
 *
 * Driver + credentials live in `vaultbase_settings`. Cached for 30s and
 * invalidated on settings PATCH (see api/settings.ts).
 *
 * Local mode keeps full backwards-compat: the same `<uploadDir>/<filename>`
 * paths that older Vaultbase installs created continue to work.
 */

export type StorageDriver = "local" | "s3";

export interface S3Config {
  endpoint: string;        // e.g. https://<acct>.r2.cloudflarestorage.com
  bucket: string;
  region: string;          // "auto" for R2; "us-east-1" etc. for AWS
  accessKeyId: string;
  secretAccessKey: string;
  /** Public URL prefix for serving objects directly (e.g. CDN-fronted bucket). Optional — when empty we proxy bytes via /api/files. */
  publicUrl?: string;
}

export interface StorageConfig {
  driver: StorageDriver;
  uploadDir: string; // always set (used for local mode + thumb cache)
  s3?: S3Config;
}

let cached: { config: StorageConfig; expires: number } | null = null;
const TTL_MS = 30_000;
let configuredUploadDir = "";

/** Called once at server boot. Required so local mode knows where to read/write. */
export function setUploadDir(dir: string): void {
  configuredUploadDir = dir;
}

export function invalidateStorageCache(): void {
  cached = null;
}

function readConfig(): StorageConfig {
  const s = getAllSettings();
  const driverRaw = s["storage.driver"] ?? "local";
  const driver: StorageDriver = driverRaw === "s3" ? "s3" : "local";
  const config: StorageConfig = { driver, uploadDir: configuredUploadDir };
  if (driver === "s3") {
    config.s3 = {
      endpoint: s["s3.endpoint"] ?? "",
      bucket: s["s3.bucket"] ?? "",
      region: s["s3.region"] ?? "auto",
      accessKeyId: s["s3.access_key_id"] ?? "",
      secretAccessKey: s["s3.secret_access_key"] ?? "",
      publicUrl: s["s3.public_url"] ?? "",
    };
  }
  return config;
}

function getConfig(): StorageConfig {
  const now = Date.now();
  if (cached && cached.expires > now) return cached.config;
  const config = readConfig();
  cached = { config, expires: now + TTL_MS };
  return config;
}

interface S3LikeClient {
  write(key: string, data: ArrayBuffer | Uint8Array | Blob | string, opts?: { type?: string }): Promise<unknown>;
  file(key: string): { arrayBuffer(): Promise<ArrayBuffer>; exists(): Promise<boolean> };
  delete(key: string): Promise<unknown>;
  exists(key: string): Promise<boolean>;
}

interface BunWithS3 {
  S3Client: new (opts: {
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    region?: string;
    endpoint?: string;
  }) => S3LikeClient;
}

let cachedS3Client: { client: S3LikeClient; key: string } | null = null;

function s3Client(s3: S3Config): S3LikeClient {
  const fingerprint = `${s3.endpoint}|${s3.bucket}|${s3.region}|${s3.accessKeyId}`;
  if (cachedS3Client && cachedS3Client.key === fingerprint) return cachedS3Client.client;
  const ctor = (Bun as unknown as BunWithS3).S3Client;
  type S3Opts = {
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    region?: string;
    endpoint?: string;
  };
  const opts: S3Opts = {
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    bucket: s3.bucket,
  };
  if (s3.region) opts.region = s3.region;
  if (s3.endpoint) opts.endpoint = s3.endpoint;
  const client = new ctor(opts);
  cachedS3Client = { client, key: fingerprint };
  return client;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function writeFile(key: string, data: ArrayBuffer | Uint8Array | Blob, contentType?: string): Promise<void> {
  const cfg = getConfig();
  if (cfg.driver === "s3") {
    if (!cfg.s3) throw new Error("S3 driver selected but configuration is missing");
    const opts: { type?: string } = {};
    if (contentType) opts.type = contentType;
    await s3Client(cfg.s3).write(key, data, opts);
    return;
  }
  await Bun.write(safeLocalPath(cfg.uploadDir, key), data);
}

export async function readFile(key: string): Promise<ArrayBuffer | null> {
  const cfg = getConfig();
  if (cfg.driver === "s3") {
    if (!cfg.s3) throw new Error("S3 driver selected but configuration is missing");
    const f = s3Client(cfg.s3).file(key);
    if (!(await f.exists())) return null;
    return await f.arrayBuffer();
  }
  let path: string;
  try { path = safeLocalPath(cfg.uploadDir, key); } catch { return null; }
  if (!existsSync(path)) return null;
  return await Bun.file(path).arrayBuffer();
}

export async function fileExists(key: string): Promise<boolean> {
  const cfg = getConfig();
  if (cfg.driver === "s3") {
    if (!cfg.s3) throw new Error("S3 driver selected but configuration is missing");
    return await s3Client(cfg.s3).exists(key);
  }
  try { return existsSync(safeLocalPath(cfg.uploadDir, key)); } catch { return false; }
}

export async function deleteFile(key: string): Promise<void> {
  const cfg = getConfig();
  if (cfg.driver === "s3") {
    if (!cfg.s3) throw new Error("S3 driver selected but configuration is missing");
    try { await s3Client(cfg.s3).delete(key); } catch { /* swallow — already gone is fine */ }
    return;
  }
  try { unlinkSync(safeLocalPath(cfg.uploadDir, key)); } catch { /* already gone or invalid */ }
}

/** Returns a Response that streams/serves the file. Falls back to fetching bytes for S3. */
export async function fileResponse(key: string): Promise<Response | null> {
  const cfg = getConfig();
  if (cfg.driver === "s3") {
    const buf = await readFile(key);
    if (!buf) return null;
    return new Response(buf);
  }
  let path: string;
  try { path = safeLocalPath(cfg.uploadDir, key); } catch { return null; }
  if (!existsSync(path)) return null;
  return new Response(Bun.file(path));
}

/** Public URL for an object, if the storage driver supports it (S3 with public_url). null otherwise. */
export function publicUrlFor(key: string): string | null {
  const cfg = getConfig();
  if (cfg.driver !== "s3" || !cfg.s3?.publicUrl) return null;
  const base = cfg.s3.publicUrl.replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(key)}`;
}

/** Where the local thumb cache lives — always on local FS, even when primary storage is S3. */
export function thumbCacheDir(): string {
  return join(configuredUploadDir, ".thumbs");
}

/** Test the configured backend with a put + get + delete round trip. */
export async function testStorage(): Promise<{ ok: boolean; driver: StorageDriver; error?: string }> {
  const cfg = getConfig();
  const probeKey = `.vaultbase-probe-${Date.now()}`;
  const probeData = new TextEncoder().encode("ok").buffer;
  try {
    await writeFile(probeKey, probeData, "text/plain");
    const buf = await readFile(probeKey);
    if (!buf) throw new Error("probe read returned null");
    const text = new TextDecoder().decode(buf);
    if (text !== "ok") throw new Error(`probe mismatch: ${text}`);
    await deleteFile(probeKey);
    return { ok: true, driver: cfg.driver };
  } catch (e) {
    // Best-effort cleanup
    try { await deleteFile(probeKey); } catch { /* noop */ }
    return { ok: false, driver: cfg.driver, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Wipe the thumb cache. Useful when toggling storage drivers. */
export function clearThumbCache(): void {
  const dir = thumbCacheDir();
  if (!existsSync(dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch { /* noop */ }
}

export function getStorageStatus(): { driver: StorageDriver; uploadDir: string; bucket?: string; endpoint?: string } {
  const cfg = getConfig();
  const out: ReturnType<typeof getStorageStatus> = { driver: cfg.driver, uploadDir: cfg.uploadDir };
  if (cfg.s3) {
    out.bucket = cfg.s3.bucket;
    out.endpoint = cfg.s3.endpoint;
  }
  return out;
}

export { statSync };
