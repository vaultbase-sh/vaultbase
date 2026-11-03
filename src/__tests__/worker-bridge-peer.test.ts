/**
 * The worker listener bridges a realtime WebSocket to the main thread and
 * passes the client's address in its own header. Client headers used to be
 * copied over it, so a client could pick the address the per-IP cap counts.
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createServer, startInternalListener } from "../server.ts";
import { listenOnWorker } from "../core/worker-listeners.ts";
import { admitConnection, connectionCount, _reset as resetRealtime } from "../realtime/manager.ts";
import { stopScheduler } from "../core/jobs.ts";
import { stopQueueScheduler } from "../core/queues.ts";
import { stopWebhookDispatcher } from "../core/webhooks.ts";
import { stopUpdateCheckScheduler } from "../core/update-check.ts";

const SECRET = "test-secret-bridge-peer";
const dir = mkdtempSync(join(tmpdir(), "vb-bridge-peer-"));
let internal: ReturnType<typeof startInternalListener>;
let worker: { port?: number; stop(force?: boolean): unknown };

/** Open a WS through the worker listener; resolves with the first frame type or "refused". */
function tryWs(headers: Record<string, string>): Promise<{ result: string; ws: WebSocket }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${worker.port}/realtime`, { headers } as unknown as string[]);
    const t = setTimeout(() => resolve({ result: "timeout", ws }), 4000);
    ws.onmessage = (e) => { clearTimeout(t); resolve({ result: JSON.parse(String(e.data)).type, ws }); };
    ws.onerror = () => { clearTimeout(t); resolve({ result: "refused", ws }); };
    ws.onclose = () => { clearTimeout(t); resolve({ result: "refused", ws }); };
  });
}

beforeAll(async () => {
  await initDb(":memory:");
  await runMigrations();
  const config = { port: 0, dataDir: dir, dbPath: ":memory:", uploadDir: join(dir, "u"), logsDir: join(dir, "l"), jwtSecret: SECRET, encryptionKey: undefined } as never;
  const app = createServer(config);
  internal = startInternalListener(app, config, 10);
  worker = listenOnWorker(
    { type: "listen", port: 0, hostname: "127.0.0.1", idleTimeout: 10, internalPort: internal.port, secret: internal.secret },
    { app, jwtSecret: SECRET, workerId: "w0", takeToken: async () => true, post: () => {} },
  ) as never;
});

afterAll(async () => {
  worker.stop(true);
  internal.stop();
  stopScheduler(); stopQueueScheduler(); stopWebhookDispatcher(); stopUpdateCheckScheduler();
  resetRealtime();
  await closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("worker WS bridge peer header", () => {
  it("ignores a client-sent x-vaultbase-peer", async () => {
    // Fill the per-address cap (MAX_CONNECTIONS_PER_IP = 100) for one address.
    for (let i = 0; i < 100; i++) expect(admitConnection(`fill-${i}`, "198.51.100.7")).toBe(true);
    const before = connectionCount();
    // The client is really on loopback, which has no per-client cap: claiming
    // the full address must not get it refused, and the count still goes up.
    const claimed = await tryWs({ "x-vaultbase-peer": "198.51.100.7" });
    expect(claimed.result).toBe("connected");
    expect(connectionCount()).toBe(before + 1);
    try { claimed.ws.close(); } catch { /* closed */ }
  });
});
