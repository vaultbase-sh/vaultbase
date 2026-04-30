import type { Database } from "bun:sqlite";
import Elysia, { t } from "elysia";
import { getDb } from "../db/client.ts";
import { invalidateRateLimitCache } from "./ratelimit.ts";
import { invalidateEmailCache, sendEmail, verifySmtp } from "../core/email.ts";
import { invalidateStorageCache, testStorage, getStorageStatus, clearThumbCache } from "../core/storage.ts";
import { invalidateEgressCache } from "../core/hook-egress.ts";
import { isAuthWindowKey, validateWindowSeconds } from "../core/auth-tokens.ts";
import { verifyAuthToken } from "../core/sec.ts";

function rawClient(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

/** Read a single setting; returns the default when missing. */
export function getSetting(key: string, defaultVal: string): string {
  const row = rawClient()
    .prepare(`SELECT value FROM vaultbase_settings WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value ?? defaultVal;
}

export function setSetting(key: string, value: string): void {
  rawClient()
    .prepare(
      `INSERT INTO vaultbase_settings (key, value, updated_at) VALUES (?, ?, unixepoch())
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`
    )
    .run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const rows = rawClient()
    .prepare(`SELECT key, value FROM vaultbase_settings`)
    .all() as Array<{ key: string; value: string }>;
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
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
    .get("/api/admin/settings", async ({ request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      return { data: getAllSettings() };
    })
    // Update settings (partial — keys not in body are left alone)
    .patch(
      "/api/admin/settings",
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
        return { data: getAllSettings() };
      },
      { body: t.Record(t.String(), t.Any()) }
    )
    // Send test email — verifies + delivers a one-line message
    .post(
      "/api/admin/settings/smtp/test",
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
    .post("/api/admin/settings/storage/test", async ({ request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      const result = await testStorage();
      if (!result.ok) { set.status = 500; return { error: result.error ?? "Storage test failed", code: 500 }; }
      return { data: result };
    })
    // Storage status — what driver is in use, plus relevant identifiers
    .get("/api/admin/settings/storage/status", async ({ request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      return { data: getStorageStatus() };
    });
}
