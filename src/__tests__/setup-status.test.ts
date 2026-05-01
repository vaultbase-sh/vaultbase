import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { admin } from "../db/schema.ts";

const SECRET = "test-setup-status";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

async function getStatus(): Promise<{ has_admin: boolean }> {
  const app = makeAuthPlugin(SECRET);
  const res = await app.handle(new Request("http://localhost/admin/setup/status"));
  expect(res.status).toBe(200);
  const body = await res.json() as { data: { has_admin: boolean } };
  return body.data;
}

async function postSetup(email: string, password: string): Promise<Response> {
  const app = makeAuthPlugin(SECRET);
  return app.handle(
    new Request("http://localhost/admin/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    })
  );
}

describe("setup status", () => {
  it("reports has_admin: false on a fresh install", async () => {
    const s = await getStatus();
    expect(s.has_admin).toBe(false);
  });

  it("flips to has_admin: true after the seed admin is created", async () => {
    const before = await getStatus();
    expect(before.has_admin).toBe(false);

    const r = await postSetup("admin@example.com", "super-strong-password");
    expect(r.status).toBe(200);

    const after = await getStatus();
    expect(after.has_admin).toBe(true);
  });

  it("setup endpoint refuses a second call once an admin exists", async () => {
    await postSetup("admin@example.com", "super-strong-password");
    const r = await postSetup("intruder@example.com", "another-strong-password");
    expect(r.status).toBe(400);
    const body = await r.json() as { error: string; code: number };
    expect(body.code).toBe(400);
    // Verify only the original row exists.
    const rows = await getDb().select().from(admin);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe("admin@example.com");
  });

  it("status reflects manual admin inserts (e.g., CLI / migrations)", async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(admin).values({
      id: crypto.randomUUID(),
      email: "ops@example.com",
      password_hash: "$2y$10$dummyhashvalueforsetuptest...",
      created_at: now,
    });
    const s = await getStatus();
    expect(s.has_admin).toBe(true);
  });
});
