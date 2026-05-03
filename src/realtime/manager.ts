import type { RecordWithMeta } from "../core/records.ts";
import { evaluateRule, type AuthContext } from "../core/rules.ts";

export interface WSLike {
  send(data: string): void;
}

export type RealtimeEvent =
  | { type: "connected" }
  | { type: "create"; collection: string; record: RecordWithMeta }
  | { type: "update"; collection: string; record: RecordWithMeta }
  | { type: "delete"; collection: string; id: string };

/** Auth context attached to a WS connection (used for per-record view_rule filtering at broadcast time). */
export interface WSAuth {
  id: string;
  type: "user" | "admin";
  email?: string;
}

/**
 * Optional context passed by record-mutating callers so broadcast can enforce
 * each subscriber's `view_rule` before fanning out.
 *
 *   - `viewRule = undefined`     → no filtering (back-compat — any caller that
 *                                  doesn't pass this gets the legacy behavior)
 *   - `viewRule = null`          → public — every subscriber gets the event
 *   - `viewRule = ""`            → admin-only — non-admin subscribers skipped
 *   - expression                 → evaluated per-subscriber against `record`
 *
 * For delete events, pass the just-deleted record so the rule still has fields
 * to evaluate against (the row is gone in the DB by the time we broadcast).
 */
export interface BroadcastOpts {
  viewRule?: string | null;
  record?: Record<string, unknown> | null;
}

const WILDCARD = "*";

/**
 * Topic strings:
 *   - "<collection>"          → all events for the collection
 *   - "<collection>/<id>"     → events for one specific record
 *   - "*"                     → every event everywhere
 *
 * Storage is keyed by **connection id** (string), not by `WSLike` object
 * identity. Bun/Elysia can hand you a different wrapper per handler call
 * (one for `open`, another for `message`); using `===` for membership
 * misbehaves — subscribe stored wrapper A, unsubscribe looked up wrapper B,
 * cross-call mutation silently dropped. The id is minted at connect time
 * and stashed in Bun's persistent `ws.data` slot.
 *
 * The inner Map maps connId → adapter so broadcast can still call .send()
 * via the wrapper that's currently live. Whichever wrapper subscribed last
 * "wins" — the most recent send target is what fires.
 */
const subs = new Map<string, Map<string, WSLike>>();
const wsAuth = new Map<string, WSAuth>();

/** Pull the persistent connection id off `ws.data` (set by the WS open handler). */
function connId(ws: WSLike): string {
  const id = (ws as unknown as { data?: { connId?: string } }).data?.connId;
  if (typeof id !== "string") throw new Error("realtime: ws.data.connId missing — open handler must mint one");
  return id;
}

export function setWSAuth(ws: WSLike, auth: WSAuth | null): void {
  const id = connId(ws);
  if (auth) wsAuth.set(id, auth);
  else wsAuth.delete(id);
}

export function getWSAuth(ws: WSLike): WSAuth | undefined {
  return wsAuth.get(connId(ws));
}

/**
 * Canonicalise a topic string. The internal store keys are:
 *
 *   <collection>                 every event for the collection
 *   <collection>/<id>            events for one specific record
 *   <collection>.<event-type>    only that event-type (create / update / delete)
 *   *                            every event everywhere
 *   *.<event-type>               that event-type globally
 *
 * Ergonomic synonyms we collapse:
 *
 *   <collection>.*  → <collection>     (dotted-wildcard)
 *   <collection>/*  → <collection>     (slashed-wildcard)
 *
 * Symmetric — applied by both subscribe + unsubscribe so the two halves
 * always agree on the storage key. Returns `null` on empty input.
 */
const EVENT_KINDS = new Set(["create", "update", "delete"]);

export function normalizeTopic(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t) return null;
  if (t === "*") return "*";
  if (t.endsWith(".*")) return t.slice(0, -2) || null;
  if (t.endsWith("/*")) return t.slice(0, -2) || null;
  // `<base>.<event-type>` — keep verbatim only when the suffix is a
  // known event kind. Anything else stays as-is for legacy callers.
  const dot = t.lastIndexOf(".");
  if (dot > 0) {
    const suffix = t.slice(dot + 1);
    if (EVENT_KINDS.has(suffix)) return t; // canonical event-typed form
  }
  return t;
}

export function subscribe(ws: WSLike, topics: string[]): string[] {
  const id = connId(ws);
  const accepted: string[] = [];
  for (const raw of topics) {
    const t = normalizeTopic(raw);
    if (!t) continue;
    let inner = subs.get(t);
    if (!inner) { inner = new Map(); subs.set(t, inner); }
    inner.set(id, ws);
    accepted.push(t);
  }
  return accepted;
}

export function unsubscribe(ws: WSLike, topics: string[]): string[] {
  const id = connId(ws);
  const removed: string[] = [];
  for (const raw of topics) {
    const t = normalizeTopic(raw);
    if (!t) continue;
    if (subs.get(t)?.delete(id)) removed.push(t);
  }
  return removed;
}

/** Every topic this WS is currently subscribed to. Cheap introspection for debugging. */
export function listSubsFor(ws: WSLike): string[] {
  const id = connId(ws);
  const out: string[] = [];
  for (const [topic, inner] of subs.entries()) {
    if (inner.has(id)) out.push(topic);
  }
  out.sort();
  return out;
}

export function disconnectAll(ws: WSLike): void {
  const id = connId(ws);
  for (const inner of subs.values()) {
    inner.delete(id);
  }
  wsAuth.delete(id);
}

/**
 * Returns true when `ws` should receive this broadcast under the given
 * filtering context. Admin connections always pass. When no `viewRule` is
 * supplied, everyone passes (back-compat). When supplied, behavior matches
 * the records HTTP `view_rule` semantics.
 */
function shouldSendTo(id: string, opts?: BroadcastOpts): boolean {
  if (!opts || opts.viewRule === undefined) return true;
  const auth = wsAuth.get(id);
  if (auth?.type === "admin") return true;
  const rule = opts.viewRule;
  if (rule === null) return true;       // public
  if (rule === "") return false;        // admin only
  const ctx: AuthContext | null = auth
    ? { id: auth.id, type: auth.type, ...(auth.email ? { email: auth.email } : {}) }
    : null;
  return evaluateRule(rule, ctx, opts.record ?? null);
}

/**
 * Send to subscribers of `<collection>`, `<collection>/<id>` (when the event has
 * a record id), and the wildcard `*` topic — fans out with per-id dedup. When
 * the caller passes `opts.viewRule` (and `opts.record` for the eval target),
 * each subscriber's auth is checked against the rule and non-matching connections
 * are skipped silently.
 */
export function broadcast(collection: string, event: RealtimeEvent, opts?: BroadcastOpts): void {
  const targets: (string | undefined)[] = [
    collection,                          // collection-level
    WILDCARD,                            // global
    `${collection}.${event.type}`,       // event-typed per collection
    `${WILDCARD}.${event.type}`,         // event-typed global
  ];
  if (event.type === "create" || event.type === "update") {
    targets.push(`${collection}/${event.record.id}`);
  } else if (event.type === "delete") {
    targets.push(`${collection}/${event.id}`);
  }
  const payload = JSON.stringify(event);
  // Dedup: a connection subscribed to both "posts" and "*" should still receive
  // the event once.
  const sent = new Set<string>();
  for (const topic of targets) {
    if (!topic) continue;
    const inner = subs.get(topic);
    if (!inner) continue;
    for (const [id, ws] of inner) {
      if (sent.has(id)) continue;
      sent.add(id);
      if (!shouldSendTo(id, opts)) continue;
      try {
        ws.send(payload);
      } catch {
        inner.delete(id);
      }
    }
  }
}

/**
 * Fan out an arbitrary system message to subscribers of `topic`. Unlike
 * `broadcast()`, this isn't tied to a record event — used for flag deltas,
 * settings hot-reload notices, and similar admin signals. Topic naming
 * convention: leading double underscore (e.g. `__flags`) so it can't
 * collide with a user-defined collection.
 */
export function broadcastSystem(topic: string, message: object): void {
  const inner = subs.get(topic);
  if (!inner) return;
  const payload = JSON.stringify(message);
  for (const [id, ws] of inner) {
    try { ws.send(payload); }
    catch { inner.delete(id); }
  }
}

// ── SSE client registry ─────────────────────────────────────────────────────
// SSE is one-directional (server → client). Subscriptions can't ride on the
// same stream the way they do over WebSocket, so we mint a `clientId` per SSE
// connection and let clients pair it with `POST /api/v1/realtime` to set their
// topic list. Same `WSLike` interface backs both transports — broadcast logic
// doesn't need to know which one a subscriber is on.

const sseClients = new Map<string, WSLike>();

export function registerSSEClient(clientId: string, adapter: WSLike): void {
  // Mirror the WS contract: every adapter must carry a stable `data.connId`
  // so subscribe / unsubscribe / disconnectAll have a real key. SSE adapters
  // typically don't carry `data`, so we attach it here.
  const a = adapter as unknown as { data?: { connId?: string } };
  if (!a.data || typeof a.data !== "object") a.data = { connId: clientId };
  else if (typeof a.data.connId !== "string") a.data.connId = clientId;
  sseClients.set(clientId, adapter);
}

export function getSSEClient(clientId: string): WSLike | undefined {
  return sseClients.get(clientId);
}

/** Drop the client + remove from every topic + clear stored auth. */
export function unregisterSSEClient(clientId: string): void {
  const adapter = sseClients.get(clientId);
  if (!adapter) return;
  disconnectAll(adapter);
  sseClients.delete(clientId);
}

/** Replace the client's topic list (PocketBase-style: PUT semantics). */
export function setSSESubscriptions(clientId: string, topics: string[]): boolean {
  const adapter = sseClients.get(clientId);
  if (!adapter) return false;
  const id = connId(adapter);
  // Remove from every topic, then re-add the new set.
  for (const inner of subs.values()) inner.delete(id);
  subscribe(adapter, topics);
  return true;
}

export function _reset(): void {
  subs.clear();
  sseClients.clear();
}
