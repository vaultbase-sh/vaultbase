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
import { initDb, closeDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { encryptPlaintextSecretSettings, getSetting, loadSettings } from "../api/settings.ts";

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
    await initDb(":memory:");
    await runMigrations();
    try {
      await db.run(`INSERT INTO vaultbase_settings (key, value, updated_at) VALUES (?, ?, 0)`, ["smtp.pass", "plain-pw"]);
      await db.run(`INSERT INTO vaultbase_settings (key, value, updated_at) VALUES (?, ?, 0)`, ["smtp.host", "mail.example.com"]);
      await loadSettings(); // rows written past the store
      loadEncryptionKey(dir);
      expect(await encryptPlaintextSecretSettings()).toBe(1);
      const raw = (await db.get<{ value: string }>(`SELECT value FROM vaultbase_settings WHERE key = 'smtp.pass'`))!;
      expect(raw.value).not.toContain("plain-pw");
      expect(getSetting("smtp.pass", "")).toBe("plain-pw");
      expect(getSetting("smtp.host", "")).toBe("mail.example.com");
    } finally {
      await closeDb();
    }
  });
});

describe("key mismatches (review 17 F-5)", () => {
  it("an existing but empty key file is not silently replaced", async () => {
    const { writeFileSync } = await import("fs");
    writeFileSync(join(dir, ".encryption-key"), "");
    expect(() => loadEncryptionKey(dir)).toThrow(/not replaced/);
  });

  it("a different key is detected before secrets are read as empty", async () => {
    const { encryptionKeyMatchesData } = await import("../api/settings.ts");
    await initDb(":memory:");
    await runMigrations();
    try {
      loadEncryptionKey(dir);
      const { setSetting } = await import("../api/settings.ts");
      setSetting("smtp.pass", "secret");
      expect(await encryptionKeyMatchesData()).toBe(true);
      process.env["VAULTBASE_ENCRYPTION_KEY"] = Buffer.alloc(32, 9).toString("base64");
      expect(await encryptionKeyMatchesData()).toBe(false);
    } finally {
      await closeDb();
    }
  });
});

describe("key check tolerates foreign values (review 18 F-3)", () => {
  it("one undecryptable value among good ones doesn't fail the check", async () => {
    const { encryptionKeyMatchesData, setSetting } = await import("../api/settings.ts");
    await initDb(":memory:");
    await runMigrations();
    try {
      loadEncryptionKey(dir);
      // A ciphertext from another install, and a non-secret key with the
      // prefix — stored first, so a check that samples one row hits them.
      await db.run(`INSERT INTO vaultbase_settings (key, value, updated_at) VALUES (?, ?, 0)`, ["app.name", "vbenc:1:not-really"]);
      await db.run(`INSERT INTO vaultbase_settings (key, value, updated_at) VALUES (?, ?, 0)`, ["oauth2.x.client_secret", "vbenc:1:AAAA:BBBB"]);
      setSetting("smtp.pass", "secret");
      expect(await encryptionKeyMatchesData()).toBe(true);
    } finally {
      await closeDb();
    }
  });
});
