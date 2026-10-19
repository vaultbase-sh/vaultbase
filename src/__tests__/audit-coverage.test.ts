/**
 * Every state-changing admin call leaves an audit row. The audit plugin's
 * hooks only cover routes registered after it, and it was mounted halfway
 * down the /api/v1 group: settings, hooks, admins, backups and more were
 * never recorded. Collection writes live outside /admin and were skipped too.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { admin as adminTable, auditLog } from "../db/schema.ts";
import { createServer } from "../server.ts";
import { signAuthToken } from "../core/sec.ts";
import { stopScheduler } from "../core/jobs.ts";
import { stopQueueScheduler } from "../core/queues.ts";
import { stopWebhookDispatcher } from "../core/webhooks.ts";
import { stopUpdateCheckScheduler } from "../core/update-check.ts";
import { _reset as resetRealtime } from "../realtime/manager.ts";

const SECRET = "test-secret-audit-coverage";
let dir: string;
let app: ReturnType<typeof createServer>;
let token: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vb-audit-coverage-"));
  await initDb(":memory:");
  await runMigrations();
  await getDb().insert(adminTable).values({ id: "a1", email: "a@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
  app = createServer({ port: 0, dataDir: dir, dbPath: ":memory:", uploadDir: join(dir, "u"), logsDir: join(dir, "l"), jwtSecret: SECRET, encryptionKey: undefined });
  token = (await signAuthToken({ payload: { id: "a1", email: "a@test.local" }, audience: "admin", expiresInSeconds: 600, jwtSecret: SECRET })).token;
});

afterAll(async () => {
  stopScheduler(); stopQueueScheduler(); stopWebhookDispatcher(); stopUpdateCheckScheduler();
  resetRealtime();
  await closeDb();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
});

async function send(method: string, path: string, body: unknown): Promise<number> {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return res.status;
}

async function actions(): Promise<string[]> {
  await Bun.sleep(30); // rows are written after the response
  return (await getDb().select().from(auditLog)).map((r) => r.action);
}

describe("audit log coverage", () => {
  it("records settings, hooks, admins and collections", async () => {
    expect(await send("PATCH", "/api/v1/admin/settings", { "logs.retention_days": "14" })).toBe(200);
    expect(await send("POST", "/api/v1/admin/hooks", { name: "h", collection_name: "", event: "beforeCreate", code: "return;", enabled: false })).toBeLessThan(300);
    expect(await send("POST", "/api/v1/admin/admins", { email: "b@test.local", password: "a-long-enough-password-1" })).toBeLessThan(300);
    expect(await send("POST", "/api/v1/collections", { name: "audited", fields: [{ name: "t", type: "text" }] })).toBeLessThan(300);
    const seen = await actions();
    expect(seen).toContain("settings.update");
    expect(seen).toContain("hooks.create");
    expect(seen).toContain("admins.create");
    expect(seen).toContain("collections.create");
  });

  it("reads stay out of the audit log (legitimate path)", async () => {
    const before = (await actions()).length;
    const res = await app.handle(new Request("http://localhost/api/v1/admin/settings", { headers: { authorization: `Bearer ${token}` } }));
    expect(res.status).toBe(200);
    expect((await actions()).length).toBe(before);
  });
});
