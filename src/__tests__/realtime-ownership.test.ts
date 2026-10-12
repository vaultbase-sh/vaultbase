/**
 * Over a real server:
 *  - `POST /api/v1/realtime` and `DELETE /api/v1/realtime/:clientId` took
 *    the SSE clientId as their only credential (Shannon AUTHZ-03). The id
 *    rides in URLs and request logs; once the client has signed in, managing
 *    it now takes a token for the same principal.
 *  - with `security.allowed_origins` empty, even a page served by this very
 *    host was refused a WebSocket. Same-origin is always allowed now.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
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
import { _reset as resetRealtime } from "../realtime/manager.ts";
import { seedAuthUser, signUserJwt } from "./_helpers.ts";

const SECRET = "test-secret-realtime-ownership";
let dir: string;
let server: { stop: (force?: boolean) => unknown; port: number };
let base: string;
let aliceJwt: string;
let bobJwt: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vb-rt-own-"));
  initDb(":memory:");
  await runMigrations();
  const alice = await seedAuthUser({ collection: "users", email: "alice@test.local" });
  const bob = await seedAuthUser({ collection: "users", email: "bob@test.local" });
  aliceJwt = await signUserJwt(alice, "alice@test.local", "users", SECRET);
  bobJwt = await signUserJwt(bob, "bob@test.local", "users", SECRET);
  const app = createServer({
    port: 0, dataDir: dir, dbPath: ":memory:", uploadDir: join(dir, "uploads"),
    logsDir: join(dir, "logs"), jwtSecret: SECRET, encryptionKey: undefined,
  });
  app.listen({ port: 0, hostname: "127.0.0.1" });
  server = app.server as unknown as typeof server;
  base = `127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  stopScheduler(); stopQueueScheduler(); stopWebhookDispatcher(); stopUpdateCheckScheduler();
  resetRealtime();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

/** Open an SSE stream and read its clientId from the greeting. */
async function openSse(): Promise<{ clientId: string; close: () => void }> {
  const ctrl = new AbortController();
  const res = await fetch(`http://${base}/api/v1/realtime`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  let text = "";
  while (!text.includes("clientId")) text += new TextDecoder().decode((await reader.read()).value);
  const clientId = /"clientId":"([^"]+)"/.exec(text)![1]!;
  return { clientId, close: () => ctrl.abort() };
}

const post = (body: unknown, bearer?: string) => fetch(`http://${base}/api/v1/realtime`, {
  method: "POST",
  headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
  body: JSON.stringify(body),
});
const del = (clientId: string, bearer?: string) => fetch(`http://${base}/api/v1/realtime/${clientId}`, {
  method: "DELETE", headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
});

describe("SSE client ownership", () => {
  it("once signed in, the clientId alone can't change or close the stream", async () => {
    const sse = await openSse();
    try {
      expect((await post({ clientId: sse.clientId, topics: ["notes"], token: aliceJwt })).status).toBe(200);
      expect((await post({ clientId: sse.clientId, topics: ["other"] })).status).toBe(403);
      expect((await post({ clientId: sse.clientId, topics: ["other"], token: bobJwt })).status).toBe(403);
      expect((await del(sse.clientId)).status).toBe(403);
      expect((await del(sse.clientId, bobJwt)).status).toBe(403);
      // The owner can (legitimate path).
      expect((await post({ clientId: sse.clientId, topics: ["other"] }, aliceJwt)).status).toBe(200);
      expect((await del(sse.clientId, aliceJwt)).status).toBe(200);
    } finally {
      sse.close();
    }
  });
});

describe("same-origin WebSocket", () => {
  it("is accepted with no allow-list configured", async () => {
    const msg = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://${base}/realtime`, { headers: { Origin: `http://${base}` } } as unknown as string[]);
      const timer = setTimeout(() => { ws.close(); reject(new Error("no message")); }, 3000);
      ws.onmessage = (e) => { clearTimeout(timer); ws.close(); resolve(String(e.data)); };
    });
    expect(msg).toContain('"connected"');
  });
});
