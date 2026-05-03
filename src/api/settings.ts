import type { Database } from "bun:sqlite";
import Elysia, { t } from "elysia";
import { getDb } from "../db/client.ts";
import { invalidateRateLimitCache } from "./ratelimit.ts";
import { invalidateEmailCache, sendEmail, verifySmtp } from "../core/email.ts";
import { invalidateStorageCache, testStorage, getStorageStatus, clearThumbCache } from "../core/storage.ts";
import { invalidateEgressCache } from "../core/hook-egress.ts";
import { invalidateCorsCache } from "../core/cors.ts";
import { getUpdateStatus, runUpdateCheck, startUpdateCheckScheduler, stopUpdateCheckScheduler } from "../core/update-check.ts";
import { isAuthWindowKey, validateWindowSeconds } from "../core/auth-tokens.ts";
import { verifyAuthToken } from "../core/sec.ts";
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

/** Read a single setting; returns the default when missing. */
export function getSetting(key: string, defaultVal: string): string {
  const row = rawClient()
    .prepare(`SELECT value FROM vaultbase_settings WHERE key = ?`)
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

async function isAdmin(request: Request, jwtSecret: string): Promise<boolean> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return false;
  // Centralized verifier — fixes N-1 admin-token-bypass.
  return (await verifyAuthToken(token, jwtSecret, { audience: "admin" })) !== null;
}

export function makeSettingsPlugin(jwtSecret: string) {
  return new Elysia({ name: "settings" })
    // Read all settings
    .get("/admin/settings", async ({ request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      return { data: getAllSettings() };
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
          if (isAuthWindowKey(k)) {
            const err = validateWindowSeconds(v);
            if (err) { set.status = 422; return { error: `${k}: ${err}`, code: 422 }; }
          }
        }
        for (const [k, v] of Object.entries(body)) {
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
        return { data: getAllSettings() };
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
