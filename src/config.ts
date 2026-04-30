import { existsSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";

export interface Config {
  port: number;
  dataDir: string;
  dbPath: string;
  uploadDir: string;
  logsDir: string;
  jwtSecret: string;
  encryptionKey: string | undefined;
}

/**
 * In production set `VAULTBASE_JWT_SECRET` explicitly. Falling through to the
 * filesystem fallback writes a sensitive value to disk; rotating the secret
 * (forced log-out for everyone) requires deleting the file. The on-disk
 * file is created with mode `0600` so other UIDs can't read it.
 */
async function loadJwtSecret(dataDir: string): Promise<string> {
  const secretPath = join(dataDir, ".secret");
  const f = Bun.file(secretPath);
  if (await f.exists()) {
    return (await f.text()).trim();
  }
  // 64 random bytes hex-encoded → 512 bits of entropy.
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  const secret = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  await Bun.write(secretPath, secret);
  try { chmodSync(secretPath, 0o600); } catch { /* Windows or non-POSIX: best-effort */ }
  return secret;
}

export async function loadConfig(): Promise<Config> {
  const dataDir = process.env["VAULTBASE_DATA_DIR"] ?? "./vaultbase_data";
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const uploadDir = join(dataDir, "uploads");
  if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });

  const logsDir = join(dataDir, "logs");
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });

  const jwtSecret =
    process.env["VAULTBASE_JWT_SECRET"] ?? (await loadJwtSecret(dataDir));

  return {
    port: parseInt(process.env["VAULTBASE_PORT"] ?? "8091"),
    dataDir,
    dbPath: join(dataDir, "data.db"),
    uploadDir,
    logsDir,
    jwtSecret,
    encryptionKey: process.env["VAULTBASE_ENCRYPTION_KEY"],
  };
}
