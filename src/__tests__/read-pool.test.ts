/**
 * Read worker pool (core/read-pool.ts, read-worker.ts): which requests are
 * forwarded, and that a worker thread answers them the way the main thread
 * would, on the same database file.
 */
import { describe, expect, it, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache, createCollection, getCollection, updateCollection } from "../core/collections.ts";
import { setSetting } from "../api/settings.ts";
import { getDb } from "../db/client.ts";
import { admin as adminTable } from "../db/schema.ts";
import { signAuthToken } from "../core/sec.ts";
import { createRecord } from "../core/records.ts";
import { createServer } from "../server.ts";
import { readTarget, startReadPool, stopReadPool, readPoolStats, readWorkerCount, forwardRead, respawnDelay, _resetReadPoolStats, _setReadPoolTimings } from "../core/read-pool.ts";
import { stopScheduler } from "../core/jobs.ts";
import { stopQueueScheduler } from "../core/queues.ts";
import { stopWebhookDispatcher } from "../core/webhooks.ts";
import { stopUpdateCheckScheduler } from "../core/update-check.ts";
import { _reset as resetRealtime } from "../realtime/manager.ts";
import { createPublicCollection } from "./_helpers.ts";

const SECRET = "test-secret-read-pool";
const WORKER_URL = new URL("../read-worker.ts", import.meta.url);
let dir: string;
let app: ReturnType<typeof createServer>;
let config: Parameters<typeof createServer>[0];
const get = (path: string, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, { headers }));
const fromWorker = (res: Response) => res.headers.get("x-vaultbase-read-worker");
/** What the main thread answers for an admin-only collection without a token. */
let mainDenied = 0;

beforeAll(async () => {
  // Start from a fresh pool whatever ran before in this process (another
  // file's pool leaves counters and worker ids behind).
  await stopReadPool();
  _resetReadPoolStats();
  dir = mkdtempSync(join(tmpdir(), "vb-read-pool-"));
  const dbPath = join(dir, "data.db");
  await initDb(`file:${dbPath}`);
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
  await closeDb();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe("readWorkerCount", () => {
  it("defaults to two fewer than the cores (at least 1, at most 8) and honours the variable", () => {
    expect(readWorkerCount({}, 4, "/d/data.db")).toBe(2);
    expect(readWorkerCount({}, 3, "/d/data.db")).toBe(1);
    expect(readWorkerCount({}, 2, "/d/data.db")).toBe(1);
    expect(readWorkerCount({}, 1, "/d/data.db")).toBe(0);
    expect(readWorkerCount({}, 10, "/d/data.db")).toBe(8);
    expect(readWorkerCount({}, 32, "/d/data.db")).toBe(8);
    expect(readWorkerCount({ VAULTBASE_READ_WORKERS: "2" }, 16, "/d/data.db")).toBe(2);
    expect(readWorkerCount({ VAULTBASE_READ_WORKERS: "0" }, 16, "/d/data.db")).toBe(0);
    expect(readWorkerCount({ VAULTBASE_READ_WORKERS: "" }, 4, "/d/data.db")).toBe(2);
    expect(readWorkerCount({ VAULTBASE_READ_WORKERS: "nope" }, 4, "/d/data.db")).toBe(0);
  });

  it("stays at zero under cluster mode and for an in-memory database", () => {
    expect(readWorkerCount({ VAULTBASE_WORKER_ID: "0" }, 8, "/d/data.db")).toBe(0);
    expect(readWorkerCount({ VAULTBASE_READ_WORKERS: "3", VAULTBASE_WORKER_ID: "1" }, 8, "/d/data.db")).toBe(0);
    expect(readWorkerCount({}, 8, ":memory:")).toBe(0);
  });
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
    expect(readPoolStats()).toEqual({ workers: 0, forwarded: 0, inflight: 0, dropped: 0, restarted: 0 });
    mainDenied = (await get("/api/v1/secrets")).status;
    expect(mainDenied).toBeGreaterThanOrEqual(400);
  });

  it("a worker answers a list and a get-one exactly like the main thread", async () => {
    const mainList = await (await get("/api/v1/posts?perPage=5&sort=title")).json();
    await startReadPool(2, {}, config, WORKER_URL);
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

  it("a collection change on the main thread reaches the workers without a restart", async () => {
    const col = (await getCollection("posts"))!;
    await updateCollection(col.id, { list_rule: "" });
    const denied = await get("/api/v1/posts?perPage=1");
    expect(fromWorker(denied)).not.toBeNull();
    expect(denied.status).toBe(mainDenied);
    await updateCollection(col.id, { list_rule: null });
    const open = await get("/api/v1/posts?perPage=1");
    expect(fromWorker(open)).not.toBeNull();
    expect(open.status).toBe(200);
  });

  it("a settings change on the main thread reaches the workers", async () => {
    // The collection change above emptied the main thread's collection cache;
    // the first read refills it on main, later ones are forwarded.
    await get("/api/v1/posts?perPage=1");
    const before = await get("/api/v1/posts?perPage=1", { origin: "https://bus.test" });
    expect(fromWorker(before)).not.toBeNull();
    expect(before.headers.get("access-control-allow-origin")).toBeNull();
    setSetting("cors.origins", "https://bus.test");
    const after = await get("/api/v1/posts?perPage=1", { origin: "https://bus.test" });
    expect(fromWorker(after)).not.toBeNull();
    expect(after.headers.get("access-control-allow-origin")).toBe("https://bus.test");
    setSetting("cors.origins", "");
  });

  it("totals on a worker follow writes on the main thread, to this and other collections", async () => {
    const total = async () => ((await (await get("/api/v1/posts?perPage=1")).json()) as { totalItems: number }).totalItems;
    const n = await total();
    await createRecord("secrets", { note: "elsewhere" });
    expect(await total()).toBe(n);
    await createRecord("posts", { title: "counted", tags: [] });
    expect(await total()).toBe(n + 1);
  });

  it("a worker's steps and query shapes show in the main thread's metrics, and reset clears them", async () => {
    await getDb().insert(adminTable).values({ id: "a1", email: "a@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
    const { token } = await signAuthToken({ payload: { id: "a1", email: "a@test.local" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET });
    const headers = { authorization: `Bearer ${token}` };
    await app.handle(new Request("http://localhost/api/v1/_/metrics/reset", { method: "POST", headers }));
    for (let i = 0; i < 5; i++) expect(fromWorker(await get("/api/v1/posts?perPage=2&sort=title"))).not.toBeNull();
    // Workers post once a second.
    type Snap = { steps: Record<string, { count: number }>; read_workers: { workers: number; forwarded: number } };
    let snap: Snap | null = null;
    for (let i = 0; i < 40; i++) {
      await Bun.sleep(100);
      snap = (await (await app.handle(new Request("http://localhost/api/v1/_/metrics", { headers }))).json()) as Snap;
      if (snap.steps["db_exec"]!.count >= 5) break;
    }
    expect(snap!.read_workers.workers).toBe(2);
    expect(snap!.read_workers.forwarded).toBeGreaterThanOrEqual(5);
    expect(snap!.steps["db_exec"]!.count).toBeGreaterThanOrEqual(5);
    const queries = (await (await app.handle(new Request("http://localhost/api/v1/_/metrics/queries", { headers }))).json()) as { data: Array<{ collection: string; sort: string | null; count: number }> };
    const shape = queries.data.find((q) => q.collection === "posts" && q.sort === "title");
    expect(shape).toBeDefined();
    expect(shape!.count).toBeGreaterThanOrEqual(5);
    await app.handle(new Request("http://localhost/api/v1/_/metrics/reset", { method: "POST", headers }));
    await Bun.sleep(1_300);
    const after = (await (await app.handle(new Request("http://localhost/api/v1/_/metrics", { headers }))).json()) as { steps: Record<string, { count: number }> };
    expect(after.steps["db_exec"]!.count).toBe(0);
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

  it("a pool whose worker can't open the database starts nothing and leaves reads on the main thread", async () => {
    await expect(startReadPool(1, {}, { ...config, dbPath: join(dir, "missing", "nope.db") }, WORKER_URL)).rejects.toThrow();
    expect(readPoolStats().workers).toBe(0);
    const res = await get("/api/v1/posts?perPage=1");
    expect(res.status).toBe(200);
    expect(fromWorker(res)).toBeNull();
  });
});

describe("failures", () => {
  const STUB_URL = new URL("./_stub-read-worker.ts", import.meta.url);
  const read = () => forwardRead(new Request("http://localhost/api/v1/posts"), null);
  const waitFor = async (ok: () => boolean, ms = 3_000) => {
    for (let t = 0; t < ms && !ok(); t += 20) await Bun.sleep(20);
    return ok();
  };

  afterEach(async () => {
    await stopReadPool();
    _setReadPoolTimings({});
  });

  it("backs off 1 s, doubling for each young death in a row, at most 60 s", () => {
    expect([0, 1, 2, 3, 4].map((n) => respawnDelay(n))).toEqual([1_000, 1_000, 2_000, 4_000, 8_000]);
    expect(respawnDelay(7)).toBe(60_000);
    expect(respawnDelay(50)).toBe(60_000);
  });

  it("a worker that is behind but still answering is not dropped", async () => {
    _setReadPoolTimings({ forwardTimeoutMs: 500 });
    await startReadPool(1, { STUB_MODE: "slow", STUB_DELAY_MS: "200" }, config, STUB_URL);
    const before = readPoolStats().dropped;
    // Answered at ~200, 400, 600, 800 ms: the last two outlive the timeout.
    const results = await Promise.allSettled([read(), read(), read(), read()]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(2);
    expect(results.filter((r) => r.status === "rejected").length).toBe(2);
    expect(readPoolStats()).toMatchObject({ workers: 1, dropped: before });
    // Its late replies (~600, ~800 ms) count as progress; once caught up it answers again.
    await Bun.sleep(400);
    expect((await read()).status).toBe(200);
    expect(readPoolStats()).toMatchObject({ workers: 1, dropped: before });
  });

  it("a worker that answers nothing is dropped and replaced", async () => {
    _setReadPoolTimings({ forwardTimeoutMs: 200, respawnBaseMs: 50 });
    await startReadPool(1, { STUB_MODE: "stuck" }, config, STUB_URL);
    const { dropped, restarted } = readPoolStats();
    await expect(read()).rejects.toThrow("timed out");
    expect(readPoolStats()).toMatchObject({ workers: 0, dropped: dropped + 1 });
    expect(await waitFor(() => readPoolStats().workers === 1)).toBe(true);
    expect(readPoolStats().restarted).toBe(restarted + 1);
  });

  it("keeps replacing a worker that keeps dying, backing off each time", async () => {
    _setReadPoolTimings({ forwardTimeoutMs: 100, respawnBaseMs: 100 });
    await startReadPool(1, { STUB_MODE: "stuck" }, config, STUB_URL);
    const { restarted } = readPoolStats();
    await expect(read()).rejects.toThrow("timed out");
    expect(await waitFor(() => readPoolStats().workers === 1)).toBe(true); // after ~100 ms
    const t0 = Date.now();
    await expect(read()).rejects.toThrow("timed out");
    expect(await waitFor(() => readPoolStats().workers === 1)).toBe(true); // after ~200 ms: it died young
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100 + 200 - 20);
    expect(readPoolStats().restarted).toBe(restarted + 2);
  });

  it("stopping the pool cancels a pending replacement", async () => {
    _setReadPoolTimings({ forwardTimeoutMs: 100, respawnBaseMs: 200 });
    await startReadPool(1, { STUB_MODE: "stuck" }, config, STUB_URL);
    await expect(read()).rejects.toThrow("timed out");
    await stopReadPool();
    await Bun.sleep(400);
    expect(readPoolStats().workers).toBe(0);
  });
});
