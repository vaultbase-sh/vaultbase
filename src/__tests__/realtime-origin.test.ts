import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import { createServer } from "../server.ts";
import { stopScheduler } from "../core/jobs.ts";
import { stopQueueScheduler } from "../core/queues.ts";
import { stopWebhookDispatcher } from "../core/webhooks.ts";
import { stopUpdateCheckScheduler } from "../core/update-check.ts";
import { _reset as resetRealtime } from "../realtime/manager.ts";

// Origin policy for the realtime endpoints (WS /realtime, SSE GET /api/v1/realtime):
//  - a browser on an allow-listed origin connects
//  - a browser on any other origin is refused (cross-site WebSocket hijacking)
//  - a non-browser client that sends no Origin connects; it still has to
//    authenticate with a token to see anything protected. Requiring Origin
//    there adds nothing (non-browsers can send any value) and locks out the
//    server-side SDK.

const ALLOWED = "https://app.example.com";
const FOREIGN = "https://evil.example.net";

let dir: string;
let server: { stop: (force?: boolean) => unknown; port: number };
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vb-origin-"));
  initDb(":memory:");
  await runMigrations();
  setSetting("security.allowed_origins", ALLOWED);
  const app = createServer({
    port: 0,
    dataDir: dir,
    dbPath: ":memory:",
    uploadDir: join(dir, "uploads"),
    logsDir: join(dir, "logs"),
    jwtSecret: "test-secret-realtime-origin",
    encryptionKey: undefined,
  });
  app.listen({ port: 0, hostname: "127.0.0.1" });
  server = app.server as unknown as typeof server;
  base = `127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  // createServer starts background tickers; left running they fire after
  // closeDb() and throw into whichever test file runs next.
  stopScheduler();
  stopQueueScheduler();
  stopWebhookDispatcher();
  stopUpdateCheckScheduler();
  resetRealtime();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

/** First message the server sends on the socket ("connected" or an error). */
function firstWsMessage(origin: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = origin ? { Origin: origin } : {};
    const ws = new WebSocket(`ws://${base}/realtime`, { headers } as unknown as string[]);
    const timer = setTimeout(() => { ws.close(); reject(new Error("no message within 3s")); }, 3000);
    ws.onmessage = (e) => { clearTimeout(timer); ws.close(); resolve(String(e.data)); };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("socket error")); };
  });
}

async function sseStatus(origin: string | null): Promise<number> {
  const ctrl = new AbortController();
  const headers: Record<string, string> = origin ? { Origin: origin } : {};
  const res = await fetch(`http://${base}/api/v1/realtime`, { headers, signal: ctrl.signal });
  const status = res.status;
  ctrl.abort();
  return status;
}

describe("realtime Origin policy — WebSocket", () => {
  it("accepts an allow-listed Origin", async () => {
    expect(await firstWsMessage(ALLOWED)).toContain('"connected"');
  });

  it("refuses a foreign Origin", async () => {
    expect(await firstWsMessage(FOREIGN)).toContain("origin_not_allowed");
  });

  it("accepts a client that sends no Origin (server-side SDK)", async () => {
    expect(await firstWsMessage(null)).toContain('"connected"');
  });
});

describe("realtime Origin policy — SSE", () => {
  it("accepts an allow-listed Origin", async () => {
    expect(await sseStatus(ALLOWED)).toBe(200);
  });

  it("refuses a foreign Origin", async () => {
    expect(await sseStatus(FOREIGN)).toBe(403);
  });

  it("accepts a client that sends no Origin (server-side SDK)", async () => {
    expect(await sseStatus(null)).toBe(200);
  });
});
