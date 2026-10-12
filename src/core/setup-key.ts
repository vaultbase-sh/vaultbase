import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "fs";
import { join } from "path";

/**
 * The key that `POST /admin/setup` requires while no admin exists.
 *
 * `VAULTBASE_SETUP_KEY` wins when set. Otherwise the server generates one the
 * first time it is needed and keeps it in `<dataDir>/.setup-key` (mode 0600),
 * so restarts and cluster workers agree on it, and prints it to the log. It
 * used to be optional: without the env var, whoever reached a fresh install
 * first became its admin.
 */

const FILE_NAME = ".setup-key";

let keyDir: string | null = null;
/** In-memory key when there's no data dir to keep it in (embedded / tests). */
let memoryKey: string | null = null;

/** Where to keep the generated key. Called by createServer. */
export function configureSetupKey(dataDir: string | null): void {
  keyDir = dataDir;
  memoryKey = null;
}

function keyPath(): string | null {
  return keyDir ? join(keyDir, FILE_NAME) : null;
}

function generate(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

/** The generated key, read from disk or created; `fresh` when this call made it. */
function inMemoryKey(): { key: string; fresh: boolean } {
  if (memoryKey) return { key: memoryKey, fresh: false };
  memoryKey = generate();
  return { key: memoryKey, fresh: true };
}

function readKeyFile(path: string): string | null {
  try { return readFileSync(path, "utf8").trim() || null; } catch { return null; }
}

function storedKey(): { key: string; fresh: boolean } {
  const path = keyPath();
  if (!path) return inMemoryKey();
  const existing = readKeyFile(path);
  if (existing) return { key: existing, fresh: false };
  const key = generate();
  try {
    // `wx`: if another worker got there first, use its key instead.
    const fd = openSync(path, "wx", 0o600);
    try { writeSync(fd, key); } finally { closeSync(fd); }
    return { key, fresh: true };
  } catch {
    const raced = readKeyFile(path);
    // Data dir not writable: still require a key, kept for this process.
    return raced ? { key: raced, fresh: false } : inMemoryKey();
  }
}

/**
 * The key setup must present. Generates one when none exists, and logs it
 * unless `quiet` (the boot banner prints it itself).
 */
export function requiredSetupKey(opts: { quiet?: boolean } = {}): string {
  const env = process.env["VAULTBASE_SETUP_KEY"];
  if (env) return env;
  const { key, fresh } = storedKey();
  if (fresh && !opts.quiet) announceSetupKey(key);
  return key;
}

/** True when the key comes from `VAULTBASE_SETUP_KEY` rather than the server. */
export function setupKeyFromEnv(): boolean {
  return !!process.env["VAULTBASE_SETUP_KEY"];
}

function announceSetupKey(key: string): void {
  process.stderr.write(
    `vaultbase: no admin exists yet. Setup key: ${key}\n` +
    `vaultbase: enter it on the setup page (/_/setup), or send it as X-Setup-Key to POST /api/v1/admin/setup.\n`,
  );
}

/** Forget the generated key once an admin exists. */
export function clearSetupKey(): void {
  memoryKey = null;
  const path = keyPath();
  if (!path) return;
  try { unlinkSync(path); } catch { /* already gone */ }
}
