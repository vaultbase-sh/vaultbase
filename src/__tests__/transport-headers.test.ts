/**
 * - The admin login cookie got `Secure` only when request.url was https, so
 *   behind a TLS-terminating proxy (plain http to Vaultbase) it never did.
 * - Nothing under /api/v1/admin or /api/v1/auth set Cache-Control, so
 *   responses carrying settings secrets, tokens and sessions were
 *   heuristically cacheable by browsers and shared proxies.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import { admin } from "../db/schema.ts";
import { createServer } from "../server.ts";
import { stopScheduler } from "../core/jobs.ts";
import { stopQueueScheduler } from "../core/queues.ts";
import { stopWebhookDispatcher } from "../core/webhooks.ts";
import { stopUpdateCheckScheduler } from "../core/update-check.ts";
import { _reset as resetRealtime } from "../realtime/manager.ts";

const SECRET = "test-secret-transport";
let dir: string;
let server: { stop: (force?: boolean) => unknown; port: number };
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vb-transport-"));
  initDb(":memory:");
  await runMigrations();
  await getDb().insert(admin).values({ id: "a1", email: "a@test.local", password_hash: await Bun.password.hash("admin-pass-12345"), password_reset_at: 0, created_at: 0 });
  const app = createServer({ port: 0, dataDir: dir, dbPath: ":memory:", uploadDir: join(dir, "u"), logsDir: join(dir, "l"), jwtSecret: SECRET, encryptionKey: undefined });
  app.listen({ port: 0, hostname: "127.0.0.1" });
  server = app.server as unknown as typeof server;
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  stopScheduler(); stopQueueScheduler(); stopWebhookDispatcher(); stopUpdateCheckScheduler();
  resetRealtime();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const login = (headers: Record<string, string> = {}) => fetch(`${base}/api/v1/admin/auth/login`, {
  method: "POST", headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ email: "a@test.local", password: "admin-pass-12345" }),
});

describe("admin cookie Secure flag", () => {
  it("is set behind a trusted TLS-terminating proxy", async () => {
    setSetting("security.trusted_proxies", "127.0.0.1");
    const res = await login({ "x-forwarded-proto": "https" });
    expect(res.headers.get("set-cookie")).toContain("Secure");
    setSetting("security.trusted_proxies", "");
  });

  it("is set when the app is configured on https", async () => {
    setSetting("app.url", "https://app.example.com");
    expect((await login()).headers.get("set-cookie")).toContain("Secure");
    setSetting("app.url", "");
  });

  it("isn't set from an untrusted X-Forwarded-Proto on plain http (legitimate dev path)", async () => {
    const res = await login({ "x-forwarded-proto": "https" });
    expect(res.headers.get("set-cookie")).not.toContain("Secure");
  });
});

describe("Cache-Control", () => {
  it("admin and auth responses are no-store", async () => {
    const res = await login();
    expect(res.headers.get("cache-control")).toBe("no-store");
    const token = (await res.json() as { data: { token: string } }).data.token;
    const settings = await fetch(`${base}/api/v1/admin/settings`, { headers: { authorization: `Bearer ${token}` } });
    expect(settings.headers.get("cache-control")).toBe("no-store");
    const me = await fetch(`${base}/api/v1/admin/auth/me`);
    expect(me.status).toBe(401);
    expect(me.headers.get("cache-control")).toBe("no-store");
  });

  it("record reads keep their own caching (ETag revalidation)", async () => {
    const res = await fetch(`${base}/api/v1/health`);
    expect(res.headers.get("cache-control")).not.toBe("no-store");
  });
});
