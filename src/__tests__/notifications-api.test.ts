import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as jose from "jose";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { admin as adminTable, users as usersTable } from "../db/schema.ts";
import { createCollection } from "../core/collections.ts";
import { setSetting } from "../api/settings.ts";
import { makeNotificationsPlugin } from "../api/notifications.ts";
import { _resetFcmTokenCache } from "../core/notifications.ts";

const JWT_SECRET = "notifications-api-test-secret";

let tmpDir: string;
let origFetch: typeof fetch;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-notify-api-"));
  setLogsDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
  origFetch = globalThis.fetch;
  _resetFcmTokenCache();
  _authColId = null;  // fresh per-test collection cache
});
afterEach(() => {
  globalThis.fetch = origFetch;
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function seedAdmin(email = "admin@x.test"): Promise<{ id: string; token: string }> {
  const id = crypto.randomUUID();
  const hash = await Bun.password.hash("pw");
  await getDb().insert(adminTable).values({
    id, email, password_hash: hash, password_reset_at: 0,
    created_at: Math.floor(Date.now() / 1000),
  });
  const token = await new jose.SignJWT({ id, email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("vaultbase")
    .setAudience("admin")
    .setIssuedAt()
    .setExpirationTime("1h")
    .setJti(crypto.randomUUID())
    .sign(new TextEncoder().encode(JWT_SECRET));
  return { id, token };
}

let _authColId: string | null = null;
async function ensureAuthCollection(): Promise<string> {
  if (_authColId) return _authColId;
  const col = await createCollection({ name: "users", type: "auth", fields: JSON.stringify([]) });
  _authColId = col.id;
  return col.id;
}

async function seedUserToken(userId?: string): Promise<{ id: string; token: string }> {
  const collectionId = await ensureAuthCollection();
  const id = userId ?? crypto.randomUUID();
  const email = `${id}@x.test`;
  const hash = await Bun.password.hash("pw");
  const now = Math.floor(Date.now() / 1000);
  const { ensureAuthCollection: ensureCol } = await import("./_helpers.ts");
  const col = await ensureCol("users");
  void collectionId;
  // Idempotent — second call with the same id is a no-op.
  const existing = (getDb() as unknown as { $client: import("bun:sqlite").Database }).$client
    .prepare(`SELECT id FROM vb_users WHERE id = ?`).get(id);
  if (!existing) {
    const { insertUser } = await import("../core/users-table.ts");
    await insertUser(col, {
      id, email, password_hash: hash,
      email_verified: 1, created_at: now, updated_at: now,
    });
  }
  const token = await new jose.SignJWT({ id, email, collection: "users" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("vaultbase")
    .setAudience("user")
    .setIssuedAt()
    .setExpirationTime("1h")
    .setJti(crypto.randomUUID())
    .sign(new TextEncoder().encode(JWT_SECRET));
  return { id, token };
}

function adminReq(method: string, path: string, token: string | null, body?: unknown): Request {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(`http://localhost${path}`, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function makeServiceAccountJson(): Promise<string> {
  const { privateKey } = await jose.generateKeyPair("RS256", { extractable: true });
  const pkcs8 = await jose.exportPKCS8(privateKey);
  return JSON.stringify({
    type: "service_account",
    project_id: "test-project",
    private_key_id: "k1",
    private_key: pkcs8,
    client_email: "sa@test-project.iam.gserviceaccount.com",
    token_uri: "https://oauth2.googleapis.com/token",
  });
}

// ── auth gating ──────────────────────────────────────────────────────────────

describe("auth", () => {
  it("admin endpoints require admin token", async () => {
    const app = makeNotificationsPlugin(JWT_SECRET);
    const res = await app.handle(adminReq("GET", "/admin/notifications/providers", null));
    expect(res.status).toBe(401);
  });

  it("user device endpoint rejects admin token", async () => {
    const { token } = await seedAdmin();
    const app = makeNotificationsPlugin(JWT_SECRET);
    const res = await app.handle(adminReq("POST", "/notifications/devices", token,
      { token: "x", provider: "fcm", platform: "ios" }));
    // Admin token has audience "admin"; the user endpoint requires "user".
    expect(res.status).toBe(401);
  });
});

// ── GET /admin/notifications/providers ───────────────────────────────────────

describe("GET providers", () => {
  it("returns disabled-empty by default with secrets unset", async () => {
    const { token } = await seedAdmin();
    const app = makeNotificationsPlugin(JWT_SECRET);
    const res = await app.handle(adminReq("GET", "/admin/notifications/providers", token));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.onesignal.enabled).toBe(false);
    expect(body.data.onesignal.api_key_set).toBe(false);
    expect(body.data.fcm.enabled).toBe(false);
    expect(body.data.fcm.service_account_set).toBe(false);
  });

  it("masks secrets — never returns api_key or service_account verbatim", async () => {
    setSetting("notifications.providers.onesignal.api_key", "TOTALLY-SECRET-KEY");
    const sa = await makeServiceAccountJson();
    setSetting("notifications.providers.fcm.service_account", sa);

    const { token } = await seedAdmin();
    const app = makeNotificationsPlugin(JWT_SECRET);
    const res = await app.handle(adminReq("GET", "/admin/notifications/providers", token));
    const body = await res.json() as any;
    const text = JSON.stringify(body);
    expect(text).not.toContain("TOTALLY-SECRET-KEY");
    expect(text).not.toContain("BEGIN PRIVATE KEY");
    expect(body.data.onesignal.api_key_set).toBe(true);
    expect(body.data.fcm.service_account_set).toBe(true);
    expect(body.data.fcm.service_account_client_email).toBe("sa@test-project.iam.gserviceaccount.com");
    expect(body.data.fcm.service_account_bytes).toBeGreaterThan(100);
  });
});

// ── PATCH /admin/notifications/providers/:name ───────────────────────────────

describe("PATCH provider", () => {
  it("updates OneSignal credentials", async () => {
    const { token } = await seedAdmin();
    const app = makeNotificationsPlugin(JWT_SECRET);
    const res = await app.handle(adminReq("PATCH", "/admin/notifications/providers/onesignal", token,
      { enabled: true, app_id: "app-1", api_key: "k-1" }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.onesignal.enabled).toBe(true);
    expect(body.data.onesignal.app_id).toBe("app-1");
    expect(body.data.onesignal.api_key_set).toBe(true);
  });

  it("rejects FCM enable=true without service_account", async () => {
    const { token } = await seedAdmin();
    const app = makeNotificationsPlugin(JWT_SECRET);
    const res = await app.handle(adminReq("PATCH", "/admin/notifications/providers/fcm", token,
      { enabled: true }));
    expect(res.status).toBe(422);
    const body = await res.json() as any;
    expect(body.error).toContain("service_account");
  });

  it("rejects FCM service_account that isn't valid JSON", async () => {
    const { token } = await seedAdmin();
    const app = makeNotificationsPlugin(JWT_SECRET);
    const res = await app.handle(adminReq("PATCH", "/admin/notifications/providers/fcm", token,
      { enabled: true, service_account: "not json" }));
    expect(res.status).toBe(422);
  });

  it("accepts FCM with valid service_account in same patch", async () => {
    const sa = await makeServiceAccountJson();
    const { token } = await seedAdmin();
    const app = makeNotificationsPlugin(JWT_SECRET);
    const res = await app.handle(adminReq("PATCH", "/admin/notifications/providers/fcm", token,
      { enabled: true, project_id: "explicit-proj", service_account: sa }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.fcm.enabled).toBe(true);
    expect(body.data.fcm.project_id).toBe("explicit-proj");
  });

  it("rejects fields wrong for the provider (api_key under fcm)", async () => {
    const { token } = await seedAdmin();
    const app = makeNotificationsPlugin(JWT_SECRET);
    const res = await app.handle(adminReq("PATCH", "/admin/notifications/providers/fcm", token,
      { api_key: "wrong-place" }));
    expect(res.status).toBe(422);
    const body = await res.json() as any;
    expect(body.error).toContain("fcm.api_key");
  });

  it("404 on unknown provider name", async () => {
    const { token } = await seedAdmin();
    const app = makeNotificationsPlugin(JWT_SECRET);
    const res = await app.handle(adminReq("PATCH", "/admin/notifications/providers/twilio", token, { enabled: true }));
    expect(res.status).toBe(404);
  });
});

// ── POST test-connection ─────────────────────────────────────────────────────

describe("POST test-connection", () => {
  it("OneSignal ok on 200", async () => {
    setSetting("notifications.providers.onesignal.enabled", "1");
    setSetting("notifications.providers.onesignal.app_id", "abc");
    setSetting("notifications.providers.onesignal.api_key", "k");
    globalThis.fetch = (async () => new Response('{"name":"OK"}', { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const { token } = await seedAdmin();
    const app = makeNotificationsPlugin(JWT_SECRET);
    const res = await app.handle(adminReq("POST", "/admin/notifications/providers/onesignal/test-connection", token));
    expect(res.status).toBe(200);
  });

  it("OneSignal 422 on auth error", async () => {
    setSetting("notifications.providers.onesignal.enabled", "1");
    setSetting("notifications.providers.onesignal.app_id", "abc");
    setSetting("notifications.providers.onesignal.api_key", "wrong");
    globalThis.fetch = (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch;
    const { token } = await seedAdmin();
    const app = makeNotificationsPlugin(JWT_SECRET);
    const res = await app.handle(adminReq("POST", "/admin/notifications/providers/onesignal/test-connection", token));
    expect(res.status).toBe(422);
  });

  it("FCM ok when token mint succeeds", async () => {
    const sa = await makeServiceAccountJson();
    setSetting("notifications.providers.fcm.enabled", "1");
    setSetting("notifications.providers.fcm.service_account", sa);
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ access_token: "ya29.x", expires_in: 3600 }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
    const { token } = await seedAdmin();
    const app = makeNotificationsPlugin(JWT_SECRET);
    const res = await app.handle(adminReq("POST", "/admin/notifications/providers/fcm/test-connection", token));
    expect(res.status).toBe(200);
  });
});

// ── POST /admin/notifications/test ───────────────────────────────────────────

describe("POST admin/notifications/test", () => {
  it("dispatches to enabled providers (no inbox table → push only)", async () => {
    setSetting("notifications.providers.onesignal.enabled", "1");
    setSetting("notifications.providers.onesignal.app_id", "abc");
    setSetting("notifications.providers.onesignal.api_key", "k");

    const { token } = await seedAdmin();
    const app = makeNotificationsPlugin(JWT_SECRET);
    const res = await app.handle(adminReq("POST", "/admin/notifications/test", token,
      { userId: "user-123" }));
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.inboxRowId).toBeNull();
    expect(body.data.enqueued).toHaveLength(1);
    expect(body.data.enqueued[0].provider).toBe("onesignal");
  });

  it("opts.providers restricts the fan-out", async () => {
    setSetting("notifications.providers.onesignal.enabled", "1");
    setSetting("notifications.providers.onesignal.app_id", "abc");
    setSetting("notifications.providers.onesignal.api_key", "k");
    setSetting("notifications.providers.fcm.enabled", "1");
    setSetting("notifications.providers.fcm.service_account", await makeServiceAccountJson());

    const { token } = await seedAdmin();
    const app = makeNotificationsPlugin(JWT_SECRET);
    const res = await app.handle(adminReq("POST", "/admin/notifications/test", token,
      { userId: "user-123", providers: ["onesignal"] }));
    const body = await res.json() as any;
    expect(body.data.enqueued.map((j: any) => j.provider)).toEqual(["onesignal"]);
  });
});

// ── POST /notifications/devices (user) ───────────────────────────────────────

describe("POST notifications/devices", () => {
  beforeEach(() => {
    const client = (getDb() as unknown as { $client: import("bun:sqlite").Database }).$client;
    client.exec(`
      CREATE TABLE vb_device_tokens (
        id TEXT PRIMARY KEY, user TEXT NOT NULL, provider TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE, platform TEXT NOT NULL, app_version TEXT,
        enabled INTEGER NOT NULL DEFAULT 1, last_seen INTEGER NOT NULL, created_at INTEGER NOT NULL
      )`);
  });

  it("upserts a new token", async () => {
    const user = await seedUserToken();
    const app = makeNotificationsPlugin(JWT_SECRET);
    const res = await app.handle(adminReq("POST", "/notifications/devices", user.token,
      { token: "fcm-token-1", provider: "fcm", platform: "ios", app_version: "1.2.3" }));
    expect(res.status).toBe(200);

    const client = (getDb() as unknown as { $client: import("bun:sqlite").Database }).$client;
    const row = client.prepare(`SELECT * FROM vb_device_tokens WHERE token=?`).get("fcm-token-1") as any;
    expect(row.user).toBe(user.id);
    expect(row.provider).toBe("fcm");
    expect(row.platform).toBe("ios");
    expect(row.app_version).toBe("1.2.3");
    expect(row.enabled).toBe(1);
  });

  it("re-registering the same token rebinds to the new user (and re-enables)", async () => {
    const userA = await seedUserToken("user-a");
    const userB = await seedUserToken("user-b");
    const app = makeNotificationsPlugin(JWT_SECRET);

    await app.handle(adminReq("POST", "/notifications/devices", userA.token,
      { token: "shared-device", provider: "fcm", platform: "android" }));
    // User A logs out (enabled=0 via DELETE — exercised below); then User B logs in on same device.
    await app.handle(adminReq("DELETE", `/notifications/devices/shared-device`, userA.token));
    await app.handle(adminReq("POST", "/notifications/devices", userB.token,
      { token: "shared-device", provider: "fcm", platform: "android" }));

    const client = (getDb() as unknown as { $client: import("bun:sqlite").Database }).$client;
    const row = client.prepare(`SELECT * FROM vb_device_tokens WHERE token=?`).get("shared-device") as any;
    expect(row.user).toBe("user-b");
    expect(row.enabled).toBe(1);
  });

  it("rejects unknown provider", async () => {
    const user = await seedUserToken();
    const app = makeNotificationsPlugin(JWT_SECRET);
    const res = await app.handle(adminReq("POST", "/notifications/devices", user.token,
      { token: "x", provider: "onesignal", platform: "ios" }));
    expect(res.status).toBe(422);
  });

  it("503 when vb_device_tokens is missing (notifications not bootstrapped)", async () => {
    const client = (getDb() as unknown as { $client: import("bun:sqlite").Database }).$client;
    client.exec(`DROP TABLE vb_device_tokens`);
    const user = await seedUserToken();
    const app = makeNotificationsPlugin(JWT_SECRET);
    const res = await app.handle(adminReq("POST", "/notifications/devices", user.token,
      { token: "x", provider: "fcm", platform: "ios" }));
    expect(res.status).toBe(503);
  });
});

// ── DELETE /notifications/devices/:token ─────────────────────────────────────

describe("DELETE notifications/devices/:token", () => {
  beforeEach(() => {
    const client = (getDb() as unknown as { $client: import("bun:sqlite").Database }).$client;
    client.exec(`
      CREATE TABLE vb_device_tokens (
        id TEXT PRIMARY KEY, user TEXT NOT NULL, provider TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE, platform TEXT NOT NULL, app_version TEXT,
        enabled INTEGER NOT NULL DEFAULT 1, last_seen INTEGER NOT NULL, created_at INTEGER NOT NULL
      )`);
  });

  it("only flips enabled=0 for the calling user's own token", async () => {
    const user = await seedUserToken("user-a");
    const other = await seedUserToken("user-b");
    const client = (getDb() as unknown as { $client: import("bun:sqlite").Database }).$client;
    const now = Math.floor(Date.now() / 1000);
    client.prepare(`INSERT INTO vb_device_tokens (id, user, provider, token, platform, enabled, last_seen, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .run("a", "user-a", "fcm", "tok-a", "ios", now, now);
    client.prepare(`INSERT INTO vb_device_tokens (id, user, provider, token, platform, enabled, last_seen, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .run("b", "user-b", "fcm", "tok-b", "ios", now, now);

    const app = makeNotificationsPlugin(JWT_SECRET);
    // user-a tries to delete user-b's token
    await app.handle(adminReq("DELETE", `/notifications/devices/tok-b`, user.token));
    // user-b's token is untouched
    const rowB = client.prepare(`SELECT enabled FROM vb_device_tokens WHERE token=?`).get("tok-b") as { enabled: number };
    expect(rowB.enabled).toBe(1);

    // user-b deletes their own token — works
    await app.handle(adminReq("DELETE", `/notifications/devices/tok-b`, other.token));
    const rowB2 = client.prepare(`SELECT enabled FROM vb_device_tokens WHERE token=?`).get("tok-b") as { enabled: number };
    expect(rowB2.enabled).toBe(0);
  });
});
