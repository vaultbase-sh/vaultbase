import type { Database } from "bun:sqlite";
import Elysia, { t } from "elysia";
import { getDb } from "../db/client.ts";
import { invalidateRateLimitCache } from "./ratelimit.ts";
import { invalidateEmailCache, listEmailTransports, sendEmail, verifySmtp } from "../core/email.ts";
import { invalidateStorageCache, testStorage, getStorageStatus, clearThumbCache, listStorageDrivers } from "../core/storage.ts";
import { invalidateEgressCache } from "../core/hook-egress.ts";
import { invalidateCorsCache } from "../core/cors.ts";
import { getUpdateStatus, runUpdateCheck, startUpdateCheckScheduler, stopUpdateCheckScheduler } from "../core/update-check.ts";
import { isAuthWindowKey, SESSION_MAX_KEY, validateSessionMaxSeconds, validateWindowSeconds } from "../core/auth-tokens.ts";
import { verifyAuthToken } from "../core/sec.ts";
import { validateBackupKeep } from "../core/backups.ts";
import { validateCron } from "../core/jobs.ts";
import {
  encryptValueSync,
  decryptValueSync,
  isEncryptionAvailable,
  isEncrypted,
} from "../core/encryption.ts";

function rawClient(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

/**
 * Setting keys whose values look like secrets and should be AES-GCM-encrypted
 * at rest when `VAULTBASE_ENCRYPTION_KEY` is configured. The match is on the
 * full key's lowercased suffix — e.g. `smtp.password`, `oauth2.google.secret`,
 * `notifications.providers.fcm.service_account` all match.
 *
 * Encryption is opportunistic: if no key is configured, the value is stored
 * plaintext (with a one-time stderr warning per key) so existing deployments
 * keep working. Set `VAULTBASE_ENCRYPTION_KEY` to upgrade to at-rest crypto.
 */
const ENCRYPTED_KEY_SUFFIXES: readonly string[] = [
  ".password",
  ".pass",
  ".api_key",
  ".apikey",
  ".secret",
  ".client_secret",
  ".private_key",
  ".privatekey",
  ".access_key",
  "_access_key",
  ".accesskey",
  ".service_account",
  ".token",
];

export function shouldEncryptSettingKey(key: string): boolean {
  const lower = key.toLowerCase();
  for (const sfx of ENCRYPTED_KEY_SUFFIXES) {
    if (lower.endsWith(sfx)) return true;
  }
  return false;
}

const warnedPlaintextKeys = new Set<string>();
const warnedDecryptFails = new Set<string>();

/** Test-only: clear the per-process warning dedup set. */
export function _resetSettingsCryptoWarnings(): void {
  warnedPlaintextKeys.clear();
  warnedDecryptFails.clear();
}

function maybeEncrypt(key: string, value: string): string {
  if (!shouldEncryptSettingKey(key)) return value;
  // Idempotent: a re-PATCH that round-tripped a previously-decrypted value
  // would be re-encrypted with a fresh IV, which is fine, but if the caller
  // hands us a vbenc:-prefixed string (e.g. `vb-migrate apply` shipping
  // already-encrypted snapshots) preserve it verbatim.
  if (isEncrypted(value)) return value;
  if (!isEncryptionAvailable()) {
    if (!warnedPlaintextKeys.has(key)) {
      warnedPlaintextKeys.add(key);
      process.stderr.write(
        `[settings] "${key}" looks like a secret but VAULTBASE_ENCRYPTION_KEY ` +
        `is not set — storing plaintext. Set the env var to encrypt at rest.\n`,
      );
    }
    return value;
  }
  return encryptValueSync(value);
}

function maybeDecrypt(key: string, value: string): string {
  if (!isEncrypted(value)) return value;
  try {
    return decryptValueSync(value);
  } catch (e) {
    if (!warnedDecryptFails.has(key)) {
      warnedDecryptFails.add(key);
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(
        `[settings] failed to decrypt "${key}" — VAULTBASE_ENCRYPTION_KEY ` +
        `missing, wrong, or value corrupted (${msg}). Returning empty string.\n`,
      );
    }
    return "";
  }
}

/**
 * Whether the current key decrypts the stored secret settings. False means
 * the key changed (e.g. VAULTBASE_ENCRYPTION_KEY set to something other than
 * the generated `.encryption-key`): starting anyway would read every secret
 * as "" and could overwrite them.
 */
export function encryptionKeyMatchesData(): boolean {
  const rows = rawClient()
    .prepare(`SELECT key, value FROM vaultbase_settings`)
    .all() as Array<{ key: string; value: string }>;
  // Only secret settings, and the key is wrong only if none of them decrypt:
  // one value copied in from another install (or typed with a "vbenc:"
  // prefix) mustn't stop every later start.
  const secrets = rows.filter((r) => shouldEncryptSettingKey(r.key) && isEncrypted(r.value));
  if (secrets.length === 0) return true;
  if (!isEncryptionAvailable()) return false;
  return secrets.some((r) => {
    try { decryptValueSync(r.value); return true; } catch { return false; }
  });
}

/**
 * Encrypt secret settings still stored in plaintext (written before a key
 * existed). Run at startup; returns how many were converted.
 */
export function encryptPlaintextSecretSettings(): number {
  if (!isEncryptionAvailable()) return 0;
  const rows = rawClient()
    .prepare(`SELECT key, value FROM vaultbase_settings`)
    .all() as Array<{ key: string; value: string }>;
  let n = 0;
  for (const r of rows) {
    if (!shouldEncryptSettingKey(r.key) || r.value === "" || isEncrypted(r.value)) continue;
    setSetting(r.key, r.value);
    n++;
  }
  return n;
}

/** Read a single setting; returns the default when missing. */
export function getSetting(key: string, defaultVal: string): string {
  // `query` reuses the compiled statement; this runs on every request
  // (trusted-proxy lookup), and compiling it each time showed in profiles.
  const row = rawClient()
    .query(`SELECT value FROM vaultbase_settings WHERE key = ?`)
    .get(key) as { value: string } | undefined | null;
  // bun:sqlite returns null (not undefined) on no-match — must catch both.
  if (row == null) return defaultVal;
  return maybeDecrypt(key, row.value);
}

export function setSetting(key: string, value: string): void {
  const stored = maybeEncrypt(key, value);
  rawClient()
    .prepare(
      `INSERT INTO vaultbase_settings (key, value, updated_at) VALUES (?, ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`
    )
    .run(key, stored);
}

export function getAllSettings(): Record<string, string> {
  const rows = rawClient()
    .prepare(`SELECT key, value FROM vaultbase_settings`)
    .all() as Array<{ key: string; value: string }>;
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = maybeDecrypt(r.key, r.value);
  return out;
}

/**
 * What a secret-valued setting (see shouldEncryptSettingKey) reads as through
 * the admin API and MCP. They used to come back decrypted, so anything that
 * could read one admin response had every SMTP password, OAuth client secret
 * and storage key. A PATCH that sends the mask back leaves the value alone.
 */
export const SECRET_SETTING_MASK = "********";

/** getAllSettings() with secret values masked (empty ones stay empty). */
export function getAllSettingsMasked(): Record<string, string> {
  const out = getAllSettings();
  for (const k of Object.keys(out)) {
    if (shouldEncryptSettingKey(k) && out[k] !== "") out[k] = SECRET_SETTING_MASK;
  }
  return out;
}

async function isAdmin(request: Request, jwtSecret: string): Promise<boolean> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return false;
  // Centralized verifier — fixes N-1 admin-token-bypass.
  return (await verifyAuthToken(token, jwtSecret, { audience: "admin" })) !== null;
}

/** Bounds for `files.max_upload_size` (bytes). 128 MB is Bun's default request body limit. */
export const MIN_UPLOAD_BYTES = 1024;
export const MAX_UPLOAD_BYTES = 128 * 1024 * 1024;

export function validateMaxUploadSize(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isInteger(n)) return "must be a whole number of bytes";
  if (n < MIN_UPLOAD_BYTES || n > MAX_UPLOAD_BYTES) {
    return `must be between ${MIN_UPLOAD_BYTES} and ${MAX_UPLOAD_BYTES} bytes`;
  }
  return null;
}

/** `maintenance.retention_days`: whole days, 0 = keep job / delivery history forever. */
export function validateRetentionDays(value: unknown): string | null {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 3650) return "must be a whole number of days between 0 and 3650";
  return null;
}

export function makeSettingsPlugin(jwtSecret: string) {
  return new Elysia({ name: "settings" })
    // Read all settings
    .get("/admin/settings", async ({ request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      return { data: getAllSettingsMasked() };
    })
    // Update settings (partial — keys not in body are left alone)
    .patch(
      "/admin/settings",
      async ({ request, body, set }) => {
        if (!(await isAdmin(request, jwtSecret))) {
          set.status = 401; return { error: "Unauthorized", code: 401 };
        }
        // Pre-validate auth window keys before any write — reject the whole
        // PATCH on the first invalid value rather than half-applying.
        for (const [k, v] of Object.entries(body)) {
          if (k === SESSION_MAX_KEY) {
            const err = validateSessionMaxSeconds(v);
            if (err) { set.status = 422; return { error: `${k}: ${err}`, code: 422 }; }
          }
          if (isAuthWindowKey(k)) {
            const err = validateWindowSeconds(v);
            if (err) { set.status = 422; return { error: `${k}: ${err}`, code: 422 }; }
          }
          if (k === "files.max_upload_size") {
            const err = validateMaxUploadSize(v);
            if (err) { set.status = 422; return { error: `${k}: ${err}`, code: 422 }; }
          }
          if (k === "maintenance.retention_days" || k === "audit.retention_days") {
            const err = validateRetentionDays(v);
            if (err) { set.status = 422; return { error: `${k}: ${err}`, code: 422 }; }
          }
          if (k === "backups.keep") {
            const err = validateBackupKeep(v);
            if (err) { set.status = 422; return { error: `${k}: ${err}`, code: 422 }; }
          }
          if (k === "storage.driver" && v !== "" && !listStorageDrivers().some((d) => d.name === v)) {
            set.status = 422; return { error: `${k}: no storage driver named '${String(v)}' is registered`, code: 422 };
          }
          if (k === "email.transport" && v !== "" && !listEmailTransports().some((t) => t.name === v)) {
            set.status = 422; return { error: `${k}: no email transport named '${String(v)}' is registered`, code: 422 };
          }
          if (k === "backups.cron") {
            const err = validateCron(String(v).trim());
            if (err) { set.status = 422; return { error: `${k}: ${err}`, code: 422 }; }
          }
        }
        for (const [k, v] of Object.entries(body)) {
          // The masked value the UI read and sent back: keep what's stored.
          if (shouldEncryptSettingKey(k) && v === SECRET_SETTING_MASK) continue;
          setSetting(k, String(v));
        }
        // Bust caches that depend on settings
        invalidateRateLimitCache();
        invalidateEmailCache();
        // Storage driver / S3 creds may have changed — drop the cached client
        // and the local thumb cache (different bucket means different objects)
        invalidateStorageCache();
        clearThumbCache();
        invalidateEgressCache();
        invalidateCorsCache();
        // Re-arm the update-check scheduler if the toggle flipped.
        if (Object.prototype.hasOwnProperty.call(body, "update_check.enabled")) {
          if (String(body["update_check.enabled"]) === "1") startUpdateCheckScheduler();
          else stopUpdateCheckScheduler();
        }
        return { data: getAllSettingsMasked() };
      },
      { body: t.Record(t.String(), t.Any()) }
    )
    // Send test email — verifies + delivers a one-line message
    .post(
      "/admin/settings/smtp/test",
      async ({ request, body, set }) => {
        if (!(await isAdmin(request, jwtSecret))) {
          set.status = 401; return { error: "Unauthorized", code: 401 };
        }
        if (!body.to || typeof body.to !== "string") {
          set.status = 422; return { error: "`to` required", code: 422 };
        }
        const v = await verifySmtp();
        if (!v.ok) { set.status = 422; return { error: v.error ?? "SMTP verify failed", code: 422 }; }
        try {
          const info = await sendEmail({
            to: body.to,
            subject: "Vaultbase SMTP test",
            text: "If you can read this, your SMTP settings are working.",
          });
          return { data: { messageId: info.messageId } };
        } catch (e) {
          set.status = 500;
          return { error: e instanceof Error ? e.message : String(e), code: 500 };
        }
      },
      { body: t.Object({ to: t.String() }) }
    )
    // Storage round-trip test: write probe object → read back → delete
    .post("/admin/settings/storage/test", async ({ request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      const result = await testStorage();
      if (!result.ok) { set.status = 500; return { error: result.error ?? "Storage test failed", code: 500 }; }
      return { data: result };
    })
    // Storage status — what driver is in use, plus relevant identifiers
    .get("/admin/settings/storage/status", async ({ request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      return { data: getStorageStatus() };
    })
    // Update checker — current vs latest GitHub release.
    .get("/admin/update-status", async ({ request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      return { data: getUpdateStatus() };
    })
    .post("/admin/update-status/check", async ({ request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      await runUpdateCheck();
      return { data: getUpdateStatus() };
    });
}
