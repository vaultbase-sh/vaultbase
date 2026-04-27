import { existsSync, mkdirSync } from "fs";
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

async function loadJwtSecret(dataDir: string): Promise<string> {
  const secretPath = join(dataDir, ".secret");
  const f = Bun.file(secretPath);
  if (await f.exists()) {
    return (await f.text()).trim();
  }
  const secret = crypto.randomUUID() + crypto.randomUUID();
  await Bun.write(secretPath, secret);
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
