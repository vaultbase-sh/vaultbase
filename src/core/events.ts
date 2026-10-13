/**
 * In-process event bus.
 *
 * Core code emits an event when something happens (a record was written, a
 * user signed up) and doesn't know who is listening. Realtime, outbound
 * webhooks and after-hooks are listeners like any other (see
 * `event-listeners.ts`); extensions subscribe with `on()`.
 *
 * Listeners run in registration order, synchronously from `emit()`. A
 * listener that throws, or returns a promise that rejects, is logged and the
 * others still run. Nothing a listener does can fail the write that emitted
 * the event: record events are emitted after the write has committed.
 */
import type { Collection } from "../db/schema.ts";
import type { AuthContext } from "./rules.ts";

/**
 * Where a record write came from.
 *   - "api":     the records API, hooks' and routes' record helpers, batch
 *   - "auth":    a user created by an auth flow (sign-up, invite, guest, OAuth2)
 *   - "cascade": a relation cleared because the record it pointed to was
 *                deleted (bulk; hooks and webhooks skip these)
 */
export type RecordEventSource = "api" | "auth" | "cascade";

type Rec = Record<string, unknown>;

export interface VaultbaseEvents {
  "record.created": { collection: Collection; record: Rec; auth: AuthContext | null; source: RecordEventSource };
  "record.updated": { collection: Collection; record: Rec; existing: Rec | null; auth: AuthContext | null; source: RecordEventSource };
  "record.deleted": { collection: Collection; id: string; existing: Rec; auth: AuthContext | null; source: RecordEventSource };
  "auth.signup": { collection: Collection; record: Rec; method: "password" | "invite" | "anonymous" | "oauth2" };
}

export type VaultbaseEventName = keyof VaultbaseEvents;
export type Listener<E extends VaultbaseEventName> = (payload: VaultbaseEvents[E]) => void | Promise<void>;

interface Entry { name: string; fn: (payload: never) => void | Promise<void> }

const listeners = new Map<VaultbaseEventName, Entry[]>();

/**
 * Listen for an event. `name` labels the listener in error logs. Returns a
 * function that removes it.
 */
export function on<E extends VaultbaseEventName>(event: E, fn: Listener<E>, name = "listener"): () => void {
  const list = listeners.get(event) ?? [];
  const entry: Entry = { name, fn: fn as Entry["fn"] };
  listeners.set(event, [...list, entry]);
  return () => {
    const cur = listeners.get(event);
    if (cur) listeners.set(event, cur.filter((e) => e !== entry));
  };
}

export function emit<E extends VaultbaseEventName>(event: E, payload: VaultbaseEvents[E]): void {
  const list = listeners.get(event);
  if (!list) return;
  for (const { name, fn } of list) {
    const fail = (e: unknown) => console.error(`[events] ${name} failed on ${event}:`, e);
    try {
      const r = (fn as Listener<E>)(payload);
      if (r && typeof (r as Promise<void>).catch === "function") (r as Promise<void>).catch(fail);
    } catch (e) {
      fail(e);
    }
  }
}

/** Number of listeners on an event. For tests and diagnostics. */
export function listenerCount(event: VaultbaseEventName): number {
  return listeners.get(event)?.length ?? 0;
}
