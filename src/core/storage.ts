import { existsSync, unlinkSync, statSync, rmSync } from "fs";
import { join, resolve, sep } from "path";
import { getAllSettings } from "../api/settings.ts";
import { forgetThumbVariants } from "./image.ts";

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
 * File storage abstraction. A driver turns settings into a backend that
 * reads and writes objects by key. Built-in drivers:
 *   - "local": filesystem under <uploadDir>
 *   - "s3":    AWS S3 / Cloudflare R2 / any S3-compatible service via Bun's
 *             native Bun.S3Client (no SDK needed)
 * Extensions add more with `registerStorageDriver()`.
 *
 * The active driver is the `storage.driver` setting. The backend is cached
 * for 30s and rebuilt on settings PATCH (see api/settings.ts).
 *
 * Local mode keeps full backwards-compat: the same `<uploadDir>/<filename>`
 * paths that older Vaultbase installs created continue to work.
 */

/** "local", "s3", or the name of a registered driver. */
export type StorageDriver = "local" | "s3" | (string & {});

export interface StorageBackend {
  write(key: string, data: ArrayBuffer | Uint8Array | Blob, contentType?: string): Promise<void>;
  /** The object's bytes, or null when there is none. */
  read(key: string): Promise<ArrayBuffer | null>;
  exists(key: string): Promise<boolean>;
  /** Remove the object. A missing object is not an error. */
  delete(key: string): Promise<void>;
  /** Stream the object. Default: a Response over `read()`. */
  response?(key: string): Promise<Response | null>;
  /** A URL clients can fetch the object from directly, when the backend has one. */
  publicUrl?(key: string): string | null;
  /** Shown on the storage status screen, e.g. { bucket, endpoint }. No secrets. */
  status?(): Record<string, string>;
}

export interface StorageDriverDef {
  name: string;
  /**
   * Build a backend from settings. Called again whenever settings change;
   * the driver reads its own keys (by convention `storage.<name>.*`).
   */
  create(ctx: { settings: Record<string, string>; uploadDir: string }): StorageBackend;
}

export interface S3Config {
  endpoint: string;        // e.g. https://<acct>.r2.cloudflarestorage.com
  bucket: string;
  region: string;          // "auto" for R2; "us-east-1" etc. for AWS
  accessKeyId: string;
  secretAccessKey: string;
  /** Public URL prefix for serving objects directly (e.g. CDN-fronted bucket). Optional — when empty we proxy bytes via /api/files. */
  publicUrl?: string;
}

const TTL_MS = 30_000;
let cached: { driver: string; backend: StorageBackend; expires: number } | null = null;
let configuredUploadDir = "";

/** Called once at server boot. Required so local mode knows where to read/write. */
export function setUploadDir(dir: string): void {
  configuredUploadDir = dir;
}

export function invalidateStorageCache(): void {
  cached = null;
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

function s3Client(s3: S3Config): S3LikeClient {
  const ctor = (Bun as unknown as BunWithS3).S3Client;
  const opts: ConstructorParameters<BunWithS3["S3Client"]>[0] = {
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    bucket: s3.bucket,
  };
  if (s3.region) opts.region = s3.region;
  if (s3.endpoint) opts.endpoint = s3.endpoint;
  return new ctor(opts);
}

// Both built-in backends hand back an opaque byte stream. Bun otherwise
// derives Content-Type from the stored filename's extension, and that name is
// ultimately attacker-influenced. Callers that have validated a type set it
// themselves (see the file-serving route).
const OPAQUE = { "content-type": "application/octet-stream" } as const;

const localDriver: StorageDriverDef = {
  name: "local",
  create: ({ uploadDir }) => ({
    async write(key, data) { await Bun.write(safeLocalPath(uploadDir, key), data); },
    async read(key) {
      let path: string;
      try { path = safeLocalPath(uploadDir, key); } catch { return null; }
      if (!existsSync(path)) return null;
      return await Bun.file(path).arrayBuffer();
    },
    async exists(key) {
      try { return existsSync(safeLocalPath(uploadDir, key)); } catch { return false; }
    },
    async delete(key) {
      try { unlinkSync(safeLocalPath(uploadDir, key)); } catch { /* already gone or invalid */ }
    },
    async response(key) {
      let path: string;
      try { path = safeLocalPath(uploadDir, key); } catch { return null; }
      if (!existsSync(path)) return null;
      return new Response(Bun.file(path), { headers: OPAQUE });
    },
  }),
};

const s3Driver: StorageDriverDef = {
  name: "s3",
  create: ({ settings: s }) => {
    const cfg: S3Config = {
      endpoint: s["s3.endpoint"] ?? "",
      bucket: s["s3.bucket"] ?? "",
      region: s["s3.region"] ?? "auto",
      accessKeyId: s["s3.access_key_id"] ?? "",
      secretAccessKey: s["s3.secret_access_key"] ?? "",
      publicUrl: s["s3.public_url"] ?? "",
    };
    const client = s3Client(cfg);
    return {
      async write(key, data, contentType) {
        const opts: { type?: string } = {};
        if (contentType) opts.type = contentType;
        await client.write(key, data, opts);
      },
      async read(key) {
        const f = client.file(key);
        if (!(await f.exists())) return null;
        return await f.arrayBuffer();
      },
      exists: (key) => client.exists(key),
      async delete(key) {
        try { await client.delete(key); } catch { /* swallow — already gone is fine */ }
      },
      publicUrl(key) {
        if (!cfg.publicUrl) return null;
        return `${cfg.publicUrl.replace(/\/+$/, "")}/${encodeURIComponent(key)}`;
      },
      status: () => ({ bucket: cfg.bucket, endpoint: cfg.endpoint }),
    };
  },
};

const drivers = new Map<string, StorageDriverDef>([["local", localDriver], ["s3", s3Driver]]);

const DRIVER_NAME_RE = /^[a-z][a-z0-9_-]{0,39}$/;

/** Add a storage driver; select it by setting `storage.driver` to its name. */
export function registerStorageDriver(def: StorageDriverDef): () => void {
  if (!DRIVER_NAME_RE.test(def.name)) {
    throw new Error(`invalid storage driver name '${def.name}' (lowercase letters, digits, - and _)`);
  }
  if (drivers.has(def.name)) throw new Error(`storage driver '${def.name}' is already registered`);
  drivers.set(def.name, def);
  return () => {
    if (drivers.get(def.name) === def) {
      drivers.delete(def.name);
      if (cached?.driver === def.name) cached = null;
    }
  };
}

export function listStorageDrivers(): Array<{ name: string; builtin: boolean }> {
  return [...drivers.keys()].map((name) => ({ name, builtin: name === "local" || name === "s3" }));
}

function activeDriverName(): string {
  return getAllSettings()["storage.driver"] || "local";
}

function backend(): StorageBackend {
  const now = Date.now();
  if (cached && cached.expires > now) return cached.backend;
  const name = activeDriverName();
  const def = drivers.get(name);
  // Don't quietly fall back to local disk: files written there would be
  // missing once the driver is back.
  if (!def) throw new Error(`storage driver '${name}' is not registered`);
  const b = def.create({ settings: getAllSettings(), uploadDir: configuredUploadDir });
  cached = { driver: name, backend: b, expires: now + TTL_MS };
  return b;
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function writeFile(key: string, data: ArrayBuffer | Uint8Array | Blob, contentType?: string): Promise<void> {
  await backend().write(key, data, contentType);
}

export async function readFile(key: string): Promise<ArrayBuffer | null> {
  return await backend().read(key);
}

export async function fileExists(key: string): Promise<boolean> {
  return await backend().exists(key);
}

export async function deleteFile(key: string): Promise<void> {
  await backend().delete(key);
}

/** Returns a Response that streams/serves the file. */
export async function fileResponse(key: string): Promise<Response | null> {
  const b = backend();
  if (b.response) return await b.response(key);
  const buf = await b.read(key);
  if (!buf) return null;
  return new Response(buf, { headers: OPAQUE });
}

/** Public URL for an object, if the storage backend has one (S3 with public_url). null otherwise. */
export function publicUrlFor(key: string): string | null {
  return backend().publicUrl?.(key) ?? null;
}

/** Where the local thumb cache lives — always on local FS, even when primary storage is S3. */
export function thumbCacheDir(): string {
  return join(configuredUploadDir, ".thumbs");
}

/** Test the configured backend with a put + get + delete round trip. */
export async function testStorage(): Promise<{ ok: boolean; driver: StorageDriver; error?: string }> {
  const driver = activeDriverName();
  const probeKey = `.vaultbase-probe-${Date.now()}`;
  const probeData = new TextEncoder().encode("ok").buffer;
  try {
    await writeFile(probeKey, probeData, "text/plain");
    const buf = await readFile(probeKey);
    if (!buf) throw new Error("probe read returned null");
    const text = new TextDecoder().decode(buf);
    if (text !== "ok") throw new Error(`probe mismatch: ${text}`);
    await deleteFile(probeKey);
    return { ok: true, driver };
  } catch (e) {
    // Best-effort cleanup
    try { await deleteFile(probeKey); } catch { /* noop */ }
    return { ok: false, driver, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Wipe the thumb cache. Useful when toggling storage drivers. */
export function clearThumbCache(): void {
  const dir = thumbCacheDir();
  forgetThumbVariants();
  if (!existsSync(dir)) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch { /* noop */ }
}

export function getStorageStatus(): { driver: StorageDriver; uploadDir: string; bucket?: string; endpoint?: string } {
  const driver = activeDriverName();
  let extra: Record<string, string> = {};
  try { extra = backend().status?.() ?? {}; } catch { /* unregistered driver: report the name only */ }
  return { ...extra, driver, uploadDir: configuredUploadDir };
}

export { statSync };
