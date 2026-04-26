import type { RecordWithMeta } from "../core/records.ts";

export interface WSLike {
  send(data: string): void;
}

export type RealtimeEvent =
  | { type: "connected" }
  | { type: "create"; collection: string; record: RecordWithMeta }
  | { type: "update"; collection: string; record: RecordWithMeta }
  | { type: "delete"; collection: string; id: string };

const subs = new Map<string, Set<WSLike>>();

export function subscribe(ws: WSLike, collections: string[]): void {
  for (const col of collections) {
    if (!subs.has(col)) subs.set(col, new Set());
    subs.get(col)!.add(ws);
  }
}

export function unsubscribe(ws: WSLike, collections: string[]): void {
  for (const col of collections) {
    subs.get(col)?.delete(ws);
  }
}

export function disconnectAll(ws: WSLike): void {
  for (const set of subs.values()) {
    set.delete(ws);
  }
}

export function broadcast(collection: string, event: RealtimeEvent): void {
  const set = subs.get(collection);
  if (!set) return;
  const payload = JSON.stringify(event);
  for (const ws of set) {
    try {
      ws.send(payload);
    } catch {
      set.delete(ws);
    }
  }
}

export function _reset(): void {
  subs.clear();
}
