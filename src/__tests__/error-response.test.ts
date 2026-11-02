/**
 * An error no handler answered went out as Elysia's default: the raw message
 * as text/plain, without the security or CORS headers. It is now JSON in the
 * API's `{ error, code }` shape, with the usual headers.
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

let dir: string;
let app: ReturnType<typeof createServer>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vb-error-response-"));
  await initDb(":memory:");
  await runMigrations();
  app = createServer({ port: 0, dataDir: dir, dbPath: ":memory:", uploadDir: join(dir, "u"), logsDir: join(dir, "l"), jwtSecret: "test-secret-error-response", encryptionKey: undefined });
});

afterAll(async () => {
  stopScheduler(); stopQueueScheduler(); stopWebhookDispatcher(); stopUpdateCheckScheduler();
  resetRealtime();
  await closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("unanswered errors", () => {
  it("a body that fails the route's schema gets JSON with the field, and the security headers", async () => {
    const res = await app.handle(new Request("http://localhost/api/v1/realtime", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: 5, topics: "nope" }),
    }));
    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = (await res.json()) as { error: string; code: number; details?: Record<string, string> };
    expect(body.code).toBe(422);
    expect(body.error).toBe("Validation failed");
    expect(Object.keys(body.details ?? {}).length).toBeGreaterThan(0);
  });

  it("a body that isn't JSON gets a 400 in the same shape", async () => {
    const res = await app.handle(new Request("http://localhost/api/v1/realtime", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(400);
  });
});
