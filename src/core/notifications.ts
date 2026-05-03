/**
 * Multi-provider push-notification dispatch layer.
 *
 * Operators enable any combination of providers (OneSignal, FCM today; APNs
 * direct + web-push as future drivers) via Settings → Notifications. The
 * trigger code is provider-agnostic: `helpers.notify(userId, payload)` fans
 * out to every enabled provider via the queue, one job per provider so a
 * single provider's outage can't block the others.
 *
 * Provider-specific shapes:
 *   - OneSignal: external_id-based, server-side fan-out across the user's
 *     devices. Vaultbase never sees device tokens — the OneSignal client SDK
 *     calls `OneSignal.login(vaultbaseUserId)` to bind external_id once.
 *   - FCM: per-token sends. Vaultbase stores raw FCM registration tokens in
 *     `vb_device_tokens` and POSTs once per device. Auth is OAuth2 bearer
 *     minted from a service-account.json (RS256 JWT exchange, ~55min cache).
 *
 * Both drivers detect token-level "delete this" errors (UNREGISTERED for FCM,
 * recipients=0 hint for OneSignal misconfiguration) and signal them so the
 * worker can disable dead tokens / log misconfigurations.
 */
import * as jose from "jose";
import { getAllSettings } from "../api/settings.ts";
import { enqueue, registerBuiltinWorker, type JobContext } from "./queues.ts";

// ── Shapes ──────────────────────────────────────────────────────────────────

export type ProviderName = "onesignal" | "fcm";
export const PROVIDER_NAMES: ProviderName[] = ["onesignal", "fcm"];
export const NOTIFY_QUEUE = "_notify";

export interface NotificationPayload {
  title: string;
  body: string;
  /** Free-form key/value bag carried alongside the notification (deep-link, etc.). */
  data?: Record<string, unknown>;
}

export interface OneSignalConfig {
  enabled: boolean;
  app_id: string;
  api_key: string;
}

export interface FcmConfig {
  enabled: boolean;
  /** Raw service-account.json string. Parsed at send time, not at config load. */
  service_account: string;
  /** Optional override; if blank we read project_id from the service account JSON. */
  project_id: string;
}

export interface ProviderConfigs {
  onesignal: OneSignalConfig;
  fcm: FcmConfig;
}

export interface SendResult {
  provider: ProviderName;
  /** True for HTTP 2xx. False is treated as "transient" — the worker will rethrow to retry. */
  ok: boolean;
  /** Provider-side delivery count (OneSignal `recipients`, or # FCM tokens that succeeded). */
  delivered: number;
  /** Tokens the worker should mark `enabled = 0` (FCM only; OneSignal manages this internally). */
  invalidTokens: string[];
  /** Human-readable summary written to the job log. */
  message: string;
}

// ── Settings I/O ────────────────────────────────────────────────────────────

const SETTING = {
  onesignalEnabled: "notifications.providers.onesignal.enabled",
  onesignalAppId: "notifications.providers.onesignal.app_id",
  onesignalApiKey: "notifications.providers.onesignal.api_key",
  fcmEnabled: "notifications.providers.fcm.enabled",
  fcmProjectId: "notifications.providers.fcm.project_id",
  fcmServiceAccount: "notifications.providers.fcm.service_account",
} as const;

function isTruthySetting(v: string | undefined): boolean {
  return v === "1" || v === "true";
}

export function loadProviderConfigs(): ProviderConfigs {
  const all = getAllSettings();
  return {
    onesignal: {
      enabled: isTruthySetting(all[SETTING.onesignalEnabled]),
      app_id: all[SETTING.onesignalAppId] ?? "",
      api_key: all[SETTING.onesignalApiKey] ?? "",
    },
    fcm: {
      enabled: isTruthySetting(all[SETTING.fcmEnabled]),
      project_id: all[SETTING.fcmProjectId] ?? "",
      service_account: all[SETTING.fcmServiceAccount] ?? "",
    },
  };
}

export function getEnabledProviders(): ProviderName[] {
  const cfg = loadProviderConfigs();
  const out: ProviderName[] = [];
  if (cfg.onesignal.enabled && cfg.onesignal.app_id && cfg.onesignal.api_key) out.push("onesignal");
  if (cfg.fcm.enabled && cfg.fcm.service_account) out.push("fcm");
  return out;
}

// ── OneSignal driver ────────────────────────────────────────────────────────

const ONESIGNAL_URL = "https://api.onesignal.com/notifications";

export async function sendOneSignal(
  config: OneSignalConfig,
  externalId: string,
  payload: NotificationPayload,
): Promise<SendResult> {
  if (!config.app_id || !config.api_key) {
    return { provider: "onesignal", ok: false, delivered: 0, invalidTokens: [], message: "OneSignal not configured" };
  }

  const body = {
    app_id: config.app_id,
    target_channel: "push",
    include_aliases: { external_id: [externalId] },
    headings: { en: payload.title },
    contents: { en: payload.body },
    data: payload.data ?? {},
  };

  const res = await fetch(ONESIGNAL_URL, {
    method: "POST",
    headers: {
      // OneSignal's auth scheme is the literal word "Basic" + the raw REST API
      // key (NOT RFC 7617 base64-encoded user:pass). Their docs are explicit.
      Authorization: `Basic ${config.api_key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: { id?: string; recipients?: number; errors?: unknown } = {};
  try { parsed = JSON.parse(text); } catch { /* leave empty */ }

  // Permanent client errors (bad app_id, bad api_key, malformed body) — don't retry.
  if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
    return {
      provider: "onesignal",
      ok: true,        // "ok" here means "don't retry" (we've made our decision)
      delivered: 0,
      invalidTokens: [],
      message: `OneSignal ${res.status}: ${text.slice(0, 200)}`,
    };
  }

  if (!res.ok) {
    // Transient: 5xx, 429, network. Throw via ok=false so the queue retries.
    return {
      provider: "onesignal",
      ok: false,
      delivered: 0,
      invalidTokens: [],
      message: `OneSignal transient ${res.status}: ${text.slice(0, 200)}`,
    };
  }

  const recipients = typeof parsed.recipients === "number" ? parsed.recipients : 0;
  const note = recipients === 0
    ? ` (warning: recipients=0 — client likely missed OneSignal.login("${externalId}"))`
    : "";
  return {
    provider: "onesignal",
    ok: true,
    delivered: recipients,
    invalidTokens: [],
    message: `OneSignal ok id=${parsed.id ?? "?"} recipients=${recipients}${note}`,
  };
}

// ── FCM driver ──────────────────────────────────────────────────────────────

interface ServiceAccount {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  token_uri?: string;
}

interface CachedAccessToken {
  token: string;
  expiresAt: number; // unix seconds
}

const fcmAccessTokenCache = new Map<string, CachedAccessToken>(); // client_email → token

export function _resetFcmTokenCache(): void {
  fcmAccessTokenCache.clear();
}

function parseServiceAccount(raw: string): ServiceAccount {
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(raw) as ServiceAccount;
  } catch (e) {
    throw new Error(`Invalid FCM service account JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!sa.client_email || !sa.private_key || !sa.project_id) {
    throw new Error("FCM service account JSON missing client_email / private_key / project_id");
  }
  return sa;
}

async function getFcmAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const cached = fcmAccessTokenCache.get(sa.client_email);
  // Refresh if within 5 min of expiry — gives plenty of headroom for slow ticks.
  if (cached && cached.expiresAt > now + 300) return cached.token;

  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const privateKey = await jose.importPKCS8(sa.private_key, "RS256");
  const assertion = await new jose.SignJWT({
    scope: "https://www.googleapis.com/auth/firebase.messaging",
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(sa.client_email)
    .setAudience(tokenUri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(privateKey);

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`FCM OAuth token mint failed (${res.status}): ${text.slice(0, 300)}`);
  const json = JSON.parse(text) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error(`FCM OAuth response missing access_token: ${text.slice(0, 200)}`);
  const token = json.access_token;
  const ttl = typeof json.expires_in === "number" ? json.expires_in : 3600;
  fcmAccessTokenCache.set(sa.client_email, { token, expiresAt: now + ttl });
  return token;
}

/** FCM v1 `data` payload values must all be strings. */
function stringifyData(data: Record<string, unknown> | undefined): Record<string, string> {
  if (!data) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

export interface FcmDeviceToken {
  /** Caller-supplied row id (e.g. vb_device_tokens.id) — echoed back so the worker can disable rows. */
  id: string;
  token: string;
}

export async function sendFcm(
  config: FcmConfig,
  tokens: FcmDeviceToken[],
  payload: NotificationPayload,
): Promise<SendResult> {
  if (tokens.length === 0) {
    return { provider: "fcm", ok: true, delivered: 0, invalidTokens: [], message: "FCM no devices for user" };
  }
  if (!config.service_account) {
    return { provider: "fcm", ok: false, delivered: 0, invalidTokens: [], message: "FCM not configured" };
  }

  const sa = parseServiceAccount(config.service_account);
  const projectId = config.project_id || sa.project_id;
  const accessToken = await getFcmAccessToken(sa);
  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

  // FCM v1 has no batch endpoint; parallel per-token is the standard pattern.
  const results = await Promise.allSettled(tokens.map(async (t) => {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        message: {
          token: t.token,
          notification: { title: payload.title, body: payload.body },
          data: stringifyData(payload.data),
        },
      }),
    });
    const body = await res.text();
    let parsed: { error?: { status?: string; details?: Array<{ errorCode?: string }> } } = {};
    try { parsed = JSON.parse(body); } catch { /* leave empty */ }
    const code = parsed.error?.details?.[0]?.errorCode ?? parsed.error?.status ?? null;
    return { id: t.id, token: t.token, status: res.status, ok: res.ok, code, body };
  }));

  let delivered = 0;
  let transient = 0;
  const invalidTokens: string[] = [];
  const summaries: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.status === "rejected") {
      transient++;
      summaries.push(`token[${i}] network error: ${String(r.reason).slice(0, 80)}`);
      continue;
    }
    const v = r.value;
    if (v.ok) { delivered++; continue; }
    // Permanent token-level errors — disable in caller's table.
    if (v.code === "UNREGISTERED" || v.code === "INVALID_ARGUMENT" || v.code === "SENDER_ID_MISMATCH" || v.code === "NOT_FOUND") {
      invalidTokens.push(v.id);
      summaries.push(`token[${i}] ${v.code} → marked dead`);
      continue;
    }
    // 5xx / 429 → transient.
    if (v.status >= 500 || v.status === 429) {
      transient++;
      summaries.push(`token[${i}] transient ${v.status}`);
      continue;
    }
    // Other 4xx — log + drop, don't retry. Most likely a malformed payload that
    // wouldn't succeed on retry anyway.
    summaries.push(`token[${i}] permanent ${v.status} ${v.code ?? ""}: ${v.body.slice(0, 80)}`);
  }

  const ok = transient === 0;
  return {
    provider: "fcm",
    ok,
    delivered,
    invalidTokens,
    message: `FCM tokens=${tokens.length} delivered=${delivered} transient=${transient} dead=${invalidTokens.length}` +
      (summaries.length ? ` :: ${summaries.slice(0, 5).join("; ")}` : ""),
  };
}

// ── Worker payload + dispatcher ─────────────────────────────────────────────

export interface NotifyJobPayload {
  provider: ProviderName;
  userId: string;
  payload: NotificationPayload;
}

/**
 * Built-in `_notify` queue worker. Reads provider config from settings (so
 * mid-flight credential edits take effect on the next job, not stale ones),
 * routes to the matching driver, marks dead device_tokens on hard failures,
 * throws on transient failures so the queue retries with backoff.
 */
async function notifyWorker(ctx: JobContext): Promise<void> {
  const job = ctx.payload as NotifyJobPayload;
  if (!job || typeof job !== "object" || !job.provider || !job.userId) {
    ctx.helpers.log("notify: malformed payload, skipping", { payload: ctx.payload });
    return;
  }

  const cfg = loadProviderConfigs();
  let result: SendResult;

  if (job.provider === "onesignal") {
    if (!cfg.onesignal.enabled) {
      ctx.helpers.log("notify: onesignal disabled mid-flight, dropping job");
      return;
    }
    result = await sendOneSignal(cfg.onesignal, job.userId, job.payload);
  } else if (job.provider === "fcm") {
    if (!cfg.fcm.enabled) {
      ctx.helpers.log("notify: fcm disabled mid-flight, dropping job");
      return;
    }
    // Tokens come from vb_device_tokens. Lazy-import to avoid circular deps
    // when the collection doesn't exist yet (notifications not bootstrapped).
    let tokens: FcmDeviceToken[] = [];
    try {
      tokens = ctx.helpers.db.query<{ id: string; token: string }>(
        `SELECT id, token FROM vb_device_tokens
         WHERE user = ? AND provider = 'fcm' AND enabled = 1`,
        job.userId,
      );
    } catch (e) {
      // Table not yet bootstrapped → no devices to send to. Not an error.
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("no such table")) throw e;
    }
    result = await sendFcm(cfg.fcm, tokens, job.payload);
    for (const id of result.invalidTokens) {
      try {
        ctx.helpers.db.exec(`UPDATE vb_device_tokens SET enabled = 0 WHERE id = ?`, id);
      } catch { /* table may be gone — ignore */ }
    }
  } else {
    ctx.helpers.log(`notify: unknown provider "${(job as { provider?: string }).provider}"`);
    return;
  }

  ctx.helpers.log(result.message);
  if (!result.ok) {
    // Throwing routes to the queue's retry/backoff/dead-letter machinery.
    throw new Error(result.message);
  }
}

let workerRegistered = false;
export function registerNotificationsWorker(): void {
  if (workerRegistered) return;
  registerBuiltinWorker({
    queue: NOTIFY_QUEUE,
    name: "notifications",
    concurrency: 4,
    retry_max: 5,
    retry_backoff: "exponential",
    retry_delay_ms: 2000,
    fn: notifyWorker,
  });
  workerRegistered = true;
}

// ── Trigger surface ─────────────────────────────────────────────────────────

export interface NotifyOpts {
  /** Restrict to a subset of enabled providers. Default: all enabled. */
  providers?: ProviderName[];
  /** Insert a row into `vb_notifications` for the in-app inbox. Default true. */
  inbox?: boolean;
  /** Enqueue push fan-out across enabled providers. Default true. */
  push?: boolean;
}

export interface DispatchResult {
  inboxRowId: string | null;
  enqueued: Array<{ provider: ProviderName; jobId: string; deduped: boolean }>;
}

/**
 * Trigger a notification for one user. Used directly by `helpers.notify`,
 * also callable from custom routes / cron jobs / integration tests.
 *
 * Behaviour:
 *  1. Insert one row in `vb_notifications` (drives in-app inbox + realtime
 *     broadcast). Skipped when `opts.inbox === false` or the table doesn't
 *     exist (notifications not bootstrapped) — in the latter case dispatch
 *     still enqueues push so the operator can wire push without the inbox.
 *  2. Enqueue one `_notify` job per matching enabled provider.
 */
export async function dispatchNotification(
  userId: string,
  payload: NotificationPayload,
  opts: NotifyOpts = {},
): Promise<DispatchResult> {
  const inbox = opts.inbox !== false;
  const push = opts.push !== false;
  const providers = (opts.providers ?? getEnabledProviders())
    .filter((p): p is ProviderName => PROVIDER_NAMES.includes(p));

  const out: DispatchResult = { inboxRowId: null, enqueued: [] };

  if (inbox) {
    try {
      const { getDb } = await import("../db/client.ts");
      const client = (getDb() as unknown as { $client: import("bun:sqlite").Database }).$client;
      const id = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      client
        .prepare(
          `INSERT INTO vb_notifications (id, user, type, title, body, data, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          userId,
          (payload.data && typeof (payload.data as Record<string, unknown>)["type"] === "string")
            ? String((payload.data as Record<string, unknown>)["type"])
            : "",
          payload.title,
          payload.body,
          JSON.stringify(payload.data ?? {}),
          now,
        );
      out.inboxRowId = id;
    } catch (e) {
      // vb_notifications doesn't exist yet — caller hasn't enabled notifications
      // bootstrap. Push still works without the inbox; just skip silently.
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes("no such table")) throw e;
    }
  }

  if (push) {
    for (const provider of providers) {
      const job = await enqueue(NOTIFY_QUEUE, { provider, userId, payload } satisfies NotifyJobPayload);
      out.enqueued.push({ provider, jobId: job.jobId, deduped: job.deduped });
    }
  }

  return out;
}

// ── Auto-bootstrap collections ──────────────────────────────────────────────

/**
 * Idempotently create the `notifications` and `device_tokens` system
 * collections needed by the trigger surface. Called once from the admin
 * PATCH-provider endpoint when an operator first toggles any provider on,
 * so they don't have to hand-build collections in the admin UI before
 * notifications work.
 *
 * Re-callable: skips collections that already exist. Logs created/skipped
 * so the admin endpoint can surface what changed in its response.
 */
export async function bootstrapNotificationCollections(): Promise<{
  created: string[];
  skipped: string[];
}> {
  const { getCollection, createCollection } = await import("./collections.ts");
  const created: string[] = [];
  const skipped: string[] = [];

  if (!(await getCollection("notifications"))) {
    await createCollection({
      name: "notifications",
      type: "base",
      fields: JSON.stringify([
        // Owner — cascade so deleting the user wipes their inbox.
        { name: "user", type: "relation", collection: "users", options: { cascade: "cascade" } },
        // Caller-supplied taxonomy ("comment.reply", "system.welcome", etc.).
        { name: "type", type: "text" },
        { name: "title", type: "text", required: true },
        { name: "body", type: "text" },
        // Free-form payload (deep-link target, related ids, etc.).
        { name: "data", type: "json" },
        // Mark-as-read timestamp; null = unread.
        { name: "read_at", type: "date" },
      ]),
      // Owner-scoped: every user sees only their own notifications.
      // Update is allowed so clients can mark-as-read.
      list_rule: "user = @request.auth.id",
      view_rule: "user = @request.auth.id",
      create_rule: "",                          // admin-only direct create (server uses raw SQL)
      update_rule: "user = @request.auth.id",
      delete_rule: "user = @request.auth.id",
    });
    created.push("notifications");
  } else {
    skipped.push("notifications");
  }

  if (!(await getCollection("device_tokens"))) {
    await createCollection({
      name: "device_tokens",
      type: "base",
      fields: JSON.stringify([
        { name: "user", type: "relation", collection: "users", options: { cascade: "cascade" } },
        // Provider that minted this token. OneSignal devices never appear here.
        { name: "provider", type: "select", options: { values: ["fcm", "apns"] } },
        // Raw FCM/APNs registration token. Unique — re-registering rebinds.
        { name: "token", type: "text", required: true, options: { unique: true } },
        { name: "platform", type: "select", options: { values: ["ios", "android", "web"] } },
        { name: "app_version", type: "text" },
        { name: "enabled", type: "bool" },
        { name: "last_seen", type: "date" },
      ]),
      // Admin-only via REST; users hit /api/v1/notifications/devices instead,
      // which writes directly via raw SQL with caller-id checks.
      list_rule: "",
      view_rule: "",
      create_rule: "",
      update_rule: "",
      delete_rule: "",
    });
    created.push("device_tokens");
  } else {
    skipped.push("device_tokens");
  }

  return { created, skipped };
}

// ── Connection-test helpers (admin UI "Test connection" buttons) ────────────

export interface ConnectionTestResult {
  ok: boolean;
  detail: string;
}

export async function testOneSignalConnection(config: OneSignalConfig): Promise<ConnectionTestResult> {
  if (!config.app_id || !config.api_key) {
    return { ok: false, detail: "App ID and REST API Key required" };
  }
  // Cheap read-only probe: GET /apps/<id> returns app metadata if the key is valid.
  const res = await fetch(`https://api.onesignal.com/apps/${encodeURIComponent(config.app_id)}`, {
    method: "GET",
    headers: { Authorization: `Basic ${config.api_key}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (res.ok) return { ok: true, detail: `OneSignal ✓ ${text.slice(0, 100)}` };
  return { ok: false, detail: `OneSignal ${res.status}: ${text.slice(0, 200)}` };
}

export async function testFcmConnection(config: FcmConfig): Promise<ConnectionTestResult> {
  if (!config.service_account) return { ok: false, detail: "Service account JSON required" };
  let sa: ServiceAccount;
  try { sa = parseServiceAccount(config.service_account); }
  catch (e) { return { ok: false, detail: e instanceof Error ? e.message : String(e) }; }
  try {
    // Mint a token — proves the JSON parses, the private key is RS256-valid,
    // and Google accepts our service account. Doesn't send any messages.
    const token = await getFcmAccessToken(sa);
    return {
      ok: true,
      detail: `FCM ✓ project=${config.project_id || sa.project_id} sa=${sa.client_email} token_prefix=${token.slice(0, 12)}…`,
    };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}
