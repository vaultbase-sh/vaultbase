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
 * Sizes are counted in UTF-8 bytes, as Postgres counts them (a record in
 * Chinese is about three times its length). Record events, the only large
 * messages, never share a NOTIFY with an invalidation, so an oversized one
 * can't take a rule change down with it, and a failed NOTIFY is retried. As
 * a backstop for one lost anyway, every invalidation also moves a sequence
 * ({@link GEN_SEQUENCE}) that each server polls: a move it didn't make
 * itself means it may have missed one, and it resets.
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
const RETRY_MS = [250, 2_000];
const GEN_SEQUENCE = "vaultbase_peer_generation";
let genPollMs = 10_000;

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/**
 * A message whose loss leaves another server serving stale state (a cache,
 * a rule, a setting) until a restart. Record events (realtime) and per-table
 * write reports (list totals) aren't: they're frequent, and the next one
 * carries the news.
 */
function isInvalidation(m: PeerMessage): boolean {
  if (m.k.startsWith("cache:")) return true;
  return m.k === "bus" && (m["m"] as { kind?: string } | undefined)?.kind !== "tables";
}

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
let genTimer: ReturnType<typeof setInterval> | null = null;
/** The generation last seen, and the values this server moved it to since. */
let genSeen = 0;
const genOwn = new Set<number>();

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
  if (isInvalidation(m)) bumpGeneration();
  if (driver.inTransaction) {
    // On this transaction's connection: delivered at COMMIT, dropped on
    // rollback. Not retried: a failure aborts the transaction itself.
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
  if (bytes(payload) <= MAX_PAYLOAD) return payload;
  if (list.length === 1) {
    // One message too large (a big record): its `slim` form, if it has one.
    const slim = (list[0] as { slim?: PeerMessage }).slim;
    if (slim) return encode([slim]);
    console.warn(`[peers] dropped a ${list[0]!.k} message of ${bytes(payload)} bytes`);
    return null;
  }
  // Several that don't fit together: one NOTIFY each.
  for (const m of list) post(encode([m]));
  return null;
}

/** NOTIFY, retried after a failure (a dropped connection, a busy server). */
function post(payload: string | null, attempt = 0): void {
  if (!payload || !driver || !channel) return;
  driver.notify(channel, payload).catch((e) => {
    const wait = RETRY_MS[attempt];
    if (wait === undefined) { warn(e); return; }
    setTimeout(() => post(payload, attempt + 1), wait);
  });
}

function flush(): void {
  flushTimer = null;
  const list = outbox;
  outbox = [];
  if (!driver || !channel || list.length === 0) return;
  // Record events (`slim`) and everything else are packed apart, each in
  // order, as many per NOTIFY as fit.
  const records = list.filter((m) => (m as { slim?: PeerMessage }).slim);
  const others = list.filter((m) => !(m as { slim?: PeerMessage }).slim);
  for (const group of [others, records]) {
    let batch: PeerMessage[] = [];
    for (const m of group) {
      const next = [...batch, m];
      if (batch.length > 0 && bytes(JSON.stringify({ from: self, m: next })) > MAX_PAYLOAD) {
        post(encode(batch));
        batch = [m];
      } else {
        batch = next;
      }
    }
    if (batch.length > 0) post(encode(batch));
  }
}

/** Move the invalidation generation (non-transactional: a rollback keeps it, which costs only a reset). */
function bumpGeneration(): void {
  driver?.get<{ n: string | number }>(`SELECT nextval('${GEN_SEQUENCE}') AS n`)
    .then((r) => { if (r) genOwn.add(Number(r.n)); })
    .catch(warn);
}

async function pollGeneration(): Promise<void> {
  if (!driver) return;
  const r = await driver.get<{ n: string | number; called: boolean }>(`SELECT last_value AS n, is_called AS called FROM ${GEN_SEQUENCE}`);
  const gen = r && r.called ? Number(r.n) : 0;
  if (gen <= genSeen) return;
  let missed = false;
  for (let g = genSeen + 1; g <= gen; g++) if (!genOwn.delete(g)) { missed = true; break; }
  for (const g of genOwn) if (g <= gen) genOwn.delete(g);
  genSeen = gen;
  // Another server's invalidation: we were sent it, and may have missed it.
  if (missed) resetAll();
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
  await d.get(`CREATE SEQUENCE IF NOT EXISTS ${GEN_SEQUENCE}`).catch(() => { /* another server made it */ });
  const r = await d.get<{ n: string | number; called: boolean }>(`SELECT last_value AS n, is_called AS called FROM ${GEN_SEQUENCE}`).catch(() => null);
  genSeen = r && r.called ? Number(r.n) : 0;
  genOwn.clear();
  genTimer = setInterval(() => { void pollGeneration().catch(warn); }, genPollMs);
  (genTimer as { unref?: () => void }).unref?.();
}

/** Tests: poll the generation now / more often. */
export function _pollPeerGeneration(): Promise<void> {
  return pollGeneration();
}
export function _setPeerGenerationPollMs(ms: number): void {
  genPollMs = ms;
}

/** Stop listening and drop what was not sent yet (shutdown, tests). */
export async function stopPeers(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (genTimer) { clearInterval(genTimer); genTimer = null; }
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
