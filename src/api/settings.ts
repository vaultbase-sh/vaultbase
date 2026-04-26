import type { Database } from "bun:sqlite";
import Elysia, { t } from "elysia";
import * as jose from "jose";
import { getDb } from "../db/client.ts";
import { invalidateRateLimitCache } from "./ratelimit.ts";

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
  try {
    await jose.jwtVerify(token, new TextEncoder().encode(jwtSecret), { audience: "admin" });
    return true;
  } catch {
    return false;
  }
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
        for (const [k, v] of Object.entries(body)) {
          setSetting(k, String(v));
        }
        // Bust caches that depend on settings
        invalidateRateLimitCache();
        return { data: getAllSettings() };
      },
      { body: t.Record(t.String(), t.Any()) }
    );
}
