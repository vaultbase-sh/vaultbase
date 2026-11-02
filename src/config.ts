import { existsSync, mkdirSync, chmodSync, linkSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

export interface Config {
  port: number;
  dataDir: string;
  dbPath: string;
  uploadDir: string;
  logsDir: string;
  jwtSecret: string;
  encryptionKey: string | undefined;
  /** Secrets read from (or generated into) the data directory, not the environment. */
  secretsFromDataDir?: string[];
}

/**
 * In production set `VAULTBASE_JWT_SECRET` explicitly. Falling through to the
 * filesystem fallback writes a sensitive value to disk; rotating the secret
 * (forced log-out for everyone) requires deleting the file. The on-disk
 * file is created with mode `0600` so other UIDs can't read it.
 */
function loadJwtSecret(dataDir: string): string {
  const path = join(dataDir, ".secret");
  const read = (): string | null => {
    try { return readFileSync(path, "utf8").trim() || null; } catch { return null; }
  };
  const existing = read();
  if (existing) return existing;
  // An empty file would sign tokens with an empty key: replace it (that only
  // signs everyone out). 64 random bytes hex-encoded, 512 bits.
  if (existsSync(path)) console.warn(`[config] ${path} is empty or unreadable; writing a new JWT secret (existing sessions end)`);
  const fresh = Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString("hex");
  // Written aside and linked into place, so cluster workers starting together
  // on a fresh install all end up with the one secret that won.
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, fresh, { mode: 0o600, flag: "wx" });
    try { linkSync(tmp, path); } catch { if (!read()) renameSync(tmp, path); }
  } finally {
    try { unlinkSync(tmp); } catch { /* linked or renamed away */ }
  }
  try { chmodSync(path, 0o600); } catch { /* Windows or non-POSIX: best-effort */ }
  return read() ?? fresh;
}

/**
 * Files the server creates — the database and its WAL, uploads, logs,
 * backups, thumbnails — are readable by the owner and its group only. With
 * the usual 022 umask they were world-readable on any install not made by
 * the installer (which sets the data dir to 0750 but not the files in it).
 */
export const FILE_UMASK = 0o027;

/**
 * The at-rest key for secret settings and encrypted fields. Without
 * `VAULTBASE_ENCRYPTION_KEY`, secret settings (SMTP password, OAuth client
 * secrets, storage keys) were stored — and backed up — in plaintext. Now a
 * key is generated once into `<dataDir>/.encryption-key` (0600) and used
 * instead, the same way `.secret` backs the JWT key. Keep that file with
 * your backups: encrypted values can't be read without it.
 *
 * Created as a temp file linked into place, so processes starting together
 * (cluster workers) all end up with the same key.
 */
export function loadEncryptionKey(dataDir: string): string {
  const env = process.env["VAULTBASE_ENCRYPTION_KEY"];
  if (env) return env;
  const path = join(dataDir, ".encryption-key");
  const read = (): string | null => {
    try { return readFileSync(path, "utf8").trim() || null; } catch { return null; }
  };
  let key = read();
  if (!key && existsSync(path)) {
    // There is a key file we can't use (permissions, truncated). Replacing
    // it would make everything encrypted with it unreadable for good.
    throw new Error(
      `${path} exists but can't be read or is empty. Fix its permissions or contents ` +
      `(or set VAULTBASE_ENCRYPTION_KEY to the original key); it is not replaced automatically.`,
    );
  }
  if (!key) {
    const fresh = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmp, fresh, { mode: 0o600, flag: "wx" });
      try { linkSync(tmp, path); } catch { if (!read()) renameSync(tmp, path); }
    } finally {
      try { unlinkSync(tmp); } catch { /* linked or renamed away */ }
    }
    key = read() ?? fresh;
  }
  // The encryption module reads the env var; point it at this key.
  process.env["VAULTBASE_ENCRYPTION_KEY"] = key;
  return key;
}

/** VAULTBASE_PORT as a port number; anything else stops the start with a clear message. */
function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 8091;
  const port = Number(raw.trim());
  // parseInt took "80x" as 80 and "abc" as NaN (which then printed localhost:NaN).
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`VAULTBASE_PORT must be a port number from 0 to 65535, got '${raw}'`);
  }
  return port;
}

export async function loadConfig(): Promise<Config> {
  try { process.umask(FILE_UMASK); } catch { /* not supported (Windows) */ }
  const dataDir = process.env["VAULTBASE_DATA_DIR"] ?? "./vaultbase_data";
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const uploadDir = join(dataDir, "uploads");
  if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });

  const logsDir = join(dataDir, "logs");
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });

  const secretsFromDataDir: string[] = [];
  if (!process.env["VAULTBASE_JWT_SECRET"]) secretsFromDataDir.push("VAULTBASE_JWT_SECRET");
  if (!process.env["VAULTBASE_ENCRYPTION_KEY"]) secretsFromDataDir.push("VAULTBASE_ENCRYPTION_KEY");
  // An empty value counts as unset: it would be an empty signing key.
  const jwtSecret = process.env["VAULTBASE_JWT_SECRET"] || loadJwtSecret(dataDir);

  return {
    port: parsePort(process.env["VAULTBASE_PORT"]),
    dataDir,
    dbPath: join(dataDir, "data.db"),
    uploadDir,
    logsDir,
    jwtSecret,
    encryptionKey: loadEncryptionKey(dataDir),
    secretsFromDataDir,
  };
}

/** Where the installer writes the service's environment. */
export const SERVICE_ENV_FILE = "/etc/vaultbase/vaultbase.env";

/**
 * Before a CLI command run by hand against an installed service (doctor,
 * setup-admin, token, backup, wipe): read the service's env file, say so,
 * and refuse to run as root on a data directory another user owns. Run with
 * sudo, the command left root-owned files there (database.json, the WAL)
 * that the service, running as its own user, then couldn't open: it failed
 * at its next start. Returns the message to print and exit on, or null.
 */
export function prepareServiceCommand(command: string, argv: string[], uid = process.getuid?.()): string | null {
  const envPath = process.env["VAULTBASE_ENV_FILE"] ?? SERVICE_ENV_FILE;
  const envFile = loadServiceEnvFile(envPath);
  if (envFile) process.stderr.write(`vaultbase: using settings from ${envFile}\n`);
  else if (existsSync(envPath)) {
    process.stderr.write(`vaultbase: can't read ${envPath}; run as the service's user (sudo -u vaultbase vaultbase ${command} ...) to use its settings\n`);
  }
  const owner = foreignOwner(process.env["VAULTBASE_DATA_DIR"] ?? "./vaultbase_data", uid);
  if (owner === null) return null;
  const who = userName(owner) ?? `#${owner}`;
  return `vaultbase ${command}: the data directory belongs to '${who}', the user the service runs as. Run it as that user, so the files it writes stay readable by the service:\n  sudo -u ${who} vaultbase ${argv.join(" ")}\n`;
}

/** The owner of `dataDir` when running as root and it's someone else's, else null. */
export function foreignOwner(dataDir: string, uid: number | undefined): number | null {
  if (uid !== 0) return null;
  try {
    const owner = statSync(dataDir).uid;
    return owner === 0 ? null : owner;
  } catch {
    return null;
  }
}

function userName(uid: number): string | null {
  try {
    const r = Bun.spawnSync(["id", "-nu", String(uid)]);
    const name = r.stdout.toString().trim();
    return r.exitCode === 0 && /^[a-z_][a-z0-9_-]*\$?$/i.test(name) ? name : null;
  } catch {
    return null;
  }
}

/**
 * For CLI subcommands run by hand against an installed service (`vaultbase
 * setup-admin`): read the service's env file — `VAULTBASE_ENV_FILE`, or the
 * installer's path — so the command works on the service's data dir instead
 * of a fresh `./vaultbase_data` in the current directory. Variables already
 * set in the environment win. Returns the file read, or null.
 */
export function loadServiceEnvFile(path = process.env["VAULTBASE_ENV_FILE"] ?? SERVICE_ENV_FILE): string | null {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!;
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    if (process.env[m[1]!] === undefined) process.env[m[1]!] = value;
  }
  return path;
}
