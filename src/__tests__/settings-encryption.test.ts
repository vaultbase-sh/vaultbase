import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import {
  getSetting,
  setSetting,
  getAllSettings,
  shouldEncryptSettingKey,
  _resetSettingsCryptoWarnings,
} from "../api/settings.ts";
import {
  encryptValue,
  decryptValue,
  encryptValueSync,
  decryptValueSync,
  isEncrypted,
} from "../core/encryption.ts";

// 32 random bytes hex-encoded → 64 chars
const TEST_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ALT_KEY  = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

let tmpDir: string;
let originalKey: string | undefined;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-settings-crypto-"));
  setLogsDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
  originalKey = process.env["VAULTBASE_ENCRYPTION_KEY"];
  _resetSettingsCryptoWarnings();
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalKey === undefined) delete process.env["VAULTBASE_ENCRYPTION_KEY"];
  else process.env["VAULTBASE_ENCRYPTION_KEY"] = originalKey;
});

describe("shouldEncryptSettingKey", () => {
  it("matches secret-shaped suffixes case-insensitively", () => {
    expect(shouldEncryptSettingKey("smtp.password")).toBe(true);
    expect(shouldEncryptSettingKey("smtp.pass")).toBe(true);
    expect(shouldEncryptSettingKey("oauth2.google.client_secret")).toBe(true);
    expect(shouldEncryptSettingKey("oauth2.google.secret")).toBe(true);
    expect(shouldEncryptSettingKey("notifications.providers.onesignal.api_key")).toBe(true);
    expect(shouldEncryptSettingKey("notifications.providers.fcm.service_account")).toBe(true);
    expect(shouldEncryptSettingKey("metrics.token")).toBe(true);
    expect(shouldEncryptSettingKey("storage.s3.access_key")).toBe(true);
    expect(shouldEncryptSettingKey("STORAGE.S3.SECRET")).toBe(true);
  });

  it("leaves non-secret keys alone", () => {
    expect(shouldEncryptSettingKey("smtp.user")).toBe(false);
    expect(shouldEncryptSettingKey("smtp.host")).toBe(false);
    expect(shouldEncryptSettingKey("smtp.from")).toBe(false);
    expect(shouldEncryptSettingKey("theme.accent")).toBe(false);
    expect(shouldEncryptSettingKey("update_check.enabled")).toBe(false);
    expect(shouldEncryptSettingKey("update_check.checked_at")).toBe(false);
    expect(shouldEncryptSettingKey("auth.lockout.duration_seconds")).toBe(false);
    expect(shouldEncryptSettingKey("security.allowed_origins")).toBe(false);
  });
});

describe("setSetting / getSetting with encryption key set", () => {
  beforeEach(() => { process.env["VAULTBASE_ENCRYPTION_KEY"] = TEST_KEY; });

  it("encrypts a secret-shaped value at rest, returns plaintext on read", () => {
    setSetting("smtp.password", "hunter2");

    // Raw row in SQLite must NOT be the plaintext.
    const { getDb } = require("../db/client.ts");
    const raw = (getDb() as any).$client
      .prepare(`SELECT value FROM vaultbase_settings WHERE key = ?`)
      .get("smtp.password") as { value: string };
    expect(raw.value).not.toBe("hunter2");
    expect(isEncrypted(raw.value)).toBe(true);

    // Read returns plaintext.
    expect(getSetting("smtp.password", "")).toBe("hunter2");
  });

  it("does not encrypt non-secret keys even with key set", () => {
    setSetting("theme.accent", "#ff00ff");
    const raw = (require("../db/client.ts").getDb() as any).$client
      .prepare(`SELECT value FROM vaultbase_settings WHERE key = ?`)
      .get("theme.accent") as { value: string };
    expect(raw.value).toBe("#ff00ff");
    expect(isEncrypted(raw.value)).toBe(false);
  });

  it("getAllSettings decrypts every encrypted value", () => {
    setSetting("smtp.user", "alice");
    setSetting("smtp.password", "hunter2");
    setSetting("notifications.providers.fcm.service_account", '{"type":"service_account"}');
    setSetting("theme.accent", "#abcdef");

    const all = getAllSettings();
    expect(all["smtp.user"]).toBe("alice");
    expect(all["smtp.password"]).toBe("hunter2");
    expect(all["notifications.providers.fcm.service_account"]).toBe('{"type":"service_account"}');
    expect(all["theme.accent"]).toBe("#abcdef");
  });

  it("idempotent re-save: writing then re-reading yields the same plaintext", () => {
    setSetting("smtp.password", "hunter2");
    expect(getSetting("smtp.password", "")).toBe("hunter2");
    // Simulate the PATCH-roundtrip: read all, then write all back.
    const all = getAllSettings();
    for (const [k, v] of Object.entries(all)) setSetting(k, v);
    expect(getSetting("smtp.password", "")).toBe("hunter2");
  });

  it("preserves a value that comes in already-encrypted (vb-migrate apply)", () => {
    const ciphertext = encryptValueSync("preexisting-secret");
    setSetting("smtp.password", ciphertext);
    // Stored verbatim (not double-encrypted), but read returns plaintext.
    expect(getSetting("smtp.password", "")).toBe("preexisting-secret");
  });
});

describe("setSetting without encryption key", () => {
  beforeEach(() => { delete process.env["VAULTBASE_ENCRYPTION_KEY"]; });

  it("stores secrets as plaintext (back-compat) and emits one warning per key", () => {
    const errors: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any) => {
      errors.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };
    try {
      setSetting("smtp.password", "hunter2");
      setSetting("smtp.password", "hunter3"); // second set, should NOT re-warn
    } finally {
      (process.stderr as any).write = origWrite;
    }

    const warns = errors.filter((s) => s.includes("smtp.password"));
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("VAULTBASE_ENCRYPTION_KEY is not set");

    // Storage is plaintext (back-compat path).
    expect(getSetting("smtp.password", "")).toBe("hunter3");
  });
});

describe("decrypt failure path", () => {
  it("returns empty string and warns when key is wrong", () => {
    process.env["VAULTBASE_ENCRYPTION_KEY"] = TEST_KEY;
    setSetting("smtp.password", "hunter2");

    // Rotate to a different key — old ciphertext is now unreadable.
    process.env["VAULTBASE_ENCRYPTION_KEY"] = ALT_KEY;
    _resetSettingsCryptoWarnings();

    const errors: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any) => {
      errors.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    };
    let value: string;
    try {
      value = getSetting("smtp.password", "DEFAULT");
    } finally {
      (process.stderr as any).write = origWrite;
    }

    expect(value).toBe(""); // empty, not the default — distinguishes "unreadable" from "missing"
    const warns = errors.filter((s) => s.includes("smtp.password"));
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("failed to decrypt");
  });
});

describe("wire compatibility: sync ⇄ async", () => {
  beforeEach(() => { process.env["VAULTBASE_ENCRYPTION_KEY"] = TEST_KEY; });

  it("sync-encrypted decrypts via async", async () => {
    const ct = encryptValueSync("round-trip-1");
    expect(isEncrypted(ct)).toBe(true);
    expect(await decryptValue(ct)).toBe("round-trip-1");
  });

  it("async-encrypted decrypts via sync", async () => {
    const ct = await encryptValue("round-trip-2");
    expect(isEncrypted(ct)).toBe(true);
    expect(decryptValueSync(ct)).toBe("round-trip-2");
  });

  it("each encryption produces a fresh IV (no key-stream reuse)", () => {
    const a = encryptValueSync("same-plaintext");
    const b = encryptValueSync("same-plaintext");
    expect(a).not.toBe(b);
    expect(decryptValueSync(a)).toBe("same-plaintext");
    expect(decryptValueSync(b)).toBe("same-plaintext");
  });
});
