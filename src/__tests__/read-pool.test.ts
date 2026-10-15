/**
 * Read worker pool (core/read-pool.ts, read-worker.ts): which requests are
 * forwarded, and that a worker thread answers them the way the main thread
 * would, on the same database file.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache, createCollection } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
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
let config: Parameters<typeof createServer>[0];
const get = (path: string, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, { headers }));
const fromWorker = (res: Response) => res.headers.get("x-vaultbase-read-worker");
/** What the main thread answers for an admin-only collection without a token. */
let mainDenied = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vb-read-pool-"));
  const dbPath = join(dir, "data.db");
  initDb(`file:${dbPath}`);
  await runMigrations();
  await createPublicCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }, { name: "tags", type: "json" }]) });
  await createCollection({ name: "secrets", fields: JSON.stringify([{ name: "note", type: "text" }]) });
  for (let i = 0; i < 12; i++) await createRecord("posts", { title: `post ${i}`, tags: [i] });
  config = { port: 0, dataDir: dir, dbPath, uploadDir: join(dir, "u"), logsDir: join(dir, "l"), jwtSecret: SECRET, encryptionKey: undefined };
  app = createServer(config);
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
    const res = await get("/api/v1/posts");
    expect(res.status).toBe(200);
    expect(fromWorker(res)).toBeNull();
    expect(readPoolStats()).toEqual({ workers: 0, forwarded: 0, inflight: 0 });
    mainDenied = (await get("/api/v1/secrets")).status;
    expect(mainDenied).toBeGreaterThanOrEqual(400);
  });

  it("a worker answers a list and a get-one exactly like the main thread", async () => {
    const mainList = await (await get("/api/v1/posts?perPage=5&sort=title")).json();
    await startReadPool(2, {}, config);
    expect(readPoolStats().workers).toBe(2);
    const res = await get("/api/v1/posts?perPage=5&sort=title");
    expect(res.status).toBe(200);
    expect(fromWorker(res)).toMatch(/^[01]$/);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.json()).toEqual(mainList);
    const id = (mainList as { data: Array<{ id: string }> }).data[0]!.id;
    const one = await get(`/api/v1/posts/${id}`);
    expect(one.status).toBe(200);
    expect(fromWorker(one)).not.toBeNull();
    expect(((await one.json()) as { data: { id: string; tags: number[] } }).data).toMatchObject({ id, tags: expect.any(Array) });
    expect(readPoolStats()).toMatchObject({ forwarded: 2, inflight: 0 });
  });

  it("keeps status codes, auth and conditional requests", async () => {
    expect((await get("/api/v1/posts/does-not-exist")).status).toBe(404);
    const denied = await get("/api/v1/secrets");
    expect(denied.status).toBe(mainDenied);
    expect(fromWorker(denied)).not.toBeNull();
    const first = await get("/api/v1/posts?perPage=2");
    const etag = first.headers.get("etag");
    if (etag) {
      const again = await get("/api/v1/posts?perPage=2", { "if-none-match": etag });
      expect(again.status).toBe(304);
      expect(fromWorker(again)).not.toBeNull();
    }
  });

  it("a write on the main thread is visible to the next read on a worker", async () => {
    const created = await createRecord("posts", { title: "fresh", tags: [] });
    const res = await get(`/api/v1/posts/${created.id}`);
    expect(res.status).toBe(200);
    expect(fromWorker(res)).not.toBeNull();
    expect(((await res.json()) as { data: { title: string } }).data.title).toBe("fresh");
  });

  it("leaves other routes on the main thread and stops cleanly", async () => {
    const health = await get("/api/v1/_/health");
    expect(fromWorker(health)).toBeNull();
    const post = await app.handle(new Request("http://localhost/api/v1/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "x" }) }));
    expect(fromWorker(post)).toBeNull();
    await stopReadPool();
    expect(readPoolStats().workers).toBe(0);
    expect(fromWorker(await get("/api/v1/posts"))).toBeNull();
  });
});
