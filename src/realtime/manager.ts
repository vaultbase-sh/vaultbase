import type { RecordWithMeta } from "../core/records.ts";

export interface WSLike {
  send(data: string): void;
}

export type RealtimeEvent =
  | { type: "connected" }
  | { type: "create"; collection: string; record: RecordWithMeta }
  | { type: "update"; collection: string; record: RecordWithMeta }
  | { type: "delete"; collection: string; id: string };

/** Auth context attached to a WS connection (for future per-record filtering). */
export interface WSAuth {
  id: string;
  type: "user" | "admin";
  email?: string;
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
 * Send to subscribers of `<collection>`, `<collection>/<id>` (when the event has
 * a record id), and the wildcard `*` topic — fans out without dedup-by-ws since
 * subscribing to multiple topics is an explicit caller decision.
 */
export function broadcast(collection: string, event: RealtimeEvent): void {
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
      try {
        ws.send(payload);
      } catch {
        set.delete(ws);
      }
    }
  }
}

export function _reset(): void {
  subs.clear();
}
