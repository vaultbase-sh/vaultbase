/**
 * The JWT secret is never empty: an empty VAULTBASE_JWT_SECRET (a blank line
 * in an env file) or an empty `.secret` file used to become the HMAC key.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadConfig } from "../config.ts";

const KEYS = ["VAULTBASE_DATA_DIR", "VAULTBASE_JWT_SECRET", "VAULTBASE_ENCRYPTION_KEY"] as const;
let root: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vb-jwt-"));
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  process.env["VAULTBASE_DATA_DIR"] = root;
  process.env["VAULTBASE_ENCRYPTION_KEY"] = "k".repeat(44);
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  rmSync(root, { recursive: true, force: true });
});

describe("JWT secret", () => {
  it("an empty VAULTBASE_JWT_SECRET counts as unset", async () => {
    process.env["VAULTBASE_JWT_SECRET"] = "";
    const config = await loadConfig();
    expect(config.jwtSecret.length).toBe(128);
    expect(readFileSync(join(root, ".secret"), "utf8")).toBe(config.jwtSecret);
  });

  it("an empty .secret file is replaced", async () => {
    delete process.env["VAULTBASE_JWT_SECRET"];
    writeFileSync(join(root, ".secret"), "\n");
    const config = await loadConfig();
    expect(config.jwtSecret.length).toBe(128);
  });

  it("an existing secret is kept, and the env var wins when set (legitimate path)", async () => {
    delete process.env["VAULTBASE_JWT_SECRET"];
    writeFileSync(join(root, ".secret"), "s".repeat(40));
    expect((await loadConfig()).jwtSecret).toBe("s".repeat(40));
    process.env["VAULTBASE_JWT_SECRET"] = "from-env";
    expect((await loadConfig()).jwtSecret).toBe("from-env");
  });
});

describe("VAULTBASE_PORT", () => {
  it("must be a port number", async () => {
    const saved = process.env["VAULTBASE_PORT"];
    try {
      process.env["VAULTBASE_PORT"] = "80x";
      await expect(loadConfig()).rejects.toThrow("VAULTBASE_PORT");
      process.env["VAULTBASE_PORT"] = "9000";
      expect((await loadConfig()).port).toBe(9000);
    } finally {
      if (saved === undefined) delete process.env["VAULTBASE_PORT"]; else process.env["VAULTBASE_PORT"] = saved;
    }
  });
});
