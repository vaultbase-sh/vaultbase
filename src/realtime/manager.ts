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
 */
const subs = new Map<string, Set<WSLike>>();
const wsAuth = new WeakMap<WSLike, WSAuth>();

export function setWSAuth(ws: WSLike, auth: WSAuth | null): void {
  if (auth) wsAuth.set(ws, auth);
  else wsAuth.delete(ws);
}

export function getWSAuth(ws: WSLike): WSAuth | undefined {
  return wsAuth.get(ws);
}

export function subscribe(ws: WSLike, topics: string[]): void {
  for (const t of topics) {
    if (!t) continue;
    if (!subs.has(t)) subs.set(t, new Set());
    subs.get(t)!.add(ws);
  }
}

export function unsubscribe(ws: WSLike, topics: string[]): void {
  for (const t of topics) {
    subs.get(t)?.delete(ws);
  }
}

export function disconnectAll(ws: WSLike): void {
  for (const set of subs.values()) {
    set.delete(ws);
  }
  wsAuth.delete(ws);
}

/**
 * Returns true when `ws` should receive this broadcast under the given
 * filtering context. Admin connections always pass. When no `viewRule` is
 * supplied, everyone passes (back-compat). When supplied, behavior matches
 * the records HTTP `view_rule` semantics.
 */
function shouldSendTo(ws: WSLike, opts?: BroadcastOpts): boolean {
  if (!opts || opts.viewRule === undefined) return true;
  const auth = wsAuth.get(ws);
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
 * a record id), and the wildcard `*` topic — fans out with per-ws dedup. When
 * the caller passes `opts.viewRule` (and `opts.record` for the eval target),
 * each subscriber's auth is checked against the rule and non-matching connections
 * are skipped silently.
 */
export function broadcast(collection: string, event: RealtimeEvent, opts?: BroadcastOpts): void {
  const targets: (string | undefined)[] = [collection, WILDCARD];
  if (event.type === "create" || event.type === "update") {
    targets.push(`${collection}/${event.record.id}`);
  } else if (event.type === "delete") {
    targets.push(`${collection}/${event.id}`);
  }
  const payload = JSON.stringify(event);
  // Dedup: a ws subscribed to both "posts" and "*" should still receive the
  // event once. WeakSet doesn't support iteration, so use a regular Set.
  const sent = new Set<WSLike>();
  for (const topic of targets) {
    if (!topic) continue;
    const set = subs.get(topic);
    if (!set) continue;
    for (const ws of set) {
      if (sent.has(ws)) continue;
      sent.add(ws);
      if (!shouldSendTo(ws, opts)) continue;
      try {
        ws.send(payload);
      } catch {
        set.delete(ws);
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
  const set = subs.get(topic);
  if (!set) return;
  const payload = JSON.stringify(message);
  for (const ws of set) {
    try { ws.send(payload); }
    catch { set.delete(ws); }
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
  // Remove from every topic, then re-add the new set.
  for (const set of subs.values()) set.delete(adapter);
  subscribe(adapter, topics);
  return true;
}

export function _reset(): void {
  subs.clear();
  sseClients.clear();
}
