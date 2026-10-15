/**
 * Read worker thread entry (see core/read-pool.ts).
 *
 * Opens its own connection to the same database, builds the app in the
 * "reader" role (same routes, nothing in the background) and serves each
 * forwarded request through `app.handle`. The reply carries the status,
 * the headers and the body as a transferred buffer.
 */
import { initDb } from "./db/client.ts";
import { rememberPeer } from "./core/sec.ts";
import type { Config } from "./config.ts";
import type { ForwardRequest, ForwardReply } from "./core/read-pool.ts";
import type { BusMessage } from "./core/thread-bus.ts";
import { applyTableReport } from "./core/table-writes.ts";
import { _resetCollectionCache } from "./core/collections.ts";
import { invalidateSetting } from "./api/settings.ts";
import { invalidateRateLimitCache } from "./api/ratelimit.ts";
import { invalidateCorsCache } from "./core/cors.ts";
import { invalidateEgressCache } from "./core/hook-egress.ts";
import { invalidateEmailCache } from "./core/email.ts";
import { invalidateStorageCache } from "./core/storage.ts";
import { globalMetrics } from "./core/perf-metrics.ts";
import { exportShapes, resetQueryStats } from "./core/query-stats.ts";
import type { WorkerStats } from "./core/thread-bus.ts";

/** Post this thread's step histograms and query shapes to the main thread. */
function postStats(): void {
  const m: WorkerStats = { type: "stats", steps: globalMetrics.exportSteps() as WorkerStats["steps"], queries: exportShapes() };
  scope.postMessage(m);
}

interface WorkerScope {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  close(): void;
}
const scope = globalThis as unknown as WorkerScope;

type Incoming = { type: "start"; config: Config } | { type: "stop" } | ForwardRequest | BusMessage;

/** What the main thread tells us changed (core/thread-bus.ts). */
function dispatchBus(m: BusMessage): void {
  switch (m.kind) {
    case "tables":
      for (const [table, changes] of m.tables) applyTableReport(table, changes);
      break;
    case "collections":
      _resetCollectionCache();
      break;
    case "metrics-reset":
      globalMetrics.reset();
      resetQueryStats();
      postStats();
      break;
    case "settings":
      invalidateSetting(m.key);
      // The same caches the settings PATCH drops on the main thread.
      invalidateRateLimitCache();
      invalidateEmailCache();
      invalidateStorageCache();
      invalidateEgressCache();
      invalidateCorsCache();
      break;
  }
}

const WORKER_ID = process.env["VAULTBASE_READ_WORKER"] ?? "";
let app: { handle: (req: Request) => Promise<Response> } | null = null;

async function start(config: Config): Promise<void> {
  initDb(config.dbPath === ":memory:" ? config.dbPath : `file:${config.dbPath}`);
  const { createServer } = await import("./server.ts");
  app = createServer(config, { role: "reader" }) as unknown as { handle: (req: Request) => Promise<Response> };
  const timer = setInterval(postStats, 1_000);
  (timer as { unref?: () => void }).unref?.();
}

async function serve(m: ForwardRequest): Promise<void> {
  let status = 500;
  let headers: Array<[string, string]> = [["content-type", "application/json"]];
  let body: ArrayBuffer;
  try {
    const req = new Request(m.url, { method: m.method, headers: m.headers });
    rememberPeer(req, m.peerIp);
    const res = await app!.handle(req);
    status = res.status;
    headers = [];
    res.headers.forEach((v, k) => headers.push([k, v]));
    headers.push(["x-vaultbase-read-worker", WORKER_ID]);
    body = await res.arrayBuffer();
  } catch (e) {
    body = new TextEncoder().encode(JSON.stringify({ error: e instanceof Error ? e.message : "read worker failed", code: 500 })).buffer as ArrayBuffer;
  }
  const reply: ForwardReply = { type: "reply", id: m.id, status, headers, body };
  scope.postMessage(reply, [body]);
}

scope.onmessage = (e: MessageEvent) => {
  const m = e.data as Incoming;
  if (m.type === "start") {
    start(m.config).then(
      () => scope.postMessage({ type: "ready" }),
      (err) => scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) }),
    );
    return;
  }
  if (m.type === "stop") {
    scope.close();
    return;
  }
  if (m.type === "bus") {
    dispatchBus(m);
    return;
  }
  if (m.type === "request") {
    if (!app) {
      const body = new TextEncoder().encode(JSON.stringify({ error: "read worker not ready", code: 503 })).buffer as ArrayBuffer;
      scope.postMessage({ type: "reply", id: m.id, status: 503, headers: [["content-type", "application/json"]], body } satisfies ForwardReply, [body]);
      return;
    }
    void serve(m);
  }
};
