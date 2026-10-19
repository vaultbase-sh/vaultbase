import Elysia, { t } from "elysia";
import { db, driverOpen, getDriver, type DbDriver } from "../db/index.ts";
import { onCloseDb, trackPendingWrite } from "../db/client.ts";
import { broadcast } from "../core/thread-bus.ts";
import { invalidateRateLimitCache } from "./ratelimit.ts";
import { invalidateEmailCache, listEmailTransports, sendEmail, verifySmtp } from "../core/email.ts";
import { invalidateStorageCache, testStorage, getStorageStatus, clearThumbCache, listStorageDrivers } from "../core/storage.ts";
import { invalidateEgressCache, parseCidr } from "../core/hook-egress.ts";
import { isIP } from "node:net";
import { invalidateCorsCache } from "../core/cors.ts";
import { getUpdateStatus, runUpdateCheck, startUpdateCheckScheduler, stopUpdateCheckScheduler } from "../core/update-check.ts";
import { isAuthWindowKey, SESSION_MAX_KEY, validateSessionMaxSeconds, validateWindowSeconds } from "../core/auth-tokens.ts";
import { validateBackupKeep } from "../core/backups.ts";
import { validateCron } from "../core/jobs.ts";
import {
  encryptValueSync,
  decryptValueSync,
  isEncryptionAvailable,
  isEncrypted,
} from "../core/encryption.ts";
import { adminGuard } from "./_admin.ts";

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
export async function encryptionKeyMatchesData(): Promise<boolean> {
  const rows = await db.all<{ key: string; value: string }>(`SELECT key, value FROM vaultbase_settings`);
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
export async function encryptPlaintextSecretSettings(): Promise<number> {
  if (!isEncryptionAvailable()) return 0;
  const rows = await db.all<{ key: string; value: string }>(`SELECT key, value FROM vaultbase_settings`);
  let n = 0;
  for (const r of rows) {
    if (!shouldEncryptSettingKey(r.key) || r.value === "" || isEncrypted(r.value)) continue;
    await setSetting(r.key, r.value);
    n++;
  }
  return n;
}

/**
 * The settings store. Every setting lives in memory as stored (secrets stay
 * encrypted until read), so reads on the request path (trusted proxies, rate limits, CORS, upload limits) never
 * touch the database. It is filled from the table at boot
 * ({@link loadSettings}) and, on SQLite, on first use after the database
 * opens; refreshed in the background every {@link RELOAD_MS} so a change made
 * by another process (the CLI, a cluster worker) shows up within that; kept
 * exact by `setSetting` (writes through) and by the thread bus, which tells
 * the read workers which key changed. Code that writes the table directly
 * calls {@link invalidateSetting} for the key. A reopened database (restore,
 * tests) gets a new driver and so a fresh store.
 */
const RELOAD_MS = 2_000;
let store: { driver: DbDriver; values: Map<string, string> } | null = null;
let reloadTimer: ReturnType<typeof setInterval> | null = null;

function decodeRows(rows: Array<{ key: string; value: string }>): Map<string, string> {
  return new Map(rows.map((r) => [r.key, r.value]));
}

function install(driver: DbDriver, values: Map<string, string>): Map<string, string> {
  store = { driver, values };
  if (reloadTimer === null) {
    reloadTimer = setInterval(() => { void _reloadSettings(); }, RELOAD_MS);
    reloadTimer.unref?.();
  }
  return values;
}

/** Load the store from the database. Boot calls it once the schema is ready. */
export async function loadSettings(): Promise<void> {
  const driver = getDriver();
  const rows = await db.all<{ key: string; value: string }>(`SELECT key, value FROM vaultbase_settings`);
  install(driver, decodeRows(rows));
}

/**
 * Keys `setSetting` changed while a reload's read was in flight: the read
 * may predate their write, so the reload keeps this thread's values for
 * them instead of putting the old ones back.
 */
const reloadsInFlight = new Set<Set<string>>();

/** The background refresh: a no-op when the database is closed or was reopened since the store was filled. */
export async function _reloadSettings(): Promise<void> {
  const written = new Set<string>();
  reloadsInFlight.add(written);
  try {
    if (!driverOpen() || !store || store.driver !== getDriver()) return;
    const driver = getDriver();
    const rows = await db.all<{ key: string; value: string }>(`SELECT key, value FROM vaultbase_settings`);
    if (store?.driver !== driver) return;
    const next = decodeRows(rows);
    for (const key of written) {
      const mine = store.values.get(key);
      if (mine === undefined) next.delete(key);
      else next.set(key, mine);
    }
    store.values = next;
  } catch { /* closing, closed, or the table is gone: the next load sorts it out */ } finally {
    reloadsInFlight.delete(written);
  }
}

/**
 * The store for the open database. Filled synchronously on first use when it
 * is missing: tests open a database and read settings without a boot
 * sequence, and the SQLite driver answers synchronously. A driver that
 * cannot is loaded at boot and never reaches this path.
 */
function values(): Map<string, string> {
  const driver = getDriver();
  if (store && store.driver === driver) return store.values;
  return install(driver, decodeRows(db.sync.all<{ key: string; value: string }>(`SELECT key, value FROM vaultbase_settings`)));
}

/** Read a single setting; returns the default when missing. */
export function getSetting(key: string, defaultVal: string): string {
  const raw = values().get(key);
  return raw === undefined ? defaultVal : maybeDecrypt(key, raw);
}

/**
 * Re-read one setting from the table: for code that writes the table
 * directly (the backup scheduler's claim), and for the read workers when the
 * bus says the key changed on the main thread.
 */
export async function invalidateSetting(key: string): Promise<void> {
  if (!driverOpen()) return;
  const v = values();
  const row = await db.get<{ value: string }>(`SELECT value FROM vaultbase_settings WHERE key = ?`, [key]);
  if (row == null) v.delete(key);
  else v.set(key, row.value);
}

/** Drop the store so the next read loads it again (tests). */
export function _resetSettingsCache(): void {
  store = null;
}
onCloseDb(_resetSettingsCache);

/**
 * Write a setting. The store is updated before anything is awaited, so a
 * reader on the same thread sees the new value at once even if the caller
 * does not wait for the row to be written.
 */
export async function setSetting(key: string, value: string): Promise<void> {
  const stored = maybeEncrypt(key, value);
  values().set(key, stored);
  for (const written of reloadsInFlight) written.add(key);
  // Tracked: callers may not await, and closing must not drop the table under it.
  await trackPendingWrite(Promise.resolve(db.run(
    `INSERT INTO vaultbase_settings (key, value, updated_at) VALUES (?, ?, ${db.dialect.epochNow})
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = ${db.dialect.epochNow}`,
    [key, stored],
  )));
  broadcast({ type: "bus", kind: "settings", key });
}

export function getAllSettings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, raw] of values()) out[k] = maybeDecrypt(k, raw);
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

/**
 * The first problem with a settings change, or null. Checked for the whole
 * change before any of it is written, so a bad value doesn't half-apply it.
 * Shared by PATCH /admin/settings and MCP's update_setting.
 */
/** Comma-separated CIDRs (or bare IPs, when `bareIps`). Names the first entry that isn't one. */
function validateAddressList(v: unknown, bareIps: boolean): string | null {
  const bad = String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean)
    .find((x) => (x.includes("/") || !bareIps ? parseCidr(x) === null : isIP(x) === 0));
  return bad === undefined ? null : `'${bad}' isn't ${bareIps ? "an IP address or CIDR" : "a CIDR"} (e.g. 10.0.0.0/8)`;
}

function validateIntAtLeast(v: unknown, min: number): string | null {
  const raw = String(v ?? "").trim();
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min ? null : `must be a whole number of at least ${min}`;
}

/** `ops@example.com` or `Ops <ops@example.com>`. */
const FROM_RE = /^(?:[^<>@]*<\s*[^\s<>@]+@[^\s<>@]+\s*>|[^\s<>@]+@[^\s<>@]+)$/;

export function validateSettingsPatch(body: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(body)) {
    if (k === "hooks.http.deny" || k === "hooks.http.allow") {
      if (!(k === "hooks.http.deny" && String(v).trim().toLowerCase() === "off")) {
        const err = validateAddressList(v, false);
        if (err) return `${k}: ${err}`;
      }
    }
    if (k === "security.trusted_proxies") {
      const err = validateAddressList(v, true);
      if (err) return `${k}: ${err}`;
    }
    if (k === "auth.lockout.duration_seconds") {
      const err = validateIntAtLeast(v, 60);
      if (err) return `${k}: ${err}`;
    }
    if (k === "cors.max_age") {
      const err = validateIntAtLeast(v, 0);
      if (err) return `${k}: ${err}`;
    }
    if (k === "smtp.from" && String(v ?? "").trim() !== "" && !FROM_RE.test(String(v).trim())) {
      return `${k}: expected an address like ops@example.com or "Ops <ops@example.com>"`;
    }
    if (k === SESSION_MAX_KEY) {
      const err = validateSessionMaxSeconds(v);
      if (err) return `${k}: ${err}`;
    }
    if (isAuthWindowKey(k)) {
      const err = validateWindowSeconds(v);
      if (err) return `${k}: ${err}`;
    }
    if (k === "files.max_upload_size") {
      const err = validateMaxUploadSize(v);
      if (err) return `${k}: ${err}`;
    }
    if (k === "maintenance.retention_days" || k === "audit.retention_days") {
      const err = validateRetentionDays(v);
      if (err) return `${k}: ${err}`;
    }
    if (k === "backups.keep") {
      const err = validateBackupKeep(v);
      if (err) return `${k}: ${err}`;
    }
    if (k === "storage.driver" && v !== "" && !listStorageDrivers().some((d) => d.name === v)) {
      return `${k}: no storage driver named '${String(v)}' is registered`;
    }
    if (k === "email.transport" && v !== "" && !listEmailTransports().some((t) => t.name === v)) {
      return `${k}: no email transport named '${String(v)}' is registered`;
    }
    if (k === "backups.cron") {
      const err = validateCron(String(v).trim());
      if (err) return `Backup schedule isn't a valid cron expression: ${err}`;
    }
  }
  return null;
}

/** Write a validated settings change and refresh what depends on settings. */
export async function applySettingsPatch(body: Record<string, unknown>): Promise<void> {
  for (const [k, v] of Object.entries(body)) {
    // The masked value the UI read and sent back: keep what's stored.
    if (shouldEncryptSettingKey(k) && v === SECRET_SETTING_MASK) continue;
    await setSetting(k, String(v));
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
}

/** What the Application tab shows: how this server was started. */
export interface RuntimeInfo {
  port: number;
  dataDir: string;
  /** Whether the JWT secret came from the environment or the data directory. */
  jwtSecretSource: "env" | "data_dir";
}

export function makeSettingsPlugin(jwtSecret: string, runtime?: RuntimeInfo) {
  return new Elysia({ name: "settings" })
    .use(adminGuard(jwtSecret))
    .get("/admin/runtime", () => {
      return { data: runtime ?? null };
    }, { requireAdmin: true })
    // Read all settings
    .get("/admin/settings", async () => {
      return { data: getAllSettingsMasked() };
    }, { requireAdmin: true })
    // Update settings (partial — keys not in body are left alone)
    .patch(
      "/admin/settings",
      async ({ body, set }) => {
        const err = validateSettingsPatch(body);
        if (err) { set.status = 422; return { error: err, code: 422 }; }
        await applySettingsPatch(body);
        return { data: getAllSettingsMasked() };
      },
      { requireAdmin: true, body: t.Record(t.String(), t.Any()) }
    )
    // Send test email — verifies + delivers a one-line message
    .post(
      "/admin/settings/smtp/test",
      async ({ body, set }) => {
        if (!body.to || typeof body.to !== "string") {
          set.status = 422; return { error: "`to` required", code: 422 };
        }
        if (!/^[^\s<>@]+@[^\s<>@]+$/.test(body.to.trim())) {
          set.status = 422; return { error: `'${body.to}' isn't an email address`, code: 422 };
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
          set.status = 422;
          return { error: e instanceof Error ? e.message : String(e), code: 422 };
        }
      },
      { requireAdmin: true, body: t.Object({ to: t.String() }) }
    )
    // Storage round-trip test: write probe object → read back → delete
    .post("/admin/settings/storage/test", async ({ set }) => {
      const result = await testStorage();
      // 422, not 500: a 5xx message is replaced with a generic one, and the
      // reason (a refused connection, a bad key) is what the admin needs.
      if (!result.ok) { set.status = 422; return { error: result.error ?? "Storage test failed", code: 422 }; }
      return { data: result };
    }, { requireAdmin: true })
    // Storage status — what driver is in use, plus relevant identifiers
    .get("/admin/settings/storage/status", async () => {
      return { data: getStorageStatus() };
    }, { requireAdmin: true })
    // Update checker — current vs latest GitHub release.
    .get("/admin/update-status", async () => {
      return { data: getUpdateStatus() };
    }, { requireAdmin: true })
    .post("/admin/update-status/check", async () => {
      await runUpdateCheck();
      return { data: getUpdateStatus() };
    }, { requireAdmin: true });
}
