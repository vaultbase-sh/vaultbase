/**
 * Every admin route goes through the `requireAdmin` guard (src/api/_admin.ts).
 * Sweeps the routes the real server registers, so a new admin route that
 * forgets the option fails here instead of shipping open.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Elysia from "elysia";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { admin as adminTable } from "../db/schema.ts";
import { createServer } from "../server.ts";
import { signAuthToken } from "../core/sec.ts";
import { adminGuard } from "../api/_admin.ts";
import { stopScheduler } from "../core/jobs.ts";
import { stopQueueScheduler } from "../core/queues.ts";
import { stopWebhookDispatcher } from "../core/webhooks.ts";
import { stopUpdateCheckScheduler } from "../core/update-check.ts";
import { _reset as resetRealtime } from "../realtime/manager.ts";

const SECRET = "test-secret-admin-guard";
// Admin-path routes that answer without a token on purpose.
const PUBLIC = new Set([
  "GET /api/v1/admin/setup/status",
  "POST /api/v1/admin/setup",
  "POST /api/v1/admin/auth/login",
  "GET /api/v1/admin/theme",
]);

let dir: string;
let app: ReturnType<typeof createServer>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vb-admin-guard-"));
  await initDb(":memory:");
  await runMigrations();
  await getDb().insert(adminTable).values({ id: "a1", email: "a@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
  app = createServer({ port: 0, dataDir: dir, dbPath: ":memory:", uploadDir: join(dir, "u"), logsDir: join(dir, "l"), jwtSecret: SECRET, encryptionKey: undefined });
});

afterAll(async () => {
  stopScheduler(); stopQueueScheduler(); stopWebhookDispatcher(); stopUpdateCheckScheduler();
  resetRealtime();
  await closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function adminRoutes() {
  const routes = (app as unknown as { routes: { method: string; path: string }[] }).routes;
  return routes.filter((r) => /^\/api\/v1\/(admin\/|collections)/.test(r.path));
}

function requestFor(r: { method: string; path: string }, headers: Record<string, string> = {}) {
  const method = r.method === "ALL" ? "GET" : r.method;
  const path = r.path.replace(/:[A-Za-z_]+/g, "x").replace(/\*$/, "x");
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = "{}";
    init.headers = { ...headers, "content-type": "application/json" };
  }
  return new Request("http://localhost" + path, init);
}

describe("admin routes without a token", () => {
  it("none succeed", async () => {
    const routes = adminRoutes();
    expect(routes.length).toBeGreaterThan(100);
    const open: string[] = [];
    for (const r of routes) {
      const key = `${r.method} ${r.path}`;
      if (PUBLIC.has(key)) continue;
      const res = await app.handle(requestFor(r));
      // 422: Elysia validates the body before the guard runs.
      if (![401, 403, 422].includes(res.status)) open.push(`${res.status} ${key}`);
    }
    expect(open).toEqual([]);
  });

  it("are refused with the usual response headers", async () => {
    const res = await app.handle(new Request("http://localhost/api/v1/admin/settings"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized", code: 401 });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("a user token is refused", async () => {
    const { token } = await signAuthToken({ payload: { id: "u1", collection: "users" }, audience: "user", expiresInSeconds: 60, jwtSecret: SECRET });
    const res = await app.handle(new Request("http://localhost/api/v1/admin/settings", { headers: { authorization: `Bearer ${token}` } }));
    expect(res.status).toBe(401);
  });
});

describe("requireAdmin", () => {
  const tokenFor = async () =>
    (await signAuthToken({ payload: { id: "a1", email: "a@test.local" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET })).token;
  const guarded = () => new Elysia()
    .use(adminGuard(SECRET))
    .get("/h", ({ admin }) => ({ id: admin.id }), { requireAdmin: true })
    .get("/c", ({ admin }) => ({ id: admin.id }), { requireAdmin: { cookie: true } });

  it("hands the handler the admin", async () => {
    const res = await guarded().handle(new Request("http://localhost/h", { headers: { authorization: `Bearer ${await tokenFor()}` } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "a1" });
  });

  it("ignores the session cookie unless the route opts in", async () => {
    const cookie = `vaultbase_admin_token=${await tokenFor()}`;
    const h = await guarded().handle(new Request("http://localhost/h", { headers: { cookie } }));
    expect(h.status).toBe(401);
    const c = await guarded().handle(new Request("http://localhost/c", { headers: { cookie } }));
    expect(c.status).toBe(200);
  });

  it("refuses a cross-site cookie", async () => {
    const cookie = `vaultbase_admin_token=${await tokenFor()}`;
    const res = await guarded().handle(new Request("http://localhost/c", { headers: { cookie, "sec-fetch-site": "cross-site" } }));
    expect(res.status).toBe(401);
  });
});
