/**
 * Read workers with listeners of their own (core/worker-listeners.ts): a
 * worker serves record reads itself and passes everything else to the main
 * thread's internal listener. In production every listener shares the
 * public port; macOS doesn't spread `reusePort` connections, so here the
 * workers listen on a port of their own, which makes the worker path
 * deterministic.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { setSetting } from "../api/settings.ts";
import { invalidateRateLimitCache } from "../api/ratelimit.ts";
import { admin as adminTable } from "../db/schema.ts";
import { signAuthToken } from "../core/sec.ts";
import { createServer, startInternalListener } from "../server.ts";
import { readPoolStats, setWorkerListen, startReadPool, stopReadPool, _resetReadPoolStats } from "../core/read-pool.ts";
import { INTERNAL_HEADER, PEER_HEADER, workerListenersEnabled } from "../core/worker-listeners.ts";
import { stopScheduler } from "../core/jobs.ts";
import { stopQueueScheduler } from "../core/queues.ts";
import { stopWebhookDispatcher } from "../core/webhooks.ts";
import { stopUpdateCheckScheduler } from "../core/update-check.ts";
import { _reset as resetRealtime } from "../realtime/manager.ts";
import { createPublicCollection } from "./_helpers.ts";

const SECRET = "test-secret-worker-listeners";
const WORKER_URL = new URL("../read-worker.ts", import.meta.url);
let dir: string;
let app: ReturnType<typeof createServer>;
let internal: ReturnType<typeof startInternalListener>;
let workerBase: string;
let workerPort: number;

/** A free port: bind one, note it, let it go. */
function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
}

async function untilListening(base: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { await fetch(`${base}/api/health`); return; } catch { await Bun.sleep(20); }
  }
  throw new Error("worker listener never came up");
}

function listen(): Promise<void> {
  setWorkerListen({ type: "listen", port: workerPort, hostname: "127.0.0.1", idleTimeout: 10, internalPort: internal.port, secret: internal.secret });
  return untilListening(workerBase);
}

const json = { "content-type": "application/json" };

beforeAll(async () => {
  await stopReadPool();
  _resetReadPoolStats();
  dir = mkdtempSync(join(tmpdir(), "vb-worker-listeners-"));
  const dbPath = join(dir, "data.db");
  await initDb(`file:${dbPath}`);
  await runMigrations();
  await createPublicCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
  const config = { port: 0, dataDir: dir, dbPath, uploadDir: join(dir, "u"), logsDir: join(dir, "l"), jwtSecret: SECRET, encryptionKey: undefined };
  app = createServer(config);
  app.listen({ port: 0, hostname: "127.0.0.1" });
  internal = startInternalListener(app, config, 10);
  await startReadPool(1, {}, config, WORKER_URL);
  workerPort = freePort();
  workerBase = `http://127.0.0.1:${workerPort}`;
  await listen();
  // The worker learns collections from the reads it serves; the first read
  // of one goes through the main thread.
  await fetch(`${workerBase}/api/v1/posts`);
});

afterAll(async () => {
  setWorkerListen(null);
  await stopReadPool();
  internal.stop();
  await app.stop();
  stopScheduler(); stopQueueScheduler(); stopWebhookDispatcher(); stopUpdateCheckScheduler();
  resetRealtime();
  _resetCollectionCache();
  await closeDb();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("workerListenersEnabled", () => {
  it("is on for Linux unless turned off, and can be forced on elsewhere", () => {
    expect(workerListenersEnabled({}, "linux")).toBe(true);
    expect(workerListenersEnabled({}, "darwin")).toBe(false);
    expect(workerListenersEnabled({}, "win32")).toBe(false);
    expect(workerListenersEnabled({ VAULTBASE_WORKER_LISTENERS: "0" }, "linux")).toBe(false);
    expect(workerListenersEnabled({ VAULTBASE_WORKER_LISTENERS: "1" }, "darwin")).toBe(true);
    expect(workerListenersEnabled({ VAULTBASE_WORKER_LISTENERS: " " }, "linux")).toBe(true);
  });
});

describe("a worker's own listener", () => {
  it("serves record reads itself, without the main thread forwarding them", async () => {
    const before = readPoolStats().forwarded;
    const list = await fetch(`${workerBase}/api/v1/posts?perPage=5`);
    expect(list.status).toBe(200);
    expect(list.headers.get("x-vaultbase-read-worker")).not.toBeNull();
    expect(list.headers.get("x-content-type-options")).toBe("nosniff");
    expect(((await list.json()) as { data: unknown[] }).data).toEqual([]);
    expect(readPoolStats().forwarded).toBe(before);
  });

  it("passes writes and other routes to the main thread", async () => {
    const created = await fetch(`${workerBase}/api/v1/posts`, { method: "POST", headers: json, body: JSON.stringify({ title: "via a worker" }) });
    expect(created.status).toBe(200);
    expect(created.headers.get("x-vaultbase-read-worker")).toBeNull();
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    const one = await fetch(`${workerBase}/api/v1/posts/${id}`);
    expect(((await one.json()) as { data: { title: string } }).data.title).toBe("via a worker");
    expect((await fetch(`${workerBase}/api/v1/collections`)).status).toBe(401);
    expect((await fetch(`${workerBase}/api/v1/no_such_collection`)).status).toBe(404);
  });

  it("delivers realtime events over a WebSocket it bridges to the main thread", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${workerPort}/realtime`);
    const event = new Promise<{ type: string; record?: { title: string } }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no event")), 5_000);
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as { type: string; record?: { title: string } };
        if (m.type === "connected") ws.send(JSON.stringify({ type: "subscribe", topics: ["posts"] }));
        else if (m.type === "subscribed") void fetch(`${workerBase}/api/v1/posts`, { method: "POST", headers: json, body: JSON.stringify({ title: "live" }) });
        else if (m.type === "create") { clearTimeout(timer); resolve(m); }
      };
    });
    try {
      expect((await event).record?.title).toBe("live");
    } finally {
      ws.close();
    }
  });

  it("streams SSE from the main thread", async () => {
    const ctl = new AbortController();
    const res = await fetch(`${workerBase}/api/v1/realtime`, { signal: ctl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("clientId");
    ctl.abort();
  });

  it("charges reads to the main thread's rate-limit buckets", async () => {
    setSetting("rate_limit.enabled", "1");
    setSetting("rate_limit.rules", JSON.stringify([{ label: "/api/posts*", max: 2, windowMs: 60_000, audience: "all" }]));
    invalidateRateLimitCache();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) statuses.push((await fetch(`${workerBase}/api/v1/posts?perPage=1`)).status);
      expect(statuses).toEqual([200, 200, 429]);
      // One set of buckets: the main thread's own listener is out of tokens too.
      expect((await fetch(`http://127.0.0.1:${app.server!.port}/api/v1/posts?perPage=1`)).status).toBe(429);
    } finally {
      setSetting("rate_limit.rules", "[]");
      setSetting("rate_limit.enabled", process.env["VAULTBASE_RATE_ENABLED"] === "0" ? "0" : "1");
      invalidateRateLimitCache();
    }
  });

  it("counts the requests it accepted in the main thread's metrics", async () => {
    await getDb().insert(adminTable).values({ id: "a1", email: "a@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
    const { token } = await signAuthToken({ payload: { id: "a1", email: "a@test.local" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET });
    const headers = { authorization: `Bearer ${token}` };
    await app.handle(new Request("http://localhost/api/v1/_/metrics/reset", { method: "POST", headers }));
    for (let i = 0; i < 5; i++) await fetch(`${workerBase}/api/v1/posts?perPage=1`);
    // Workers post their figures once a second.
    let total = 0;
    for (let i = 0; i < 40 && total < 5; i++) {
      await Bun.sleep(100);
      total = ((await (await app.handle(new Request("http://localhost/api/v1/_/metrics", { headers }))).json()) as { requests_total: number }).requests_total;
    }
    expect(total).toBeGreaterThanOrEqual(5);
  });

  it("listens again after the pool restarts, and stops when told to", async () => {
    await stopReadPool();
    await startReadPool(1, {}, { port: 0, dataDir: dir, dbPath: join(dir, "data.db"), uploadDir: join(dir, "u"), logsDir: join(dir, "l"), jwtSecret: SECRET, encryptionKey: undefined }, WORKER_URL);
    await untilListening(workerBase);
    expect((await fetch(`${workerBase}/api/v1/posts?perPage=1`)).status).toBe(200);
    setWorkerListen(null);
    let refused = false;
    for (let i = 0; i < 50 && !refused; i++) {
      try { await fetch(`${workerBase}/api/health`, { headers: { connection: "close" } }); await Bun.sleep(20); } catch { refused = true; }
    }
    expect(refused).toBe(true);
    await listen();
  });
});

describe("the main thread's internal listener", () => {
  const internalFetch = (path: string, headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${internal.port}${path}`, { headers });

  it("refuses requests without this process's secret", async () => {
    expect((await internalFetch("/api/health", {})).status).toBe(403);
    expect((await internalFetch("/api/health", { [INTERNAL_HEADER]: "not-the-secret" })).status).toBe(403);
    expect((await internalFetch("/api/health", { [INTERNAL_HEADER]: internal.secret })).status).toBe(200);
  });

  it("treats the peer a worker reports as the client's address", async () => {
    // Per-address buckets: the reported peer, not loopback, is the key.
    setSetting("rate_limit.enabled", "1");
    setSetting("rate_limit.rules", JSON.stringify([{ label: "/api/posts*", max: 1, windowMs: 60_000, audience: "all" }]));
    invalidateRateLimitCache();
    try {
      const as = (peer: string) => internalFetch("/api/v1/posts?perPage=1", { [INTERNAL_HEADER]: internal.secret, [PEER_HEADER]: peer });
      expect((await as("203.0.113.7")).status).toBe(200);
      expect((await as("203.0.113.7")).status).toBe(429);
      expect((await as("203.0.113.8")).status).toBe(200);
    } finally {
      setSetting("rate_limit.rules", "[]");
      setSetting("rate_limit.enabled", process.env["VAULTBASE_RATE_ENABLED"] === "0" ? "0" : "1");
      invalidateRateLimitCache();
    }
  });
});
