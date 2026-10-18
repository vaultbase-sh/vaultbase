import type { RecordWithMeta } from "../core/records.ts";
import { evaluateRule, type AuthContext } from "../core/rules.ts";
import { sendToPeers } from "../core/peers.ts";

export interface WSLike {
  send(data: string): void;
  /** End the underlying connection (SSE streams). */
  close?(): void;
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
  /** The token it came from, re-verified periodically (revocation, resets). */
  token?: string;
  /** Token expiry (unix seconds): past it the connection is anonymous again. */
  exp?: number;
  /** As on AuthContext, for @request.auth.collectionName / .anonymous / .verified. */
  collection?: string;
  anonymous?: boolean;
  verified?: boolean;
}

/** Topics one connection may hold. */
export const MAX_TOPICS_PER_CONNECTION = 100;
/** Longest topic string accepted (a collection name plus a record id fits easily). */
export const MAX_TOPIC_LENGTH = 200;
/** Open realtime connections from one client address. */
export const MAX_CONNECTIONS_PER_IP = 100;

const connsByIp = new Map<string, number>();
const ipOfConn = new Map<string, string>();
/** Open realtime connections (WS + SSE) per process. */
export const MAX_REALTIME_CONNECTIONS = 10_000;
/**
 * Bytes a WebSocket may have queued and unsent (the client isn't reading, or
 * can't keep up). Past this it is disconnected, as SSE clients are (sse.ts):
 * buffering for it grew the server's memory without bound, and one address
 * may hold MAX_CONNECTIONS_PER_IP sockets.
 */
export const MAX_WS_QUEUED_BYTES = 1024 * 1024;

/** Live connection ids, for the connection cap. */
const liveConns = new Set<string>();

/**
 * Count a new connection in. Returns false when the process is already at
 * `MAX_REALTIME_CONNECTIONS`; the caller refuses the connection.
 */
export function admitConnection(id: string, ip?: string | null): boolean {
  if (liveConns.has(id)) return true;
  if (liveConns.size >= MAX_REALTIME_CONNECTIONS) return false;
  // Per address too: without it one client could fill the global cap and
  // lock everyone else out.
  if (ip) {
    const n = connsByIp.get(ip) ?? 0;
    if (n >= MAX_CONNECTIONS_PER_IP) return false;
    connsByIp.set(ip, n + 1);
    ipOfConn.set(id, ip);
  }
  liveConns.add(id);
  return true;
}

/** Stop counting a connection (it closed or was dropped). */
function releaseConnection(id: string): void {
  if (!liveConns.delete(id)) return;
  const ip = ipOfConn.get(id);
  if (ip === undefined) return;
  ipOfConn.delete(id);
  const n = (connsByIp.get(ip) ?? 1) - 1;
  if (n <= 0) connsByIp.delete(ip);
  else connsByIp.set(ip, n);
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
  /**
   * The collection's list rule. Collection-wide topics (`<collection>`, `*`,
   * `<collection>.<event>`, `*.<event>`) are a live list, so they follow it
   * as well as the view rule; a per-record topic needs only the view rule.
   * Undefined → collection-wide topics follow the view rule alone.
   */
  listRule?: string | null;
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
/** connection id → topics it holds (reverse index of `subs`). */
const topicsByConn = new Map<string, Set<string>>();
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

/** Live auth for `id`: none once the token has expired. */
function currentAuth(id: string): WSAuth | undefined {
  const auth = wsAuth.get(id);
  if (auth?.exp !== undefined && auth.exp <= Math.floor(Date.now() / 1000)) {
    wsAuth.delete(id);
    return undefined;
  }
  return auth;
}

/**
 * Re-check every connection's token (revocation, sign-out, password reset,
 * deleted user). Auth was only checked when it was set, so a connection kept
 * receiving a signed-out user's events for as long as it stayed open. A
 * connection whose token no longer verifies drops back to anonymous and is
 * told so. Run on a timer by the server.
 */
export async function reverifyRealtimeAuth(verify: (token: string) => Promise<WSAuth | null>): Promise<void> {
  for (const [id, auth] of [...wsAuth]) {
    if (!auth.token) continue;
    const fresh = await verify(auth.token);
    if (wsAuth.get(id) !== auth) continue; // changed while we awaited
    if (fresh && fresh.id === auth.id && fresh.type === auth.type) {
      // Same principal: take the refreshed flags (an account that lost
      // email verification stops passing `@request.auth.verified = true`).
      wsAuth.set(id, fresh);
      continue;
    }
    wsAuth.delete(id);
    const ws = connAdapter(id);
    try { ws?.send(JSON.stringify({ type: "auth_expired" })); } catch { /* gone */ }
  }
}

/** Any adapter currently registered for `id`. */
function connAdapter(id: string): WSLike | undefined {
  const sse = sseClients.get(id);
  if (sse) return sse;
  for (const t of topicsByConn.get(id) ?? []) {
    const ws = subs.get(t)?.get(id);
    if (ws) return ws;
  }
  return undefined;
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
  if (!t || t.length > MAX_TOPIC_LENGTH) return null;
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
    // Every topic is a map entry held for the life of the connection.
    const held = topicsByConn.get(id);
    if ((held?.size ?? 0) >= MAX_TOPICS_PER_CONNECTION && !held?.has(t)) break;
    let inner = subs.get(t);
    if (!inner) { inner = new Map(); subs.set(t, inner); }
    inner.set(id, ws);
    let own = topicsByConn.get(id);
    if (!own) { own = new Set(); topicsByConn.set(id, own); }
    own.add(t);
    accepted.push(t);
  }
  return accepted;
}

/** Remove one connection from one topic; drop the topic once nobody listens. */
function leaveTopic(id: string, topic: string): boolean {
  const inner = subs.get(topic);
  const removed = inner?.delete(id) ?? false;
  if (inner && inner.size === 0) subs.delete(topic);
  const own = topicsByConn.get(id);
  if (own) {
    own.delete(topic);
    if (own.size === 0) topicsByConn.delete(id);
  }
  return removed;
}

export function unsubscribe(ws: WSLike, topics: string[]): string[] {
  const id = connId(ws);
  const removed: string[] = [];
  for (const raw of topics) {
    const t = normalizeTopic(raw);
    if (!t) continue;
    if (leaveTopic(id, t)) removed.push(t);
  }
  return removed;
}

/** Every topic this WS is currently subscribed to. Cheap introspection for debugging. */
export function listSubsFor(ws: WSLike): string[] {
  return [...(topicsByConn.get(connId(ws)) ?? [])].sort();
}

/** Leave every topic this connection holds (only its own, not all topics). */
/** Bytes queued on a WebSocket and not yet sent; 0 when unknown (SSE adapters, test doubles). */
function queuedBytes(ws: WSLike): number {
  const w = ws as { getBufferedAmount?: () => number; raw?: { getBufferedAmount?: () => number } };
  try { return w.raw?.getBufferedAmount?.() ?? w.getBufferedAmount?.() ?? 0; } catch { return 0; }
}

/**
 * Cut a connection off right away. A client that stopped reading never reads
 * a close frame either, so a polite close would keep its buffer until TCP
 * gives up; `terminate` frees it now. The close handler then cleans up.
 */
function dropSlow(ws: WSLike): void {
  const w = ws as { terminate?: () => void; raw?: { terminate?: () => void } };
  try {
    if (w.raw?.terminate) w.raw.terminate();
    else if (w.terminate) w.terminate();
    else ws.close?.();
  } catch { /* already gone */ }
}

/** Send, unless the connection is too far behind: then drop it. False when it should leave its topics. */
function deliver(ws: WSLike, payload: string): boolean {
  if (queuedBytes(ws) > MAX_WS_QUEUED_BYTES) {
    dropSlow(ws);
    return false;
  }
  ws.send(payload);
  return true;
}

function leaveAll(id: string): void {
  for (const t of [...(topicsByConn.get(id) ?? [])]) leaveTopic(id, t);
}

export function disconnectAll(ws: WSLike): void {
  const id = connId(ws);
  leaveAll(id);
  wsAuth.delete(id);
  releaseConnection(id);
}

/** Test hook: number of live topics. */
/** Live realtime connections (WebSocket + SSE) on this process. */
export function connectionCount(): number {
  return liveConns.size;
}

export function _topicCount(): number {
  return subs.size;
}

/**
 * Returns true when `ws` should receive this broadcast under the given
 * filtering context. Admin connections always pass. When no `viewRule` is
 * supplied, everyone passes (back-compat). When supplied, behavior matches
 * the records HTTP `view_rule` semantics.
 */
function shouldSendTo(id: string, opts: BroadcastOpts | undefined, collectionWide: boolean): boolean {
  if (!opts || opts.viewRule === undefined) return true;
  const auth = currentAuth(id);
  if (auth?.type === "admin") return true;
  // Everything rules can see, not just id/type/email: without collection /
  // anonymous / verified, a rule excluding guests or another auth collection
  // passed over realtime while HTTP refused.
  const ctx: AuthContext | null = auth
    ? {
        id: auth.id, type: auth.type,
        ...(auth.email ? { email: auth.email } : {}),
        ...(auth.collection ? { collection: auth.collection } : {}),
        ...(auth.anonymous ? { anonymous: true } : {}),
        ...(auth.verified ? { verified: true } : {}),
      }
    : null;
  const passes = (rule: string | null) =>
    rule === null ? true : rule === "" ? false : evaluateRule(rule, ctx, opts.record ?? null);
  if (!passes(opts.viewRule)) return false;
  return collectionWide && opts.listRule !== undefined ? passes(opts.listRule) : true;
}

/**
 * Send to subscribers of `<collection>`, `<collection>/<id>` (when the event has
 * a record id), and the wildcard `*` topic — fans out with per-id dedup. When
 * the caller passes `opts.viewRule` (and `opts.record` for the eval target),
 * each subscriber's auth is checked against the rule and non-matching connections
 * are skipped silently.
 */
export function broadcast(collection: string, event: RealtimeEvent, opts?: BroadcastOpts): void {
  // Per-record topic first, so a connection subscribed both ways is judged
  // by the view rule alone (it asked for this record by id).
  const targets: (string | undefined)[] = [];
  if (event.type === "create" || event.type === "update") {
    targets.push(`${collection}/${event.record.id}`);
  } else if (event.type === "delete") {
    targets.push(`${collection}/${event.id}`);
  }
  const perRecord = targets.length;
  targets.push(
    collection,                          // collection-level
    WILDCARD,                            // global
    `${collection}.${event.type}`,       // event-typed per collection
    `${WILDCARD}.${event.type}`,         // event-typed global
  );
  const payload = JSON.stringify(event);
  // Dedup: a connection subscribed to both "posts" and "*" should still receive
  // the event once.
  const sent = new Set<string>();
  const dead: string[] = [];
  for (const [i, topic] of targets.entries()) {
    if (!topic) continue;
    const inner = subs.get(topic);
    if (!inner) continue;
    for (const [id, ws] of inner) {
      if (sent.has(id)) continue;
      if (!shouldSendTo(id, opts, i >= perRecord)) continue;
      sent.add(id);
      try {
        if (!deliver(ws, payload)) dead.push(id);
      } catch {
        dead.push(id);
      }
    }
  }
  // A socket that can't be written to is gone: drop it from every topic.
  for (const id of dead) leaveAll(id);
}

/**
 * Fan out an arbitrary system message to subscribers of `topic`. Unlike
 * `broadcast()`, this isn't tied to a record event — used for flag deltas,
 * settings hot-reload notices, and similar admin signals. Topic naming
 * convention: leading double underscore (e.g. `__flags`) so it can't
 * collide with a user-defined collection.
 */
export function broadcastSystem(topic: string, message: object): void {
  sendToPeers({ k: "sys", topic, message });
  const inner = subs.get(topic);
  if (!inner) return;
  const payload = JSON.stringify(message);
  const dead: string[] = [];
  for (const [id, ws] of inner) {
    try { if (!deliver(ws, payload)) dead.push(id); }
    catch { dead.push(id); }
  }
  for (const id of dead) leaveAll(id);
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

/**
 * The principal (`type:id`) that first authenticated an SSE client. Once set,
 * changing that client's subscriptions or closing it takes a token for the
 * same principal: the clientId alone travels in URLs and logs.
 */
const sseOwners = new Map<string, string>();

export function sseOwnerOf(clientId: string): string | undefined {
  return sseOwners.get(clientId);
}

export function setSSEOwner(clientId: string, owner: string): void {
  if (!sseOwners.has(clientId)) sseOwners.set(clientId, owner);
}

/** Drop the client + remove from every topic + clear stored auth. */
export function unregisterSSEClient(clientId: string): void {
  const adapter = sseClients.get(clientId);
  if (!adapter) return;
  disconnectAll(adapter);
  sseClients.delete(clientId);
  sseOwners.delete(clientId);
  // Close the stream too: unregistering only stopped counting it, leaving
  // the connection open and uncounted.
  try { adapter.close?.(); } catch { /* already closed */ }
}

/** Replace the client's topic list (PocketBase-style: PUT semantics). */
export function setSSESubscriptions(clientId: string, topics: string[]): boolean {
  const adapter = sseClients.get(clientId);
  if (!adapter) return false;
  const id = connId(adapter);
  // Leave its current topics, then add the new set.
  leaveAll(id);
  subscribe(adapter, topics);
  return true;
}

export function _reset(): void {
  subs.clear();
  topicsByConn.clear();
  sseClients.clear();
  sseOwners.clear();
  liveConns.clear();
  connsByIp.clear();
  ipOfConn.clear();
  wsAuth.clear();
}
