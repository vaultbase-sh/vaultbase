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
 * stay on the main thread; a worker that errors is dropped with its
 * in-flight requests failed; a reply that doesn't arrive in
 * `FORWARD_TIMEOUT_MS` fails that request and drops the worker. When the
 * last worker is gone, `readPoolSize()` is 0 and the main thread serves.
 */
import { getCollectionCached } from "./collections.ts";
import type { Config } from "../config.ts";

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
}

const slots: Slot[] = [];
const pending = new Map<number, { slot: Slot; resolve: (r: ForwardReply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let seq = 0;
let forwarded = 0;
let dropped = 0;

/** How long a worker may take to answer one request, or to start. */
export const FORWARD_TIMEOUT_MS = 30_000;
const START_TIMEOUT_MS = 30_000;

export function readPoolSize(): number {
  return slots.length;
}

export function readPoolStats(): { workers: number; forwarded: number; inflight: number; dropped: number } {
  return { workers: slots.length, forwarded, inflight: slots.reduce((n, s) => n + s.inflight, 0), dropped };
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
  slot.inflight++;
  forwarded++;
  try {
    const reply = await new Promise<ForwardReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        dropWorker(slot, `no reply in ${FORWARD_TIMEOUT_MS} ms`);
        reject(new Error("read worker timed out"));
      }, FORWARD_TIMEOUT_MS);
      pending.set(id, { slot, resolve, reject, timer });
      slot.worker.postMessage(msg);
    });
    return new Response(reply.body, { status: reply.status, headers: reply.headers });
  } finally {
    slot.inflight--;
  }
}

function onReply(e: MessageEvent): void {
  const m = e.data as ForwardReply | { type: string };
  if (m.type !== "reply") return;
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
  failSlot(slot, reason);
  try { slot.worker.terminate(); } catch { /* gone */ }
  process.stderr.write(`vaultbase: read worker dropped (${reason}); ${slots.length} left\n`);
}

/**
 * Spawn `n` workers from `workerUrl` (src/read-worker.ts, built as its own
 * entry point into the compiled binary, so the URL must be made next to the
 * entry file: `new URL("./read-worker.ts", import.meta.url)` in index.ts).
 * Resolves once every worker has its database open and its app built;
 * rejects, with every worker terminated and no slot kept, if any fails or
 * takes longer than `START_TIMEOUT_MS`.
 */
export async function startReadPool(n: number, env: Record<string, string>, config: Config, workerUrl: URL | string): Promise<void> {
  if (slots.length > 0 || n <= 0) return;
  const ready: Array<Promise<void>> = [];
  const started: Slot[] = [];
  for (let i = 0; i < n; i++) {
    const worker = new Worker(workerUrl, { env: { ...env, VAULTBASE_READ_WORKER: String(i) } });
    const slot: Slot = { worker, inflight: 0, served: 0 };
    started.push(slot);
    ready.push(new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`read worker ${i} did not start in ${START_TIMEOUT_MS} ms`)), START_TIMEOUT_MS);
      worker.onmessage = (e: MessageEvent) => {
        const m = e.data as { type: string; message?: string };
        if (m.type === "ready") { clearTimeout(timer); resolve(); }
        else if (m.type === "error") { clearTimeout(timer); reject(new Error(m.message ?? "read worker error")); }
        else onReply(e);
      };
      worker.onerror = (e) => {
        clearTimeout(timer);
        if (slots.includes(slot)) dropWorker(slot, e.message);
        reject(new Error(e.message));
      };
    }));
    worker.postMessage({ type: "start", config });
  }
  try {
    await Promise.all(ready);
  } catch (e) {
    for (const s of started) { try { s.worker.terminate(); } catch { /* gone */ } }
    throw e;
  }
  slots.push(...started);
  // Workers must never keep the process alive on their own.
  for (const s of slots) (s.worker as { unref?: () => void }).unref?.();
}

export async function stopReadPool(): Promise<void> {
  const all = slots.splice(0);
  for (const s of all) {
    failSlot(s, "pool stopped");
    try { s.worker.postMessage({ type: "stop" }); } catch { /* gone */ }
    s.worker.terminate();
  }
}
