/**
 * Maintenance mode (core/maintenance-mode.ts): the API closed to clients
 * while admins keep working, reads optionally left open, custom routes
 * opened one by one, realtime closed, and background work paused.
 */
import { describe, expect, it, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import { admin, jobs, routes } from "../db/schema.ts";
import { createServer } from "../server.ts";
import { _jobsTickOnce, stopScheduler } from "../core/jobs.ts";
import { stopQueueScheduler } from "../core/queues.ts";
import { stopWebhookDispatcher } from "../core/webhooks.ts";
import { stopUpdateCheckScheduler } from "../core/update-check.ts";
import { invalidateRoutesCache } from "../core/routes.ts";
import { mintApiToken } from "../core/api-tokens.ts";
import { _reset as resetRealtime, admitConnection, closeConnections, disconnectAll, setWSAuth, trackConnection } from "../realtime/manager.ts";
import {
  DEFAULT_MAINTENANCE_MESSAGE, backgroundPaused, normalizeRouteEntry, validateMaintenanceSetting,
} from "../core/maintenance-mode.ts";
import { createPublicCollection, seedAuthUser, signUserJwt } from "./_helpers.ts";

const SECRET = "test-secret-maintenance";
let dir: string;
let server: { stop: (force?: boolean) => unknown; port: number };
let base: string;
let adminToken: string;
let userToken: string;
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// `enabled` last, as the settings API writes it: the server's maintenance
// sweep runs on a timer, and on Postgres each write is a round trip, so
// enabling first let a sweep close sockets before the message was saved.
const KEYS = ["level", "message", "until", "background", "routes", "enabled"].map((k) => `maintenance_mode.${k}`);
/** Set the maintenance settings (the rest cleared). Awaited: on Postgres a write is async. */
async function maintenance(values: Record<string, string>): Promise<void> {
  for (const k of KEYS) await setSetting(k, values[k.slice("maintenance_mode.".length)] ?? "");
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vb-maintenance-"));
  await initDb(":memory:");
  await runMigrations();
  await getDb().insert(admin).values({ id: "a1", email: "a@test.local", password_hash: await Bun.password.hash("admin-pass-12345"), password_reset_at: 0, created_at: 0 });
  await createPublicCollection({ name: "notes", type: "base", fields: JSON.stringify([{ name: "title", type: "text" }]) });
  const uid = await seedAuthUser({ collection: "users", email: "u@test.local" });
  userToken = await signUserJwt(uid, "u@test.local", "users", SECRET);
  await getDb().insert(routes).values([
    { id: crypto.randomUUID(), name: "status", method: "GET", path: "/status", code: `return { up: true };`, enabled: 1, created_at: now(), updated_at: now() },
    { id: crypto.randomUUID(), name: "other", method: "GET", path: "/other/:id", code: `return { id: ctx.params.id };`, enabled: 1, created_at: now(), updated_at: now() },
  ]);
  invalidateRoutesCache();
  const app = createServer({ port: 0, dataDir: dir, dbPath: ":memory:", uploadDir: join(dir, "u"), logsDir: join(dir, "l"), jwtSecret: SECRET, encryptionKey: undefined });
  app.listen({ port: 0, hostname: "127.0.0.1" });
  server = app.server as unknown as typeof server;
  base = `http://127.0.0.1:${server.port}`;
  const login = await fetch(`${base}/api/v1/admin/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "a@test.local", password: "admin-pass-12345" }),
  });
  adminToken = (await login.json() as { data: { token: string } }).data.token;
});

afterEach(() => maintenance({}));

afterAll(async () => {
  server?.stop(true);
  stopScheduler(); stopQueueScheduler(); stopWebhookDispatcher(); stopUpdateCheckScheduler();
  resetRealtime();
  await closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const list = (headers: Record<string, string> = {}) => fetch(`${base}/api/v1/notes`, { headers });
const create = (headers: Record<string, string> = {}) => fetch(`${base}/api/v1/notes`, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ title: "x" }),
});

describe("off", () => {
  it("changes nothing", async () => {
    expect((await list()).status).toBe(200);
    expect((await create()).status).toBe(200);
    const health = await (await fetch(`${base}/api/health`)).json() as { data: { maintenance: unknown } };
    expect(health.data.maintenance).toBeNull();
  });
});

describe("full", () => {
  it("refuses clients with 503, the message and no caching", async () => {
    await maintenance({ enabled: "1", message: "Upgrading the database" });
    for (const res of [await list(), await create(), await list(bearer(userToken))]) {
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("retry-after")).toBeNull();
      expect(await res.json()).toEqual({ error: "Upgrading the database", code: 503, maintenance: { level: "full" } });
    }
  });

  it("uses a default message, and carries `until` as Retry-After and in the body", async () => {
    const until = now() + 600;
    await maintenance({ enabled: "1", until: String(until) });
    const res = await list();
    const retry = Number(res.headers.get("retry-after"));
    expect(retry).toBeGreaterThan(590);
    expect(retry).toBeLessThanOrEqual(600);
    const body = await res.json() as { error: string; maintenance: { until: number; retry_after: number } };
    expect(body.error).toBe(DEFAULT_MAINTENANCE_MESSAGE);
    expect(body.maintenance.until).toBe(until);
    expect(body.maintenance.retry_after).toBe(retry);
  });

  it("an `until` in the past is no Retry-After (the mode doesn't end by itself)", async () => {
    await maintenance({ enabled: "1", until: String(now() - 60) });
    const res = await list();
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBeNull();
  });

  it("covers the unversioned API and sign-in", async () => {
    await maintenance({ enabled: "1" });
    expect((await fetch(`${base}/api/notes`)).status).toBe(503);
    const signIn = await fetch(`${base}/api/v1/auth/users/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "u@test.local", password: "x" }),
    });
    expect(signIn.status).toBe(503);
  });

  it("lets admins through: session, admin login, admin API and admin API tokens", async () => {
    await maintenance({ enabled: "1" });
    expect((await list(bearer(adminToken))).status).toBe(200);
    expect((await create(bearer(adminToken))).status).toBe(200);
    const login = await fetch(`${base}/api/v1/admin/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@test.local", password: "admin-pass-12345" }),
    });
    expect(login.status).toBe(200);
    expect((await fetch(`${base}/api/v1/admin/settings`, { headers: bearer(adminToken) })).status).toBe(200);
    const { token } = await mintApiToken({ name: "ops", scopes: ["read"], createdBy: "a1", createdByEmail: "a@test.local" }, SECRET);
    expect((await list(bearer(token))).status).toBe(200);
  });

  it("a forged or user token is not an admin", async () => {
    await maintenance({ enabled: "1" });
    expect((await list(bearer("not-a-token"))).status).toBe(503);
    expect((await list(bearer(userToken))).status).toBe(503);
  });

  it("keeps /api/health open and says so", async () => {
    await maintenance({ enabled: "1", level: "read_only" });
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect((await res.json() as { data: { maintenance: string } }).data.maintenance).toBe("read_only");
  });

  it("sends CORS headers on the 503, so a browser app can read it", async () => {
    await setSetting("cors.origins", "https://app.example.com");
    try {
      await maintenance({ enabled: "1" });
      const res = await list({ origin: "https://app.example.com" });
      expect(res.status).toBe(503);
      expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    } finally {
      await setSetting("cors.origins", "");
    }
  });

  it("leaves pages outside the API alone (auth pages, probes)", async () => {
    await maintenance({ enabled: "1" });
    expect((await fetch(`${base}/auth/reset?token=x`)).status).toBe(200);
    expect((await fetch(`${base}/_/health`)).status).toBe(200);
  });
});

describe("read_only", () => {
  it("lets reads through and refuses writes", async () => {
    await maintenance({ enabled: "1", level: "read_only" });
    expect((await list()).status).toBe(200);
    const res = await create();
    expect(res.status).toBe(503);
    expect((await res.json() as { maintenance: { level: string } }).maintenance.level).toBe("read_only");
    expect((await create(bearer(adminToken))).status).toBe(200);
  });
});

describe("custom routes", () => {
  it("are closed in both levels unless listed", async () => {
    for (const level of ["full", "read_only"]) {
      await maintenance({ enabled: "1", level, routes: JSON.stringify(["get /status"]) });
      expect((await fetch(`${base}/api/v1/custom/status`)).status).toBe(200);
      expect((await fetch(`${base}/api/v1/custom/other/7`)).status).toBe(503);
    }
    await maintenance({ enabled: "1", routes: JSON.stringify(["GET /other/:id"]) });
    expect(await (await fetch(`${base}/api/v1/custom/other/7`)).json()).toEqual({ id: "7" });
    expect((await fetch(`${base}/api/v1/custom/other/7`, { headers: bearer(adminToken) })).status).toBe(200);
  });
});

describe("realtime", () => {
  const open = (headers: Record<string, string> = {}, path = "/realtime") => new Promise<{ ws: WebSocket; status: "open" | "refused" }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, { headers } as unknown as string[]);
    ws.onopen = () => resolve({ ws, status: "open" });
    ws.onerror = () => resolve({ ws, status: "refused" });
  });

  it("refuses new connections in full mode, but not in read_only", async () => {
    await maintenance({ enabled: "1" });
    expect((await open()).status).toBe("refused");
    // Routing ignores a trailing slash; the check has to as well.
    expect((await open({}, "/realtime/")).status).toBe("refused");
    await maintenance({ enabled: "1", level: "read_only" });
    const { ws, status } = await open();
    expect(status).toBe("open");
    ws.close();
  });

  it("closes clients' open connections, telling them why", async () => {
    const client = await open();
    expect(client.status).toBe("open");
    const notices: string[] = [];
    client.ws.onmessage = (e) => { notices.push(String(e.data)); };
    const closed = new Promise<void>((r) => { client.ws.onclose = () => r(); });
    await sleep(100);
    await maintenance({ enabled: "1", message: "Back soon" });
    await Promise.race([closed, sleep(5_000)]);
    expect(client.ws.readyState).toBe(WebSocket.CLOSED);
    expect(notices.map((n) => JSON.parse(n))).toContainEqual({ type: "error", reason: "maintenance", message: "Back soon" });
  });

  // On the manager directly: other test files leave servers running whose
  // token re-check (with their own secret) would sign an admin socket out.
  it("closeConnections keeps admin connections and closes the rest", () => {
    const fake = (connId: string) => {
      const sent: string[] = [];
      return { data: { connId }, sent, closed: false, send(m: string) { sent.push(m); }, close() { this.closed = true; } };
    };
    const user = fake(crypto.randomUUID());
    const adm = fake(crypto.randomUUID());
    for (const ws of [user, adm]) { admitConnection(ws.data.connId); trackConnection(ws); }
    setWSAuth(adm, { id: "a1", type: "admin" });
    try {
      const n = closeConnections((auth) => auth?.type === "admin", { type: "error", reason: "maintenance", message: "m" });
      expect(n).toBe(1);
      expect(user.closed).toBe(true);
      expect(user.sent.map((m) => JSON.parse(m))).toEqual([{ type: "error", reason: "maintenance", message: "m" }]);
      expect(adm.closed).toBe(false);
      expect(adm.sent).toEqual([]);
    } finally {
      disconnectAll(user);
      disconnectAll(adm);
    }
  });
});

describe("background work", () => {
  it("pauses by default while the mode is on, and runs when asked", async () => {
    expect(backgroundPaused()).toBe(false);
    await maintenance({ enabled: "1" });
    expect(backgroundPaused()).toBe(true);
    await maintenance({ enabled: "1", background: "run" });
    expect(backgroundPaused()).toBe(false);
  });

  it("a due cron job waits, and runs once when the mode ends", async () => {
    const id = crypto.randomUUID();
    const due = now() - 3600;
    await getDb().insert(jobs).values({ id, name: "nightly", cron: "0 3 * * *", code: `return 1;`, enabled: 1, next_run_at: due, created_at: now(), updated_at: now() });
    await maintenance({ enabled: "1" });
    await _jobsTickOnce();
    let row = (await getDb().select().from(jobs).where(eq(jobs.id, id)))[0]!;
    expect(row.next_run_at).toBe(due);
    expect(row.last_status).toBeNull();
    await maintenance({});
    await _jobsTickOnce();
    row = (await getDb().select().from(jobs).where(eq(jobs.id, id)))[0]!;
    expect(row.next_run_at).toBeGreaterThan(now());
    expect(row.last_status).toBe("ok");
  });
});

describe("settings", () => {
  it("validates each key", () => {
    expect(validateMaintenanceSetting("maintenance_mode.enabled", "1")).toBeNull();
    expect(validateMaintenanceSetting("maintenance_mode.enabled", "yes")).not.toBeNull();
    expect(validateMaintenanceSetting("maintenance_mode.level", "read_only")).toBeNull();
    expect(validateMaintenanceSetting("maintenance_mode.level", "partial")).not.toBeNull();
    expect(validateMaintenanceSetting("maintenance_mode.background", "run")).toBeNull();
    expect(validateMaintenanceSetting("maintenance_mode.message", "x".repeat(501))).not.toBeNull();
    expect(validateMaintenanceSetting("maintenance_mode.until", "")).toBeNull();
    expect(validateMaintenanceSetting("maintenance_mode.until", "tomorrow")).not.toBeNull();
    expect(validateMaintenanceSetting("maintenance_mode.routes", '["GET /status", "post /hooks/:id"]')).toBeNull();
    expect(validateMaintenanceSetting("maintenance_mode.routes", '["/status"]')).not.toBeNull();
    expect(validateMaintenanceSetting("maintenance_mode.routes", "GET /status")).not.toBeNull();
    expect(normalizeRouteEntry(" post  /a/:b ")).toBe("POST /a/:b");
  });

  it("the settings API refuses a bad value", async () => {
    const res = await fetch(`${base}/api/v1/admin/settings`, {
      method: "PATCH", headers: { "content-type": "application/json", ...bearer(adminToken) },
      body: JSON.stringify({ "maintenance_mode.level": "partial" }),
    });
    expect(res.status).toBe(422);
  });
});
