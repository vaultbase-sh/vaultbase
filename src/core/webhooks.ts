/**
 * Outbound webhooks dispatcher.
 *
 * Wired into record CRUD via `dispatchEvent("posts.create", { record })`.
 * Each enabled webhook subscribed to that event gets a row in
 * `vaultbase_webhook_deliveries` (status=pending). A periodic tick claims
 * due deliveries, POSTs them with HMAC-SHA-256 signing, and either marks
 * them succeeded or schedules a retry per the webhook's backoff policy.
 *
 *   - Headers sent on every delivery:
 *       X-Vaultbase-Event:     "posts.create"
 *       X-Vaultbase-Delivery:  "<delivery uuid>"
 *       X-Vaultbase-Timestamp: "<unix-seconds>"
 *       X-Vaultbase-Signature: "sha256=<hex hmac of {timestamp}.{body}>"
 *
 *   - Verifying receiver pseudocode:
 *       const expected = "sha256=" + hmacSha256(secret, ts + "." + rawBody);
 *       if (!constantTimeEqual(expected, header)) reject();
 *       if (Date.now()/1000 - parseInt(ts) > 300) reject();   // replay window
 *
 *   - SSRF: outbound URL is filtered through the same egress CIDR list
 *     that protects helpers.http (RFC1918 / loopback / link-local denied
 *     by default). Override per-server via `hooks.http.deny` setting.
 */
import { and, eq, lte } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { webhooks, webhookDeliveries } from "../db/schema.ts";
import { assertEgressAllowed, EgressBlockedError } from "./hook-egress.ts";

const TICK_INTERVAL_MS = 2000;
const CLAIM_LIMIT = 50;

let tickHandle: ReturnType<typeof setInterval> | null = null;

interface WebhookRow {
  id: string;
  name: string;
  url: string;
  events: string;
  secret: string;
  enabled: number;
  retry_max: number;
  retry_backoff: string;
  retry_delay_ms: number;
  timeout_ms: number;
  custom_headers: string;
}

interface DeliveryRow {
  id: string;
  webhook_id: string;
  event: string;
  payload: string;
  attempt: number;
  status: string;
  scheduled_at: number;
}

export interface DispatchOpts {
  /** Logical event label, e.g. `posts.create` or `users.delete`. Required. */
  event: string;
  /** Free-form data — encoded into delivery body under `data`. */
  data?: unknown;
}

/**
 * Enqueue deliveries for every enabled webhook subscribed to `event`.
 * Subscription matching: a webhook lists patterns in `events`, where each
 * pattern is one of `*`, `<collection>.*`, or the exact event string.
 */
export async function dispatchEvent(opts: DispatchOpts): Promise<{ enqueued: number }> {
  const db = getDb();
  const rows = await db.select().from(webhooks).where(eq(webhooks.enabled, 1)) as WebhookRow[];
  const now = Math.floor(Date.now() / 1000);
  let enqueued = 0;
  for (const w of rows) {
    if (!eventMatches(w.events, opts.event)) continue;
    const id = crypto.randomUUID();
    const payload = JSON.stringify({
      id,
      event: opts.event,
      timestamp: now,
      data: opts.data ?? null,
    });
    await db.insert(webhookDeliveries).values({
      id, webhook_id: w.id, event: opts.event, payload,
      attempt: 1, status: "pending",
      scheduled_at: now, created_at: now,
    });
    enqueued++;
  }
  return { enqueued };
}

function eventMatches(eventsJson: string, event: string): boolean {
  let patterns: string[] = [];
  try {
    const parsed = JSON.parse(eventsJson) as unknown;
    if (Array.isArray(parsed)) patterns = parsed.filter((x): x is string => typeof x === "string");
  } catch { /* empty */ }
  if (patterns.length === 0) return false;
  for (const p of patterns) {
    if (p === "*") return true;
    if (p === event) return true;
    if (p.endsWith(".*") && event.startsWith(p.slice(0, -1))) return true;  // "posts.*" matches "posts.create"
  }
  return false;
}

// ── Dispatcher tick ──────────────────────────────────────────────────────────

export function startWebhookDispatcher(): void {
  if (tickHandle) return;
  tickHandle = setInterval(() => { void tick().catch(() => { /* swallow */ }); }, TICK_INTERVAL_MS);
}

export function stopWebhookDispatcher(): void {
  if (tickHandle) { clearInterval(tickHandle); tickHandle = null; }
}

async function tick(): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const due = await db
    .select()
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.status, "pending"), lte(webhookDeliveries.scheduled_at, now)))
    .limit(CLAIM_LIMIT) as DeliveryRow[];
  for (const d of due) {
    void deliverOne(d);
  }
}

async function deliverOne(d: DeliveryRow): Promise<void> {
  const db = getDb();
  const wRows = await db.select().from(webhooks).where(eq(webhooks.id, d.webhook_id)) as WebhookRow[];
  const w = wRows[0];
  if (!w || w.enabled !== 1) {
    await db.update(webhookDeliveries)
      .set({ status: "dead", error: w ? "webhook disabled" : "webhook deleted", delivered_at: Math.floor(Date.now() / 1000) })
      .where(eq(webhookDeliveries.id, d.id));
    return;
  }

  // Egress filter — same envelope as helpers.http.
  try { await assertEgressAllowed(w.url); }
  catch (e) {
    if (e instanceof EgressBlockedError) {
      await db.update(webhookDeliveries)
        .set({ status: "dead", error: `egress blocked: ${e.message}`, delivered_at: Math.floor(Date.now() / 1000) })
        .where(eq(webhookDeliveries.id, d.id));
      return;
    }
    // Network errors fall through to retry path.
  }

  const ts = String(Math.floor(Date.now() / 1000));
  const sig = await hmacSign(w.secret, `${ts}.${d.payload}`);

  // Reserved-header denylist. Admin-supplied custom_headers cannot override
  // the integrity headers, the SSRF-defining Host, or transport metadata.
  // The match is case-insensitive — header names are normalized below.
  const RESERVED_HEADERS = new Set([
    "host", "content-length", "content-type", "user-agent",
    "x-vaultbase-event", "x-vaultbase-delivery", "x-vaultbase-timestamp", "x-vaultbase-signature",
    "authorization", "cookie", "set-cookie", "transfer-encoding",
  ]);
  let extraHeaders: Record<string, string> = {};
  try {
    const parsed = JSON.parse(w.custom_headers) as unknown;
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v !== "string") continue;
        if (RESERVED_HEADERS.has(k.toLowerCase())) continue;
        extraHeaders[k] = v;
      }
    }
  } catch { /* empty */ }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "vaultbase-webhook",
    "x-vaultbase-event": d.event,
    "x-vaultbase-delivery": d.id,
    "x-vaultbase-timestamp": ts,
    "x-vaultbase-signature": `sha256=${sig}`,
    ...extraHeaders,
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Math.max(1000, w.timeout_ms));
  let res: Response | null = null;
  let err: Error | null = null;
  try {
    // `redirect: "manual"` blocks redirect-following (SSRF defense). The
    // egress filter validated the original URL only; following 3xx into
    // RFC1918 / metadata addresses would bypass the guard. A receiver that
    // legitimately redirects must publish the final URL up front.
    res = await fetch(w.url, {
      method: "POST",
      body: d.payload,
      headers,
      signal: ac.signal,
      redirect: "manual",
    });
  } catch (e) {
    err = e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(timer);
  }

  // Treat 3xx as failure — see redirect: "manual" comment above.
  if (res && res.status >= 300 && res.status < 400) {
    err = new Error(`refusing redirect: ${res.status} -> ${res.headers.get("location") ?? "(no Location)"}`);
    res = null;
  }

  const finishedAt = Math.floor(Date.now() / 1000);
  if (res && res.ok) {
    let body = "";
    try { body = (await res.text()).slice(0, 2048); } catch { /* ignore */ }
    await db.update(webhookDeliveries)
      .set({
        status: "succeeded",
        response_status: res.status,
        response_body: body,
        delivered_at: finishedAt,
      })
      .where(eq(webhookDeliveries.id, d.id));
    return;
  }

  // Failure — retry or mark dead.
  let respBody = "";
  if (res) { try { respBody = (await res.text()).slice(0, 2048); } catch { /* ignore */ } }
  const errorMsg = err ? err.message : `${res?.status ?? "no response"}`;
  if (d.attempt >= w.retry_max) {
    await db.update(webhookDeliveries)
      .set({
        status: "dead",
        response_status: res?.status ?? null,
        response_body: respBody || null,
        error: errorMsg,
        delivered_at: finishedAt,
      })
      .where(eq(webhookDeliveries.id, d.id));
    return;
  }

  // Retry: bump attempt + reschedule. Cap exponential backoff at 1 day so
  // pathological retry_delay_ms × 2^attempt combinations don't park
  // deliveries in the queue for years.
  const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
  const delayMs = w.retry_backoff === "exponential"
    ? Math.min(w.retry_delay_ms * 2 ** (d.attempt - 1), MAX_BACKOFF_MS)
    : w.retry_delay_ms;
  const nextAttempt = d.attempt + 1;
  await db.update(webhookDeliveries)
    .set({
      attempt: nextAttempt,
      status: "pending",
      response_status: res?.status ?? null,
      response_body: respBody || null,
      error: errorMsg,
      scheduled_at: finishedAt + Math.ceil(delayMs / 1000),
    })
    .where(eq(webhookDeliveries.id, d.id));
}

async function hmacSign(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Helper for hooks: dispatch a custom event ───────────────────────────────

export interface WebhookDispatchHelper {
  dispatch(event: string, data?: unknown): Promise<{ enqueued: number }>;
}

export function makeWebhookHelper(): WebhookDispatchHelper {
  return {
    dispatch(event, data) { return dispatchEvent({ event, data }); },
  };
}
