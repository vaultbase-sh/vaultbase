/**
 * Without VAULTBASE_ENCRYPTION_KEY, secret settings (SMTP password, OAuth
 * client secrets, storage keys) were stored — and backed up — in plaintext.
 * A key is now generated into <dataDir>/.encryption-key and plaintext
 * secrets are encrypted at startup.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadEncryptionKey } from "../config.ts";
import { initDb, closeDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { encryptPlaintextSecretSettings, getSetting } from "../api/settings.ts";

let dir: string;
const saved = process.env["VAULTBASE_ENCRYPTION_KEY"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vb-enckey-"));
  delete process.env["VAULTBASE_ENCRYPTION_KEY"];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env["VAULTBASE_ENCRYPTION_KEY"];
  else process.env["VAULTBASE_ENCRYPTION_KEY"] = saved;
});

describe("encryption key file", () => {
  it("is generated once, 0600, and reused", () => {
    const k = loadEncryptionKey(dir);
    expect(Buffer.from(k, "base64").length).toBe(32);
    const file = join(dir, ".encryption-key");
    expect(readFileSync(file, "utf8")).toBe(k);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    delete process.env["VAULTBASE_ENCRYPTION_KEY"];
    expect(loadEncryptionKey(dir)).toBe(k);
  });

  it("VAULTBASE_ENCRYPTION_KEY still wins (legitimate path)", () => {
    process.env["VAULTBASE_ENCRYPTION_KEY"] = Buffer.alloc(32, 7).toString("base64");
    expect(loadEncryptionKey(dir)).toBe(Buffer.alloc(32, 7).toString("base64"));
  });

  it("plaintext secret settings are encrypted at startup and still read back", async () => {
    initDb(":memory:");
    await runMigrations();
    try {
      getRawClient().prepare(`INSERT INTO vaultbase_settings (key, value, updated_at) VALUES (?, ?, 0)`).run("smtp.pass", "plain-pw");
      getRawClient().prepare(`INSERT INTO vaultbase_settings (key, value, updated_at) VALUES (?, ?, 0)`).run("smtp.host", "mail.example.com");
      loadEncryptionKey(dir);
      expect(encryptPlaintextSecretSettings()).toBe(1);
      const raw = getRawClient().prepare(`SELECT value FROM vaultbase_settings WHERE key = 'smtp.pass'`).get() as { value: string };
      expect(raw.value).not.toContain("plain-pw");
      expect(getSetting("smtp.pass", "")).toBe("plain-pw");
      expect(getSetting("smtp.host", "")).toBe("mail.example.com");
    } finally {
      closeDb();
    }
  });
});
