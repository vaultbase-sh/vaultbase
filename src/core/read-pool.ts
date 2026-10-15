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
 */
import { getCollectionCached } from "./collections.ts";

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
  /** jti of the API token the worker verified, for usage telemetry on main. */
  jti?: string;
}

interface Slot {
  worker: Worker;
  inflight: number;
  served: number;
}

const slots: Slot[] = [];
const pending = new Map<number, { slot: Slot; resolve: (r: ForwardReply) => void; reject: (e: Error) => void }>();
let seq = 0;
let forwarded = 0;

export function readPoolSize(): number {
  return slots.length;
}

export function readPoolStats(): { workers: number; forwarded: number; inflight: number } {
  return { workers: slots.length, forwarded, inflight: slots.reduce((n, s) => n + s.inflight, 0) };
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
      pending.set(id, { slot, resolve, reject });
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
  p.resolve(r);
}

function failSlot(slot: Slot, reason: string): void {
  for (const [id, p] of pending) {
    if (p.slot !== slot) continue;
    pending.delete(id);
    p.reject(new Error(`read worker failed: ${reason}`));
  }
}

/** Spawn `n` workers; resolves once each has its database open. */
export async function startReadPool(n: number, env: Record<string, string>): Promise<void> {
  if (slots.length > 0 || n <= 0) return;
  const ready: Array<Promise<void>> = [];
  for (let i = 0; i < n; i++) {
    const worker = new Worker(new URL("../read-worker.ts", import.meta.url), { env: { ...env, VAULTBASE_READ_WORKER: String(i) } });
    const slot: Slot = { worker, inflight: 0, served: 0 };
    slots.push(slot);
    ready.push(new Promise<void>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent) => {
        const m = e.data as { type: string; message?: string };
        if (m.type === "ready") resolve();
        else if (m.type === "error") { reject(new Error(m.message ?? "read worker error")); }
        else onReply(e);
      };
      worker.onerror = (e) => { failSlot(slot, e.message); reject(new Error(e.message)); };
    }));
    worker.postMessage({ type: "start" });
  }
  await Promise.all(ready);
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
