/**
 * Routes that read the raw request (file upload, CSV import, restore upload)
 * through the whole server, rate limiter and all. From 0.38.0 to 0.41.0 the
 * global rate-limit hook took `body`, so Elysia parsed every request first
 * and these handlers found the body already read: uploads answered 400 and
 * CSV import 500. Tests that mount one plugin alone can't see that.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { admin as adminTable } from "../db/schema.ts";
import { createServer } from "../server.ts";
import { signAuthToken } from "../core/sec.ts";
import { createCollection, _resetCollectionCache } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { invalidateRateLimitCache } from "../api/ratelimit.ts";
import { stopScheduler } from "../core/jobs.ts";
import { stopQueueScheduler } from "../core/queues.ts";
import { stopWebhookDispatcher } from "../core/webhooks.ts";
import { stopUpdateCheckScheduler } from "../core/update-check.ts";
import { _reset as resetRealtime } from "../realtime/manager.ts";

const SECRET = "test-secret-raw-body-routes";

let dir: string;
let app: ReturnType<typeof createServer>;
let token: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vb-raw-body-"));
  await initDb(":memory:");
  await runMigrations();
  invalidateRateLimitCache();
  await getDb().insert(adminTable).values({ id: "a1", email: "a@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
  app = createServer({ port: 0, dataDir: dir, dbPath: ":memory:", uploadDir: join(dir, "u"), logsDir: join(dir, "l"), jwtSecret: SECRET, encryptionKey: undefined });
  token = (await signAuthToken({ payload: { id: "a1", email: "a@test.local" }, audience: "admin", expiresInSeconds: 600, jwtSecret: SECRET })).token;
  await createCollection({ name: "docs", type: "base", fields: JSON.stringify([
    { name: "title", type: "text" },
    { name: "att", type: "file", options: { mimeTypes: ["text/plain"] } },
  ]) });
});

afterAll(async () => {
  stopScheduler(); stopQueueScheduler(); stopWebhookDispatcher(); stopUpdateCheckScheduler();
  resetRealtime();
  invalidateRateLimitCache();
  _resetCollectionCache();
  await closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const authed = (init: RequestInit = {}) => ({ ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });

describe("routes that read the raw request, through the whole server", () => {
  it("a multipart file upload is stored", async () => {
    const rec = await createRecord("docs", { title: "x" }, null);
    const form = new FormData();
    form.append("file", new File(["hello"], "hello.txt", { type: "text/plain" }));
    const res = await app.handle(new Request(`http://localhost/api/v1/files/docs/${rec.id}/att`, authed({ method: "POST", body: form })));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { filename: string } }).data.filename).toBeString();
  });

  it("a CSV import reads its body", async () => {
    const res = await app.handle(new Request("http://localhost/api/v1/admin/import/docs", authed({
      method: "POST", headers: { "content-type": "text/csv" }, body: "title\nfrom csv\n",
    })));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { created: number } }).data.created).toBe(1);
  });

  it("a restore upload reaches the file, not 'No file uploaded'", async () => {
    const form = new FormData();
    form.append("file", new File(["not a backup"], "junk.tar.gz", { type: "application/gzip" }));
    const res = await app.handle(new Request("http://localhost/api/v1/admin/restore", authed({ method: "POST", body: form })));
    const body = (await res.json()) as { error?: string };
    expect(body.error ?? "").not.toContain("No file uploaded");
  });

  for (const path of ["/api/v1/batch", "/api/v1/batch/"]) it(`a batch to ${path} is still charged per op`, async () => {
    invalidateRateLimitCache();
    const send = () => app.handle(new Request(`http://localhost${path}`, authed({
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requests: Array.from({ length: 100 }, (_, i) => ({ method: "POST", url: "/api/v1/docs", body: { title: `t${i}` } })) }),
    })));
    const first = await send();
    const second = await send();
    invalidateRateLimitCache();
    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });
});
