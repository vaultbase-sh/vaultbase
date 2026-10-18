/**
 * Read worker pool: record reads served on worker threads.
 *
 * The main thread accepts every request and keeps writes, auth, admin,
 * files, realtime and user code. A list or get-one of a known collection is
 * posted to the least-loaded worker as a small message (method, URL,
 * headers, peer IP); the worker answers with status, headers and the body
 * as a transferred buffer, and the main thread writes that out. Each worker
 * runs the same Elysia app on its own SQLite connection; WAL lets any number
 * of readers run beside the single writer.
 *
 * Off unless `VAULTBASE_READ_WORKERS` is set (see index.ts). With no pool,
 * `forwardRead` is never called and nothing here runs.
 *
 * Failure rules: a pool that can't start leaves nothing behind, so reads
 * stay on the main thread. A reply that doesn't arrive in
 * `FORWARD_TIMEOUT_MS` fails that request (503). A worker is dropped, with
 * its in-flight requests failed, when it errors or when it has answered
 * nothing at all for a whole timeout: one that is merely behind under load
 * keeps answering and stays. A dropped worker is replaced after
 * {@link respawnDelay}; while none is running, `readPoolSize()` is 0 and
 * the main thread serves.
 */
import { getCollectionCached } from "./collections.ts";
import type { Config } from "../config.ts";
import { setBusSender, type WorkerStats } from "./thread-bus.ts";
import { globalMetrics, type HistogramParts, type Step } from "./perf-metrics.ts";
import { setExternalShapes, type ExportedShape } from "./query-stats.ts";

export interface ForwardRequest {
  type: "request";
  id: number;
  method: string;
  url: string;
  headers: Array<[string, string]>;
  peerIp: string | null;
}

export interface ForwardReply {
  type: "reply";
  id: number;
  status: number;
  headers: Array<[string, string]>;
  body: ArrayBuffer | null;
}

interface Slot {
  worker: Worker;
  inflight: number;
  served: number;
  /** Spawn time, part of the id its stats are filed under. */
  born: number;
  /** When it last answered, or went from idle to busy. */
  progressAt: number;
  statsId?: string;
}

/** What the pool was started with, so a dropped worker can be replaced. Null when stopped. */
interface PoolSpec {
  size: number;
  env: Record<string, string>;
  config: Config;
  workerUrl: URL | string;
}

const slots: Slot[] = [];
const pending = new Map<number, { slot: Slot; resolve: (r: ForwardReply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let seq = 0;
let forwarded = 0;
let dropped = 0;
let restarted = 0;
let nextWorkerId = 0;
let spec: PoolSpec | null = null;
/** Replacements being started. */
let starting = 0;
/** Workers in a row that died within {@link YOUNG_MS} of starting, or failed to start. */
let failures = 0;
let respawnTimer: ReturnType<typeof setTimeout> | null = null;

/** How long a worker may take to answer one request, or to start. */
export const FORWARD_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 30_000;
/** A worker dropped sooner than this after starting counts as a failed restart. */
const YOUNG_MS = 60_000;
const RESPAWN_BASE_MS = 1_000;
const RESPAWN_MAX_MS = 60_000;

let forwardTimeoutMs = FORWARD_TIMEOUT_MS;
let respawnBaseMs = RESPAWN_BASE_MS;

/** Shorter timings for tests. */
export function _setReadPoolTimings(t: { forwardTimeoutMs?: number; respawnBaseMs?: number }): void {
  forwardTimeoutMs = t.forwardTimeoutMs ?? FORWARD_TIMEOUT_MS;
  respawnBaseMs = t.respawnBaseMs ?? RESPAWN_BASE_MS;
}

/**
 * How long to wait before starting a replacement: the base (1 s) after a
 * worker that ran for a while, doubling for each one in a row that died
 * young or failed to start, at most 60 s.
 */
export function respawnDelay(failuresInARow: number, baseMs = RESPAWN_BASE_MS): number {
  return Math.min(RESPAWN_MAX_MS, baseMs * 2 ** Math.min(Math.max(0, failuresInARow - 1), 6));
}

export function readPoolSize(): number {
  return slots.length;
}

export function readPoolStats(): { workers: number; forwarded: number; inflight: number; dropped: number; restarted: number } {
  return { workers: slots.length, forwarded, inflight: slots.reduce((n, s) => n + s.inflight, 0), dropped, restarted };
}

/** Most read workers started by default; more rarely helps and each costs memory. */
export const MAX_DEFAULT_READ_WORKERS = 8;

/**
 * How many read workers to start: `VAULTBASE_READ_WORKERS` when set (`0`
 * keeps everything on one thread), otherwise two fewer than the cores, at
 * least 1 on two cores or more and at most {@link MAX_DEFAULT_READ_WORKERS}.
 * Two are kept free: one for the main thread, which still parses every
 * request and writes every reply, and one for the reverse proxy and the
 * rest of the box; on a 4-vCPU host three workers measured worse than two.
 * Always 0 on a single core, under `vaultbase cluster` (its worker
 * processes already use every core) and for an in-memory database (nothing
 * to share).
 */
export function readWorkerCount(env: Record<string, string | undefined>, cores: number, dbPath: string): number {
  if (env["VAULTBASE_WORKER_ID"]) return 0;
  if (dbPath === ":memory:" || dbPath === "file::memory:") return 0;
  const raw = env["VAULTBASE_READ_WORKERS"];
  if (raw !== undefined && raw.trim() !== "") {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  if (cores < 2) return 0;
  return Math.max(1, Math.min(MAX_DEFAULT_READ_WORKERS, cores - 2));
}

/**
 * Only the two record reads go to a worker: `GET /api/v1/<collection>` and
 * `GET /api/v1/<collection>/<id>`, for a collection the main thread already
 * knows. Everything else (admin, auth, files, realtime, aggregate, history,
 * custom routes, the admin UI) stays here.
 */
const READ_PATH = /^\/api\/v1\/([A-Za-z0-9_]+)(?:\/([^/]+))?$/;

export function readTarget(method: string, pathname: string): { collection: string; id: string | null } | null {
  if (method !== "GET") return null;
  const m = READ_PATH.exec(pathname);
  if (!m) return null;
  const collection = m[1]!;
  const id = m[2] ?? null;
  if (id !== null && id.startsWith("_")) return null;
  if (!getCollectionCached(collection)) return null;
  return { collection, id };
}

function pick(): Slot {
  let best = slots[0]!;
  for (const s of slots) if (s.inflight < best.inflight) best = s;
  return best;
}

/** Send the request to a worker and build the Response from its reply. */
export async function forwardRead(request: Request, peerIp: string | null): Promise<Response> {
  const slot = pick();
  const id = ++seq;
  const headers: Array<[string, string]> = [];
  request.headers.forEach((v, k) => headers.push([k, v]));
  const msg: ForwardRequest = { type: "request", id, method: request.method, url: request.url, headers, peerIp };
  if (slot.inflight === 0) slot.progressAt = Date.now();
  slot.inflight++;
  forwarded++;
  try {
    const reply = await new Promise<ForwardReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new Error("read worker timed out"));
        // Behind is not stuck: a worker that answered anything during the
        // window stays (10 ms of slack for timer granularity).
        if (slots.includes(slot) && Date.now() - slot.progressAt + 10 >= forwardTimeoutMs) {
          dropWorker(slot, `no reply in ${forwardTimeoutMs} ms`);
        }
      }, forwardTimeoutMs);
      pending.set(id, { slot, resolve, reject, timer });
      slot.worker.postMessage(msg);
    });
    return new Response(reply.body, { status: reply.status, headers: reply.headers });
  } finally {
    slot.inflight--;
  }
}

function onStats(slot: Slot, m: WorkerStats): void {
  const id = `w${slots.indexOf(slot)}:${slot.born}`;
  globalMetrics.setExternalSteps(id, m.steps as Partial<Record<Step, HistogramParts>>);
  setExternalShapes(id, m.queries as ExportedShape[]);
  slot.statsId = id;
}

function onReply(slot: Slot, e: MessageEvent): void {
  const m = e.data as ForwardReply | { type: string };
  if (m.type !== "reply") return;
  // Any reply is progress, including a late one to a request that timed out.
  slot.progressAt = Date.now();
  const r = m as ForwardReply;
  const p = pending.get(r.id);
  if (!p) return;
  pending.delete(r.id);
  clearTimeout(p.timer);
  p.resolve(r);
}

function failSlot(slot: Slot, reason: string): void {
  for (const [id, p] of pending) {
    if (p.slot !== slot) continue;
    pending.delete(id);
    clearTimeout(p.timer);
    p.reject(new Error(`read worker failed: ${reason}`));
  }
}

/** Take a worker out of service: fail what it owes, terminate it, forget it. */
function dropWorker(slot: Slot, reason: string): void {
  const i = slots.indexOf(slot);
  if (i >= 0) slots.splice(i, 1);
  dropped++;
  if (slot.statsId) { globalMetrics.setExternalSteps(slot.statsId, null); setExternalShapes(slot.statsId, null); }
  failSlot(slot, reason);
  try { slot.worker.terminate(); } catch { /* gone */ }
  process.stderr.write(`vaultbase: read worker dropped (${reason}); ${slots.length} left\n`);
  if (!spec) return;
  failures = Date.now() - slot.born < YOUNG_MS ? failures + 1 : 1;
  armRespawn();
}

/** Start a replacement after the backoff, unless one is due or the pool is full or stopped. */
function armRespawn(): void {
  if (!spec || respawnTimer || slots.length + starting >= spec.size) return;
  respawnTimer = setTimeout(() => { respawnTimer = null; void respawnOne(); }, respawnDelay(failures, respawnBaseMs));
  (respawnTimer as { unref?: () => void }).unref?.();
}

async function respawnOne(): Promise<void> {
  const s = spec;
  if (!s || slots.length + starting >= s.size) return;
  starting++;
  try {
    const slot = await spawnSlot(s);
    if (spec !== s) { try { slot.worker.terminate(); } catch { /* gone */ } return; } // stopped meanwhile
    slots.push(slot);
    restarted++;
    process.stderr.write(`vaultbase: read worker restarted; ${slots.length} running\n`);
  } catch (e) {
    failures++;
    process.stderr.write(`vaultbase: read worker restart failed (${e instanceof Error ? e.message : String(e)}); retrying\n`);
  } finally {
    starting--;
    armRespawn();
  }
}

/**
 * Start one worker and resolve once its database is open and its app built.
 * Rejects, with the worker terminated, if it fails or takes longer than
 * `START_TIMEOUT_MS`. Workers never keep the process alive on their own.
 */
function spawnSlot(s: PoolSpec): Promise<Slot> {
  const i = nextWorkerId++;
  const worker = new Worker(s.workerUrl, { env: { ...s.env, VAULTBASE_READ_WORKER: String(i) } });
  const born = Date.now();
  const slot: Slot = { worker, inflight: 0, served: 0, born, progressAt: born };
  return new Promise<Slot>((resolve, reject) => {
    const fail = (e: Error) => {
      clearTimeout(timer);
      try { worker.terminate(); } catch { /* gone */ }
      reject(e);
    };
    const timer = setTimeout(() => fail(new Error(`read worker ${i} did not start in ${START_TIMEOUT_MS} ms`)), START_TIMEOUT_MS);
    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as { type: string; message?: string };
      if (m.type === "ready") {
        clearTimeout(timer);
        (worker as { unref?: () => void }).unref?.();
        resolve(slot);
      } else if (m.type === "error") fail(new Error(m.message ?? "read worker error"));
      else if (m.type === "stats") onStats(slot, m as unknown as WorkerStats);
      else onReply(slot, e);
    };
    worker.onerror = (e) => {
      if (slots.includes(slot)) dropWorker(slot, e.message);
      else fail(new Error(e.message));
    };
    worker.postMessage({ type: "start", config: s.config });
  });
}

/**
 * Spawn `n` workers from `workerUrl` (src/read-worker.ts, built as its own
 * entry point into the compiled binary, so the URL must be made next to the
 * entry file: `new URL("./read-worker.ts", import.meta.url)` in index.ts).
 * Resolves once every worker has its database open and its app built;
 * rejects, with every worker terminated and no slot kept, if any fails or
 * takes longer than `START_TIMEOUT_MS`. Once running, the pool keeps `n`
 * workers, replacing any that are dropped.
 */
export async function startReadPool(n: number, env: Record<string, string>, config: Config, workerUrl: URL | string): Promise<void> {
  if (spec || slots.length > 0 || n <= 0) return;
  const s: PoolSpec = { size: n, env, config, workerUrl };
  const results = await Promise.allSettled(Array.from({ length: n }, () => spawnSlot(s)));
  const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
  const started = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  if (failed) {
    for (const slot of started) { try { slot.worker.terminate(); } catch { /* gone */ } }
    throw failed.reason;
  }
  spec = s;
  failures = 0;
  slots.push(...started);
  setBusSender((m) => { for (const s of slots) { try { s.worker.postMessage(m); } catch { /* dropped */ } } });
}

export async function stopReadPool(): Promise<void> {
  spec = null;
  if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
  setBusSender(null);
  const all = slots.splice(0);
  for (const s of all) {
    if (s.statsId) { globalMetrics.setExternalSteps(s.statsId, null); setExternalShapes(s.statsId, null); }
    failSlot(s, "pool stopped");
    try { s.worker.postMessage({ type: "stop" }); } catch { /* gone */ }
    s.worker.terminate();
  }
}
