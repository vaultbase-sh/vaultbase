/**
 * Notifications API plugin.
 *
 * Admin endpoints (under /api/v1):
 *   - GET    /admin/notifications/providers
 *   - PATCH  /admin/notifications/providers/:name
 *   - POST   /admin/notifications/providers/:name/test-connection
 *   - POST   /admin/notifications/test
 *
 * Authenticated-user endpoints (FCM/APNs token registration; OneSignal users
 * never hit these — their client SDK manages the device layer):
 *   - POST   /notifications/devices
 *   - DELETE /notifications/devices/:token
 */
import type { Database } from "bun:sqlite";
import Elysia, { t } from "elysia";
import { getDb } from "../db/client.ts";
import { setSetting, getAllSettings } from "./settings.ts";
import { verifyAuthToken } from "../core/sec.ts";
import {
  loadProviderConfigs,
  testOneSignalConnection,
  testFcmConnection,
  dispatchNotification,
  bootstrapNotificationCollections,
  PROVIDER_NAMES,
  type ProviderName,
  type NotificationPayload,
} from "../core/notifications.ts";

function rawClient(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

async function isAdmin(request: Request, jwtSecret: string): Promise<boolean> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return false;
  return (await verifyAuthToken(token, jwtSecret, { audience: "admin" })) !== null;
}

async function authedUser(
  request: Request,
  jwtSecret: string,
): Promise<{ id: string; email?: string } | null> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const ctx = await verifyAuthToken(token, jwtSecret, { audience: "user" });
  if (!ctx) return null;
  return ctx.email ? { id: ctx.id, email: ctx.email } : { id: ctx.id };
}

function isProviderName(s: string): s is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(s);
}

/**
 * Strip secrets out of provider config for the admin GET response. The admin
 * is already authenticated, so the leak risk is low — but masking keeps the
 * value out of browser-devtools logs and screenshots, which is the more
 * common exposure path.
 */
function describeProviders(opts: { reveal?: boolean } = {}) {
  const cfg = loadProviderConfigs();
  let fcmClientEmail: string | null = null;
  let fcmServiceAccountBytes = 0;
  if (cfg.fcm.service_account) {
    fcmServiceAccountBytes = cfg.fcm.service_account.length;
    try {
      const sa = JSON.parse(cfg.fcm.service_account) as { client_email?: string; project_id?: string };
      fcmClientEmail = typeof sa.client_email === "string" ? sa.client_email : null;
      // If project_id wasn't set explicitly, surface the SA's project_id for the UI.
    } catch { /* invalid JSON — leave nulls */ }
  }
  return {
    onesignal: {
      enabled: cfg.onesignal.enabled,
      app_id: cfg.onesignal.app_id,
      api_key_set: cfg.onesignal.api_key.length > 0,
      // Admin opt-in reveal — surfaces the raw key for the settings UI's
      // "show secret" toggle. Default-masked keeps it out of casual logs.
      ...(opts.reveal ? { api_key: cfg.onesignal.api_key } : {}),
    },
    fcm: {
      enabled: cfg.fcm.enabled,
      project_id: cfg.fcm.project_id,
      service_account_set: fcmServiceAccountBytes > 0,
      service_account_bytes: fcmServiceAccountBytes,
      service_account_client_email: fcmClientEmail,
      ...(opts.reveal ? { service_account: cfg.fcm.service_account } : {}),
    },
  };
}

const PATCH_BODY = t.Object({
  enabled: t.Optional(t.Boolean()),
  app_id: t.Optional(t.String()),
  api_key: t.Optional(t.String()),
  project_id: t.Optional(t.String()),
  service_account: t.Optional(t.String()),
});
type PatchBody = {
  enabled?: boolean;
  app_id?: string;
  api_key?: string;
  project_id?: string;
  service_account?: string;
};

const SETTING_KEYS: Record<ProviderName, Record<keyof PatchBody, string | null>> = {
  onesignal: {
    enabled: "notifications.providers.onesignal.enabled",
    app_id: "notifications.providers.onesignal.app_id",
    api_key: "notifications.providers.onesignal.api_key",
    project_id: null,
    service_account: null,
  },
  fcm: {
    enabled: "notifications.providers.fcm.enabled",
    app_id: null,
    api_key: null,
    project_id: "notifications.providers.fcm.project_id",
    service_account: "notifications.providers.fcm.service_account",
  },
};

function applyPatch(provider: ProviderName, body: PatchBody): { applied: number; rejected: string[] } {
  const map = SETTING_KEYS[provider];
  let applied = 0;
  const rejected: string[] = [];
  for (const key of Object.keys(body) as Array<keyof PatchBody>) {
    const settingKey = map[key];
    if (!settingKey) {
      rejected.push(`${provider}.${key}`);
      continue;
    }
    const v = body[key];
    if (typeof v === "boolean") {
      setSetting(settingKey, v ? "1" : "0");
    } else if (typeof v === "string") {
      setSetting(settingKey, v);
    }
    applied++;
  }
  return { applied, rejected };
}

export function makeNotificationsPlugin(jwtSecret: string) {
  return new Elysia({ name: "notifications" })
    // ── Admin: list provider config (secrets masked) ───────────────────────
    .get("/admin/notifications/providers", async ({ request, query, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401;
        return { error: "Unauthorized", code: 401 };
      }
      const reveal = query.reveal === "1" || query.reveal === "true";
      return { data: describeProviders({ reveal }) };
    })
    // ── Admin: patch one provider's config ─────────────────────────────────
    .patch(
      "/admin/notifications/providers/:name",
      async ({ params, body, request, set }) => {
        if (!(await isAdmin(request, jwtSecret))) {
          set.status = 401;
          return { error: "Unauthorized", code: 401 };
        }
        if (!isProviderName(params.name)) {
          set.status = 404;
          return { error: `Unknown provider: ${params.name}`, code: 404 };
        }
        // Up-front: if the patch enables FCM, the service_account must already
        // exist (or be in the same patch) AND parse as JSON. Catch this here
        // rather than at first send.
        if (params.name === "fcm" && body.enabled === true) {
          const merged = body.service_account ?? loadProviderConfigs().fcm.service_account;
          if (!merged) {
            set.status = 422;
            return { error: "FCM cannot be enabled without service_account", code: 422 };
          }
          try { JSON.parse(merged); }
          catch (e) {
            set.status = 422;
            return { error: `service_account is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, code: 422 };
          }
        }
        const result = applyPatch(params.name, body);
        if (result.rejected.length > 0) {
          set.status = 422;
          return { error: `Invalid fields for ${params.name}: ${result.rejected.join(", ")}`, code: 422 };
        }
        // First-time enable: bootstrap the system collections so hooks can
        // call helpers.notify() and clients can register devices without the
        // operator hand-building schema.
        let bootstrap: { created: string[]; skipped: string[] } | null = null;
        if (body.enabled === true) {
          try {
            bootstrap = await bootstrapNotificationCollections();
          } catch (e) {
            // Don't fail the PATCH — the operator can still send via OneSignal
            // (no device_tokens needed) or hand-create the collections later.
            // Surface the error so they know.
            const msg = e instanceof Error ? e.message : String(e);
            return { data: describeProviders(), bootstrap_error: msg };
          }
        }
        const out: Record<string, unknown> = { data: describeProviders() };
        if (bootstrap) out["bootstrap"] = bootstrap;
        return out;
      },
      { body: PATCH_BODY, params: t.Object({ name: t.String() }) },
    )
    // ── Admin: test connection (no message sent) ───────────────────────────
    .post(
      "/admin/notifications/providers/:name/test-connection",
      async ({ params, request, set }) => {
        if (!(await isAdmin(request, jwtSecret))) {
          set.status = 401;
          return { error: "Unauthorized", code: 401 };
        }
        if (!isProviderName(params.name)) {
          set.status = 404;
          return { error: `Unknown provider: ${params.name}`, code: 404 };
        }
        const cfg = loadProviderConfigs();
        const result = params.name === "onesignal"
          ? await testOneSignalConnection(cfg.onesignal)
          : await testFcmConnection(cfg.fcm);
        if (!result.ok) {
          set.status = 422;
          return { error: result.detail, code: 422 };
        }
        return { data: { ok: true, detail: result.detail } };
      },
      { params: t.Object({ name: t.String() }) },
    )
    // ── Admin: send a real test notification to a user ─────────────────────
    .post(
      "/admin/notifications/test",
      async ({ body, request, set }) => {
        if (!(await isAdmin(request, jwtSecret))) {
          set.status = 401;
          return { error: "Unauthorized", code: 401 };
        }
        const providers = body.providers
          ?.filter(isProviderName) ?? undefined;
        const payload: NotificationPayload = {
          title: body.title ?? "Vaultbase test",
          body: body.body ?? `Test sent at ${new Date().toISOString()}`,
          data: body.data ?? { _vbtest: true },
        };
        const opts = providers ? { providers } : {};
        const out = await dispatchNotification(body.userId, payload, opts);
        return { data: out };
      },
      {
        body: t.Object({
          userId: t.String(),
          title: t.Optional(t.String()),
          body: t.Optional(t.String()),
          data: t.Optional(t.Record(t.String(), t.Any())),
          providers: t.Optional(t.Array(t.String())),
        }),
      },
    )
    // ── Authenticated user: register a device token ────────────────────────
    .post(
      "/notifications/devices",
      async ({ body, request, set }) => {
        const user = await authedUser(request, jwtSecret);
        if (!user) {
          set.status = 401;
          return { error: "Unauthorized", code: 401 };
        }
        if (body.provider !== "fcm" && body.provider !== "apns") {
          set.status = 422;
          return { error: `provider must be "fcm" or "apns" (OneSignal users don't register here)`, code: 422 };
        }
        if (body.platform !== "ios" && body.platform !== "android" && body.platform !== "web") {
          set.status = 422;
          return { error: `platform must be one of ios, android, web`, code: 422 };
        }
        const client = rawClient();
        const now = Math.floor(Date.now() / 1000);
        try {
          // Upsert by token. The notifications collection bootstrap creates
          // `token` UNIQUE so this conflict resolution works.
          client.prepare(
            `INSERT INTO vb_device_tokens (id, user, provider, token, platform, app_version, enabled, last_seen, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
             ON CONFLICT(token) DO UPDATE SET
               user = excluded.user,
               provider = excluded.provider,
               platform = excluded.platform,
               app_version = excluded.app_version,
               enabled = 1,
               last_seen = excluded.last_seen`,
          ).run(
            crypto.randomUUID(),
            user.id,
            body.provider,
            body.token,
            body.platform,
            body.app_version ?? null,
            now,
            now,
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("no such table")) {
            set.status = 503;
            return { error: "Notifications not enabled (vb_device_tokens missing — admin must enable a token-based provider)", code: 503 };
          }
          throw e;
        }
        return { data: { ok: true } };
      },
      {
        body: t.Object({
          token: t.String({ minLength: 1, maxLength: 4096 }),
          provider: t.String(),
          platform: t.String(),
          app_version: t.Optional(t.String({ maxLength: 64 })),
        }),
      },
    )
    // ── Authenticated user: unregister a device token (logout) ─────────────
    .delete(
      "/notifications/devices/:token",
      async ({ params, request, set }) => {
        const user = await authedUser(request, jwtSecret);
        if (!user) {
          set.status = 401;
          return { error: "Unauthorized", code: 401 };
        }
        const client = rawClient();
        try {
          // Soft delete (enabled=0) — preserves the row so we can analytics-on-it.
          // Restrict to the calling user's own tokens (defense against ID forgery).
          client.prepare(
            `UPDATE vb_device_tokens SET enabled = 0 WHERE token = ? AND user = ?`,
          ).run(params.token, user.id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("no such table")) {
            // Idempotent: nothing to disable, but not an error from the
            // client's POV (they were calling logout-cleanup).
            return { data: { ok: true } };
          }
          throw e;
        }
        return { data: { ok: true } };
      },
      { params: t.Object({ token: t.String() }) },
    );
}

/** Test-only: re-export `getAllSettings` so tests don't need to import it separately. */
export { getAllSettings };
