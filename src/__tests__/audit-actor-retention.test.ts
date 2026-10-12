/**
 * The audit log read the admin only from `Authorization`, so actions by an
 * admin signed in with the session cookie (the admin UI) were recorded with
 * no actor. And audit rows were kept forever with no way to bound them.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import Elysia from "elysia";
import { initDb, closeDb, getDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { admin, auditLog } from "../db/schema.ts";
import { makeAuditLogPlugin } from "../api/audit-log.ts";
import { signAuthToken } from "../core/sec.ts";
import { setSetting } from "../api/settings.ts";
import { pruneHistory } from "../core/maintenance.ts";

const SECRET = "test-secret-audit-actor";
let token: string;

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  await getDb().insert(admin).values({ id: "a1", email: "a1@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
  token = (await signAuthToken({ payload: { id: "a1", email: "a1@test.local" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET })).token;
});

afterEach(() => closeDb());

const app = () => new Elysia().use(makeAuditLogPlugin(SECRET)).post("/api/v1/admin/collections", () => ({ data: { ok: true } }));

async function actors(): Promise<Array<string | null>> {
  await Bun.sleep(20); // the entry is written without awaiting
  return (await getDb().select().from(auditLog)).map((r) => r.actor_id);
}

describe("audit actor", () => {
  it("records the admin behind a same-origin session cookie", async () => {
    await app().handle(new Request("http://localhost/api/v1/admin/collections", {
      method: "POST",
      headers: { cookie: `vaultbase_admin_token=${token}`, "sec-fetch-site": "same-origin" },
    }));
    expect(await actors()).toEqual(["a1"]);
  });

  it("records the admin behind a bearer token (legitimate path)", async () => {
    await app().handle(new Request("http://localhost/api/v1/admin/collections", {
      method: "POST", headers: { authorization: `Bearer ${token}` },
    }));
    expect(await actors()).toEqual(["a1"]);
  });
});

describe("audit retention", () => {
  const insertAt = (id: string, at: number) => getRawClient().prepare(
    `INSERT INTO vaultbase_audit_log (id, method, path, action, status, at) VALUES (?, 'POST', '/x', 'x', 200, ?)`,
  ).run(id, at);

  it("keeps everything by default", async () => {
    insertAt("old", 1);
    await pruneHistory();
    expect((await getDb().select().from(auditLog)).length).toBe(1);
  });

  it("drops entries older than audit.retention_days when set", async () => {
    const now = Math.floor(Date.now() / 1000);
    insertAt("old", now - 40 * 86400);
    insertAt("new", now - 86400);
    setSetting("audit.retention_days", "30");
    const r = await pruneHistory();
    expect(r.auditEntries).toBe(1);
    expect((await getDb().select().from(auditLog)).map((x) => x.id)).toEqual(["new"]);
  });
});
