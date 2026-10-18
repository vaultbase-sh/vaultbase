/**
 * A WebSocket client that stops reading had every event buffered for it, with
 * no limit: 50 such clients held ~150 MB in a load test, and one address may
 * open MAX_CONNECTIONS_PER_IP of them. A socket more than MAX_WS_QUEUED_BYTES
 * behind is now cut off (as SSE clients are), and the others keep receiving.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "bun:test";
import * as net from "node:net";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createServer } from "../server.ts";
import { stopScheduler } from "../core/jobs.ts";
import { stopQueueScheduler } from "../core/queues.ts";
import { stopWebhookDispatcher } from "../core/webhooks.ts";
import { stopUpdateCheckScheduler } from "../core/update-check.ts";
import {
  _reset as resetRealtime, broadcast, broadcastSystem, connectionCount, subscribe, MAX_WS_QUEUED_BYTES, type WSLike,
} from "../realtime/manager.ts";

const event = (pad = "") => ({ type: "create" as const, collection: "notes", record: { id: "r1", collectionId: "c", collectionName: "notes", created: 0, updated: 0, pad } });

/** A socket double the way Elysia hands it over: the Bun socket under `raw`. */
function fakeWs(id: string, queued: number) {
  const got: string[] = [];
  const raw = { terminated: false, getBufferedAmount: () => queued, terminate() { this.terminated = true; } };
  return { ws: { data: { connId: id }, raw, send: (m: string) => { got.push(m); } } as unknown as WSLike, got, raw };
}

describe("slow WebSocket consumers (manager)", () => {
  beforeEach(() => resetRealtime());

  it("cuts off a socket more than the limit behind, and stops sending to it", () => {
    const slow = fakeWs("slow", MAX_WS_QUEUED_BYTES + 1);
    const fine = fakeWs("fine", 10);
    subscribe(slow.ws, ["notes"]);
    subscribe(fine.ws, ["notes"]);
    broadcast("notes", event());
    expect(slow.raw.terminated).toBe(true);
    expect(slow.got).toHaveLength(0);
    expect(fine.got).toHaveLength(1);
    broadcast("notes", event());
    expect(fine.got).toHaveLength(2);
  });

  it("applies to system messages too", () => {
    const slow = fakeWs("slow", MAX_WS_QUEUED_BYTES + 1);
    subscribe(slow.ws, ["__flags"]);
    broadcastSystem("__flags", { type: "flags" });
    expect(slow.raw.terminated).toBe(true);
    expect(slow.got).toHaveLength(0);
  });

  it("keeps a socket at the limit (legitimate path)", () => {
    const busy = fakeWs("busy", MAX_WS_QUEUED_BYTES);
    subscribe(busy.ws, ["notes"]);
    broadcast("notes", event());
    expect(busy.raw.terminated).toBe(false);
    expect(busy.got).toHaveLength(1);
  });
});

describe("slow WebSocket consumers (real sockets)", () => {
  let dir: string;
  let server: { stop: (force?: boolean) => unknown; port: number };

  beforeAll(async () => {
    resetRealtime();
    dir = mkdtempSync(join(tmpdir(), "vb-slow-ws-"));
    await initDb(":memory:");
    await runMigrations();
    const app = createServer({
      port: 0, dataDir: dir, dbPath: ":memory:", uploadDir: join(dir, "uploads"), logsDir: join(dir, "logs"),
      jwtSecret: "test-secret-slow-ws", encryptionKey: undefined,
    });
    app.listen({ port: 0, hostname: "127.0.0.1" });
    server = app.server as unknown as typeof server;
  });

  afterAll(async () => {
    server?.stop(true);
    stopScheduler(); stopQueueScheduler(); stopWebhookDispatcher(); stopUpdateCheckScheduler();
    resetRealtime();
    await closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Upgrade, subscribe to `notes`, then never read again. */
  function openNonReading(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const s = net.connect(server.port, "127.0.0.1", () => {
        const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
        s.write(`GET /realtime HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
        setTimeout(() => {
          const payload = Buffer.from(JSON.stringify({ type: "subscribe", topics: ["notes"] }));
          const mask = Buffer.from(crypto.getRandomValues(new Uint8Array(4)));
          s.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, Buffer.from(payload.map((b, j) => b ^ mask[j % 4]!))]));
          setTimeout(() => { s.pause(); resolve(s); }, 150);
        }, 150);
      });
      s.on("error", reject);
    });
  }

  function openReading(): Promise<{ ws: WebSocket; got: () => number }> {
    return new Promise((resolve) => {
      let n = 0;
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/realtime`);
      ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", topics: ["notes"] }));
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data));
        if (m.type === "subscribed") resolve({ ws, got: () => n });
        else if (m.type === "create") n++;
      };
    });
  }

  it("drops the client that stopped reading; the reading one gets everything", async () => {
    const slow = await openNonReading();
    const reader = await openReading();
    expect(connectionCount()).toBe(2);
    const pad = "x".repeat(4096);
    const N = 1500; // ~6 MB per subscriber, far past the limit
    for (let i = 0; i < N; i++) {
      broadcast("notes", event(pad));
      if (i % 50 === 49) await Bun.sleep(1);
    }
    const until = Date.now() + 5000;
    while ((connectionCount() > 1 || reader.got() < N) && Date.now() < until) await Bun.sleep(20);
    expect(connectionCount()).toBe(1);
    expect(reader.got()).toBe(N);
    slow.destroy();
    reader.ws.close();
  });
});
