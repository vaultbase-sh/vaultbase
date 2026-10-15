/**
 * Read worker pool (core/read-pool.ts): which requests are forwarded, and
 * that a forwarded request comes back from a worker thread.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { createServer } from "../server.ts";
import { readTarget, startReadPool, stopReadPool, readPoolStats } from "../core/read-pool.ts";
import { stopScheduler } from "../core/jobs.ts";
import { stopQueueScheduler } from "../core/queues.ts";
import { stopWebhookDispatcher } from "../core/webhooks.ts";
import { stopUpdateCheckScheduler } from "../core/update-check.ts";
import { _reset as resetRealtime } from "../realtime/manager.ts";
import { createPublicCollection } from "./_helpers.ts";

const SECRET = "test-secret-read-pool";
let dir: string;
let app: ReturnType<typeof createServer>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vb-read-pool-"));
  initDb(":memory:");
  await runMigrations();
  await createPublicCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
  app = createServer({ port: 0, dataDir: dir, dbPath: ":memory:", uploadDir: join(dir, "u"), logsDir: join(dir, "l"), jwtSecret: SECRET, encryptionKey: undefined });
});

afterAll(async () => {
  await stopReadPool();
  stopScheduler(); stopQueueScheduler(); stopWebhookDispatcher(); stopUpdateCheckScheduler();
  resetRealtime();
  _resetCollectionCache();
  closeDb();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("readTarget", () => {
  it("matches only GET list and get-one of a known collection", () => {
    expect(readTarget("GET", "/api/v1/posts")).toEqual({ collection: "posts", id: null });
    expect(readTarget("GET", "/api/v1/posts/abc-123")).toEqual({ collection: "posts", id: "abc-123" });
    expect(readTarget("POST", "/api/v1/posts")).toBeNull();
    expect(readTarget("GET", "/api/v1/nope")).toBeNull();
    expect(readTarget("GET", "/api/v1/posts/_aggregate")).toBeNull();
    expect(readTarget("GET", "/api/v1/posts/abc/history")).toBeNull();
    expect(readTarget("GET", "/api/v1/admin/collections")).toBeNull();
    expect(readTarget("GET", "/api/v1/_/metrics")).toBeNull();
    expect(readTarget("GET", "/api/v1/realtime")).toBeNull();
    expect(readTarget("GET", "/api/posts")).toBeNull();
  });
});

describe("forwarding", () => {
  it("serves reads on the main thread while no pool is running", async () => {
    const res = await app.handle(new Request("http://localhost/api/v1/posts"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-vaultbase-read-worker")).toBeNull();
    expect(readPoolStats()).toEqual({ workers: 0, forwarded: 0, inflight: 0 });
  });

  it("forwards a list to a worker once a pool is running and leaves other routes alone", async () => {
    await startReadPool(2, {});
    expect(readPoolStats().workers).toBe(2);
    const res = await app.handle(new Request("http://localhost/api/v1/posts?perPage=5"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-vaultbase-read-worker")).toMatch(/^[01]$/);
    // Step 1: the worker echoes; step 2 serves the real list.
    expect(await res.json()).toMatchObject({ echo: true });
    const health = await app.handle(new Request("http://localhost/api/v1/_/health"));
    expect(health.headers.get("x-vaultbase-read-worker")).toBeNull();
    const post = await app.handle(new Request("http://localhost/api/v1/posts", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(post.headers.get("x-vaultbase-read-worker")).toBeNull();
    expect(readPoolStats()).toMatchObject({ forwarded: 1, inflight: 0 });
    await stopReadPool();
    expect(readPoolStats().workers).toBe(0);
    const again = await app.handle(new Request("http://localhost/api/v1/posts"));
    expect(again.headers.get("x-vaultbase-read-worker")).toBeNull();
  });
});
