/**
 * Test for the admin actions audit log.
 *
 * Drives recordAuditEntry directly + via the makeAuditLogPlugin global
 * onAfterHandle. Confirms:
 *   - state-changing /api/admin/* requests produce audit rows
 *   - GET requests are NOT audited (volume + low value)
 *   - non-admin paths are NOT audited
 *   - skipped paths (login, setup, preview) are NOT audited
 *   - listAuditEntries filters work
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as jose from "jose";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { admin as adminTable, auditLog } from "../db/schema.ts";
import { listAuditEntries, recordAuditEntry } from "../core/audit-log.ts";
import { makeAuditLogPlugin } from "../api/audit-log.ts";

const SECRET = "test-secret-audit-log";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

async function signAdmin(id = "admin-1"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(adminTable).values({
    id,
    email: `${id}@test.local`,
    password_hash: "x",
    password_reset_at: 0,
    created_at: now,
  });
  return await new jose.SignJWT({ id, email: `${id}@test.local`, jti: crypto.randomUUID() })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("vaultbase")
    .setAudience("admin")
    .setIssuedAt(now)
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
}

describe("recordAuditEntry — direct calls", () => {
  it("captures POST /api/admin/<resource> as <resource>.create", async () => {
    await recordAuditEntry({
      request: new Request("http://localhost/api/admin/collections", { method: "POST" }),
      status: 200,
      actor: { id: "a1", email: "a@x" },
    });
    const list = await listAuditEntries();
    expect(list.totalItems).toBe(1);
    expect(list.data[0]?.action).toBe("collections.create");
    expect(list.data[0]?.actor_id).toBe("a1");
    expect(list.data[0]?.method).toBe("POST");
    expect(list.data[0]?.status).toBe(200);
  });

  it("captures DELETE /api/admin/<resource>/<id> with target", async () => {
    await recordAuditEntry({
      request: new Request("http://localhost/api/admin/admins/admin-42", { method: "DELETE" }),
      status: 204,
      actor: { id: "a1", email: "a@x" },
    });
    const list = await listAuditEntries();
    expect(list.data[0]?.action).toBe("admins.delete");
    expect(list.data[0]?.target).toBe("admin-42");
  });

  it("captures PATCH as <resource>.update", async () => {
    await recordAuditEntry({
      request: new Request("http://localhost/api/admin/settings/key1", { method: "PATCH" }),
      status: 200,
      actor: { id: "a1", email: "a@x" },
    });
    const list = await listAuditEntries();
    expect(list.data[0]?.action).toBe("settings.update");
  });

  it("ignores GET requests", async () => {
    await recordAuditEntry({
      request: new Request("http://localhost/api/admin/collections", { method: "GET" }),
      status: 200,
      actor: { id: "a1", email: "a@x" },
    });
    const list = await listAuditEntries();
    expect(list.totalItems).toBe(0);
  });

  it("ignores non-admin paths", async () => {
    await recordAuditEntry({
      request: new Request("http://localhost/api/posts", { method: "POST" }),
      status: 200,
      actor: { id: "a1", email: "a@x" },
    });
    const list = await listAuditEntries();
    expect(list.totalItems).toBe(0);
  });

  it("ignores explicit skip-list paths", async () => {
    for (const path of [
      "/api/admin/auth/login",
      "/api/admin/auth/logout",
      "/api/admin/setup",
      "/api/admin/migrations/diff",
    ]) {
      await recordAuditEntry({
        request: new Request(`http://localhost${path}`, { method: "POST" }),
        status: 200,
        actor: null,
      });
    }
    const list = await listAuditEntries();
    expect(list.totalItems).toBe(0);
  });
});

describe("via makeAuditLogPlugin (Elysia onAfterHandle)", () => {
  it("captures via the plugin global hook", async () => {
    const token = await signAdmin();
    const app = makeAuditLogPlugin(SECRET)
      // mount a no-op admin endpoint so the request lands somewhere.
      .post("/api/v1/admin/things", () => ({ data: { ok: true } }));
    const res = await app.handle(new Request("http://localhost/api/v1/admin/things", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    }));
    expect(res.status).toBe(200);
    // give the void-promised audit insert a tick to land
    await new Promise((r) => setTimeout(r, 20));
    const list = await listAuditEntries();
    expect(list.totalItems).toBeGreaterThanOrEqual(1);
    const entry = list.data.find((e) => e.path === "/api/v1/admin/things");
    expect(entry).toBeTruthy();
    expect(entry?.action).toBe("things.create");
    expect(entry?.actor_id).toBe("admin-1");
    expect(entry?.actor_email).toBe("admin-1@test.local");
  });
});

describe("listAuditEntries — filters", () => {
  beforeEach(async () => {
    await recordAuditEntry({
      request: new Request("http://localhost/api/admin/collections", { method: "POST" }),
      status: 200, actor: { id: "a1", email: "a@x" },
    });
    await recordAuditEntry({
      request: new Request("http://localhost/api/admin/settings", { method: "PATCH" }),
      status: 200, actor: { id: "a2", email: "b@x" },
    });
    await recordAuditEntry({
      request: new Request("http://localhost/api/admin/jobs/j1", { method: "DELETE" }),
      status: 204, actor: { id: "a1", email: "a@x" },
    });
  });

  it("filters by actor", async () => {
    const r = await listAuditEntries({ actorId: "a1" });
    expect(r.totalItems).toBe(2);
    for (const e of r.data) expect(e.actor_id).toBe("a1");
  });

  it("filters by action prefix", async () => {
    const r = await listAuditEntries({ actionPrefix: "collections." });
    expect(r.totalItems).toBe(1);
    expect(r.data[0]?.action).toBe("collections.create");
  });
});

describe("audit log is append-only at the data layer", () => {
  it("never UPDATEs or DELETEs through the audit-log core API", async () => {
    // Sanity — the module exposes only listAuditEntries + recordAuditEntry.
    const mod = await import("../core/audit-log.ts");
    const exports = Object.keys(mod);
    expect(exports).toContain("recordAuditEntry");
    expect(exports).toContain("listAuditEntries");
    for (const name of exports) {
      expect(name.toLowerCase()).not.toMatch(/delete|update|prune/);
    }
    // The DB itself permits raw DML — operators are free to GC the table
    // by hand. That's intentional, not a bug.
    void auditLog;
  });
});
