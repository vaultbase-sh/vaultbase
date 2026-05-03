import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as jose from "jose";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { admin as adminTable } from "../db/schema.ts";
import { createCollection, getCollection, parseFields, _resetCollectionCache } from "../core/collections.ts";
import { bootstrapNotificationCollections } from "../core/notifications.ts";
import { makeNotificationsPlugin } from "../api/notifications.ts";

const JWT_SECRET = "bootstrap-test-secret";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-notify-bs-"));
  setLogsDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
  // Module-level collection cache survives across tests — must reset.
  _resetCollectionCache();
  // Auth collection is required because bootstrap creates relations targeting "users".
  await createCollection({ name: "users", type: "auth", fields: JSON.stringify([]) });
});
afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function adminToken(): Promise<string> {
  const id = crypto.randomUUID();
  const hash = await Bun.password.hash("pw");
  await getDb().insert(adminTable).values({
    id, email: "a@x.test", password_hash: hash, password_reset_at: 0,
    created_at: Math.floor(Date.now() / 1000),
  });
  return new jose.SignJWT({ id, email: "a@x.test" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("vaultbase")
    .setAudience("admin")
    .setIssuedAt()
    .setExpirationTime("1h")
    .setJti(crypto.randomUUID())
    .sign(new TextEncoder().encode(JWT_SECRET));
}

describe("bootstrapNotificationCollections", () => {
  it("creates both collections on first call", async () => {
    const r = await bootstrapNotificationCollections();
    expect(r.created.sort()).toEqual(["device_tokens", "notifications"]);
    expect(r.skipped).toEqual([]);

    const notif = await getCollection("notifications");
    const dt = await getCollection("device_tokens");
    expect(notif).not.toBeNull();
    expect(dt).not.toBeNull();
  });

  it("notifications collection has expected fields and rules", async () => {
    await bootstrapNotificationCollections();
    const notif = (await getCollection("notifications"))!;
    expect(notif.list_rule).toBe("user = @request.auth.id");
    expect(notif.view_rule).toBe("user = @request.auth.id");
    expect(notif.update_rule).toBe("user = @request.auth.id");
    const fields = parseFields(notif.fields).map((f) => f.name).sort();
    // Field set; created_at/updated_at are added implicitly by createUserTable.
    expect(fields).toEqual(["body", "data", "read_at", "title", "type", "user"]);
  });

  it("device_tokens collection has token UNIQUE + admin-only rules", async () => {
    await bootstrapNotificationCollections();
    const dt = (await getCollection("device_tokens"))!;
    expect(dt.list_rule).toBe("");   // admin-only
    const fields = parseFields(dt.fields);
    const token = fields.find((f) => f.name === "token");
    expect(token?.options?.unique).toBe(true);
    const provider = fields.find((f) => f.name === "provider");
    expect(provider?.options?.values).toEqual(["fcm", "apns"]);
  });

  it("creates the underlying SQL tables (vb_notifications, vb_device_tokens)", async () => {
    await bootstrapNotificationCollections();
    const client = (getDb() as unknown as { $client: import("bun:sqlite").Database }).$client;
    const rows = client
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('vb_notifications','vb_device_tokens')`)
      .all() as Array<{ name: string }>;
    expect(rows.map((r) => r.name).sort()).toEqual(["vb_device_tokens", "vb_notifications"]);
  });

  it("is idempotent on repeated calls", async () => {
    await bootstrapNotificationCollections();
    const second = await bootstrapNotificationCollections();
    expect(second.created).toEqual([]);
    expect(second.skipped.sort()).toEqual(["device_tokens", "notifications"]);
  });

  it("skips a collection that the operator created themselves with the same name", async () => {
    // Operator pre-created "notifications" with their own shape.
    await createCollection({
      name: "notifications",
      type: "base",
      fields: JSON.stringify([{ name: "custom_field", type: "text" }]),
    });
    const r = await bootstrapNotificationCollections();
    expect(r.created).toEqual(["device_tokens"]);
    expect(r.skipped).toEqual(["notifications"]);
    // The user's collection is preserved verbatim (we don't try to merge fields).
    const existing = (await getCollection("notifications"))!;
    const fields = parseFields(existing.fields).map((f) => f.name);
    expect(fields).toContain("custom_field");
  });
});

// ── PATCH endpoint: triggers bootstrap on enable ─────────────────────────────

describe("PATCH provider triggers bootstrap on enable", () => {
  it("creates collections on first enable", async () => {
    const token = await adminToken();
    const app = makeNotificationsPlugin(JWT_SECRET);
    const res = await app.handle(new Request(
      "http://localhost/admin/notifications/providers/onesignal",
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, app_id: "a", api_key: "k" }),
      },
    ));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown; bootstrap?: { created: string[]; skipped: string[] } };
    expect(body.bootstrap?.created.sort()).toEqual(["device_tokens", "notifications"]);

    const notif = await getCollection("notifications");
    expect(notif).not.toBeNull();
  });

  it("does not bootstrap on disable", async () => {
    // First, enable + bootstrap.
    const token = await adminToken();
    const app = makeNotificationsPlugin(JWT_SECRET);
    await app.handle(new Request(
      "http://localhost/admin/notifications/providers/onesignal",
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, app_id: "a", api_key: "k" }),
      },
    ));
    // Then disable.
    const res = await app.handle(new Request(
      "http://localhost/admin/notifications/providers/onesignal",
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
    ));
    const body = await res.json() as { data: unknown; bootstrap?: unknown };
    expect(body.bootstrap).toBeUndefined();
  });
});
