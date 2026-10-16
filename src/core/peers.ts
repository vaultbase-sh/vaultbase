/**
 * Servers sharing one Postgres database tell each other what changed.
 *
 * Every server keeps caches of what the database says: collections and
 * their rules, settings, hooks, routes, jobs, workers, webhooks, flags,
 * list totals, parsed vectors. A change made through one server used to
 * reach the others only on restart (a rule tightened on one kept serving
 * the old rows on the next), and realtime subscribers only heard about
 * writes made through the server they were connected to.
 *
 * Changes go out over LISTEN/NOTIFY on one channel per schema. A message
 * sent inside a transaction is delivered at COMMIT, and never after a
 * rollback; the rest are batched for {@link FLUSH_MS} so a burst of writes
 * costs one NOTIFY, not one each. A server ignores its own messages. What a
 * server does on a peer's message (drop a cache, re-read a setting, replay a
 * realtime event to its own subscribers) never announces anything itself:
 * the relay context travels with it (AsyncLocalStorage), so two servers
 * can't ping-pong. If the listening connection drops, a message may have
 * been missed, so on reconnect everything resettable is reset.
 *
 * Modules register what a kind of message does with {@link onPeerMessage};
 * this one stays free of their imports.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** One change. `k` names it; the rest is what its handler needs. */
export interface PeerMessage { k: string; [field: string]: unknown }

interface PeerDriver {
  name: string;
  readonly inTransaction: boolean;
  notify(channel: string, payload: string): Promise<unknown>;
  listen(channel: string, onNotify: (payload: string) => void, onListen: () => void): Promise<{ unlisten(): Promise<void> }>;
  get<T>(sql: string): Promise<T | null>;
}

/** NOTIFY payloads are capped at 8000 bytes; keep clear of it. */
const MAX_PAYLOAD = 7_500;
const FLUSH_MS = 20;

const self = crypto.randomUUID();
const handlers = new Map<string, (m: PeerMessage) => void | Promise<void>>();
/** Kinds whose handler, run with no data, drops everything it covers. */
const resettable = new Set<string>();
const relaying = new AsyncLocalStorage<true>();

let driver: PeerDriver | null = null;
let channel: string | null = null;
let subscription: { unlisten(): Promise<void> } | null = null;
let outbox: PeerMessage[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let inbound: Promise<void> = Promise.resolve();

/**
 * Register what a peer's message of kind `k` does here. `reset`: the kind
 * is also run, with no data, after a reconnect.
 */
export function onPeerMessage(k: string, fn: (m: PeerMessage) => void | Promise<void>, opts?: { reset?: boolean }): void {
  handlers.set(k, fn);
  if (opts?.reset) resettable.add(k);
}

/** Whether peers are connected (a Postgres server that called startPeers). */
export function peersActive(): boolean {
  return channel !== null;
}

/** Tell the other servers. A no-op without peers, and while handling a peer's message. */
export function sendToPeers(m: PeerMessage): void {
  if (!driver || !channel || relaying.getStore()) return;
  if (driver.inTransaction) {
    // On this transaction's connection: delivered at COMMIT, dropped on rollback.
    const payload = encode([m]);
    if (payload) driver.notify(channel, payload).catch(warn);
    return;
  }
  outbox.push(m);
  flushTimer ??= setTimeout(flush, FLUSH_MS);
}

/**
 * `m`, with a smaller form to send instead when it doesn't fit in one
 * NOTIFY (a record event without the record). Not serialized itself.
 */
export function withSlim(m: PeerMessage, slim: PeerMessage): PeerMessage {
  Object.defineProperty(m, "slim", { value: slim, enumerable: false });
  return m;
}

/** A cache other servers should drop too (hooks, routes, jobs, …). */
export function announceInvalidation(cache: string): void {
  sendToPeers({ k: `cache:${cache}` });
}

/** Register a cache other servers' announcements drop here. */
export function onPeerInvalidation(cache: string, invalidate: () => void): void {
  onPeerMessage(`cache:${cache}`, () => invalidate(), { reset: true });
}

function encode(list: PeerMessage[]): string | null {
  const payload = JSON.stringify({ from: self, m: list });
  if (payload.length <= MAX_PAYLOAD) return payload;
  if (list.length === 1) {
    // One message too large (a big record): its `slim` form, if it has one.
    const slim = (list[0] as { slim?: PeerMessage }).slim;
    if (slim) return encode([slim]);
    console.warn(`[peers] dropped a ${list[0]!.k} message of ${payload.length} bytes`);
    return null;
  }
  return null;
}

function flush(): void {
  flushTimer = null;
  const list = outbox;
  outbox = [];
  if (!driver || !channel || list.length === 0) return;
  // Pack in order, as many per NOTIFY as fit.
  let batch: PeerMessage[] = [];
  const send = (b: PeerMessage[]) => {
    const payload = encode(b);
    if (payload) driver!.notify(channel!, payload).catch(warn);
  };
  for (const m of list) {
    const next = [...batch, m];
    if (batch.length > 0 && JSON.stringify({ from: self, m: next }).length > MAX_PAYLOAD) {
      send(batch);
      batch = [m];
    } else {
      batch = next;
    }
  }
  if (batch.length > 0) send(batch);
}

function receive(payload: string): void {
  let parsed: { from?: string; m?: PeerMessage[] };
  try { parsed = JSON.parse(payload); } catch { return; }
  if (parsed.from === self || !Array.isArray(parsed.m)) return;
  for (const m of parsed.m) {
    // One at a time, in order: a settings re-read finishes before the
    // caches built from it are dropped.
    inbound = inbound.then(() => handle(m));
  }
}

async function handle(m: PeerMessage): Promise<void> {
  const fn = handlers.get(m.k);
  if (!fn) return;
  try {
    await relaying.run(true, () => fn(m));
  } catch (e) {
    warn(e);
  }
}

/** After a reconnect: anything may have changed meanwhile. */
function resetAll(): void {
  for (const k of resettable) inbound = inbound.then(() => handle({ k }));
}

function warn(e: unknown): void {
  console.warn(`[peers] ${e instanceof Error ? e.message : String(e)}`);
}

/**
 * Start listening. Postgres only: on SQLite there is one server per
 * database file. The channel is named after the schema, so servers on
 * different schemas of one database don't hear each other.
 */
export async function startPeers(d: PeerDriver): Promise<void> {
  if (d.name !== "postgres" || channel) return;
  const schema = (await d.get<{ s: string }>(`SELECT current_schema() AS s`))?.s ?? "public";
  const name = `vaultbase_${schema}`.slice(0, 63);
  let first = true;
  driver = d;
  subscription = await d.listen(name, receive, () => {
    if (first) { first = false; return; }
    resetAll();
  });
  channel = name;
}

/** Stop listening and drop what was not sent yet (shutdown, tests). */
export async function stopPeers(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  flush();
  outbox = [];
  const sub = subscription;
  subscription = null;
  channel = null;
  driver = null;
  await sub?.unlisten().catch(() => { /* closing */ });
  await inbound.catch(() => { /* logged */ });
}

/** Messages in flight have been handled (tests). */
export function _peersIdle(): Promise<void> {
  return inbound;
}
