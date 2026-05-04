/**
 * /api/v1/admin/collections/stats — per-collection counts + activity for
 * the Collections admin page. Verifies record counts, lastUpdated,
 * recentWrites, and the COUNT_CAP saturation flag.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import Elysia from "elysia";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { initDb, closeDb, getDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { admin } from "../db/schema.ts";
import { signAuthToken } from "../core/sec.ts";
import { createCollection } from "../core/collections.ts";
import { makeCollectionsPlugin } from "../api/collections.ts";

const SECRET = "test-secret-collections-stats";
let tmpDir: string;

async function seedAdmin(): Promise<string> {
  const id = "a1";
  const email = "ops@test.local";
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(admin).values({
    id, email, password_hash: "x", password_reset_at: 0, created_at: now,
  });
  const { token } = await signAuthToken({
    payload: { id, email },
    audience: "admin",
    expiresInSeconds: 3600,
    jwtSecret: SECRET,
  });
  return token;
}

function mkApp(): Elysia {
  return new Elysia().group("/api/v1", (app) => app.use(makeCollectionsPlugin(SECRET))) as unknown as Elysia;
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-cs-"));
  setLogsDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => {
  closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* swallow */ }
});

describe("GET /admin/collections/stats", () => {
  it("requires admin auth", async () => {
    const app = mkApp();
    const res = await app.handle(new Request("http://localhost/api/v1/admin/collections/stats"));
    expect(res.status).toBe(403);
  });

  it("returns recordCount + lastUpdated + recentWrites for base collections", async () => {
    const tok = await seedAdmin();
    await createCollection({
      name: "posts", type: "base",
      fields: JSON.stringify([{ name: "title", type: "text" }]),
      view_rule: null,
    });
    const now = Math.floor(Date.now() / 1000);
    const c = getRawClient();
    c.prepare(`INSERT INTO vb_posts (id, title, created_at, updated_at) VALUES ('p1', 'a', ?, ?)`).run(now - 7200, now - 7200);
    c.prepare(`INSERT INTO vb_posts (id, title, created_at, updated_at) VALUES ('p2', 'b', ?, ?)`).run(now - 1800, now - 1800);
    c.prepare(`INSERT INTO vb_posts (id, title, created_at, updated_at) VALUES ('p3', 'c', ?, ?)`).run(now, now);

    const app = mkApp();
    const res = await app.handle(new Request("http://localhost/api/v1/admin/collections/stats", {
      headers: { Authorization: `Bearer ${tok}` },
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ name: string; recordCount: number; recentWrites: number; lastUpdated: number; recordCountCapped: boolean }>; windowSec: number };
    expect(body.windowSec).toBe(86400);
    const posts = body.data.find((s) => s.name === "posts");
    expect(posts?.recordCount).toBe(3);
    expect(posts?.recordCountCapped).toBe(false);
    expect(posts?.recentWrites).toBe(3);  // all within 24h window
    expect(posts?.lastUpdated).toBeGreaterThanOrEqual(now - 1);
  });

  it("returns null counts for view collections", async () => {
    const tok = await seedAdmin();
    await createCollection({
      name: "posts", type: "base",
      fields: JSON.stringify([{ name: "title", type: "text" }]),
      view_rule: null,
    });
    await createCollection({
      name: "live_posts", type: "view",
      view_query: "SELECT id, title FROM vb_posts",
      fields: JSON.stringify([]),
    });
    const app = mkApp();
    const res = await app.handle(new Request("http://localhost/api/v1/admin/collections/stats", {
      headers: { Authorization: `Bearer ${tok}` },
    }));
    const body = (await res.json()) as { data: Array<{ name: string; recordCount: number | null; type: string }> };
    const view = body.data.find((s) => s.name === "live_posts");
    expect(view?.type).toBe("view");
    expect(view?.recordCount).toBeNull();
  });

  it("auth collections expose counts (with auth columns inline)", async () => {
    const tok = await seedAdmin();
    await createCollection({
      name: "members", type: "auth",
      fields: JSON.stringify([]), view_rule: null,
    });
    const now = Math.floor(Date.now() / 1000);
    getRawClient().prepare(
      `INSERT INTO vb_members (id, email, password_hash, created_at, updated_at) VALUES ('m1', 'a@x.com', 'h', ?, ?)`,
    ).run(now, now);
    getRawClient().prepare(
      `INSERT INTO vb_members (id, email, password_hash, created_at, updated_at) VALUES ('m2', 'b@x.com', 'h', ?, ?)`,
    ).run(now - 7200, now - 7200);

    const app = mkApp();
    const res = await app.handle(new Request("http://localhost/api/v1/admin/collections/stats", {
      headers: { Authorization: `Bearer ${tok}` },
    }));
    const body = (await res.json()) as { data: Array<{ name: string; recordCount: number; recentWrites: number }> };
    const members = body.data.find((s) => s.name === "members");
    expect(members?.recordCount).toBe(2);
    expect(members?.recentWrites).toBe(2);
  });

  it("recentWrites only counts rows within the last 24h", async () => {
    const tok = await seedAdmin();
    await createCollection({
      name: "logs", type: "base",
      fields: JSON.stringify([{ name: "msg", type: "text" }]),
      view_rule: null,
    });
    const now = Math.floor(Date.now() / 1000);
    const week_ago = now - 7 * 86400;
    const c = getRawClient();
    c.prepare(`INSERT INTO vb_logs (id, msg, created_at, updated_at) VALUES ('l1', 'old', ?, ?)`).run(week_ago, week_ago);
    c.prepare(`INSERT INTO vb_logs (id, msg, created_at, updated_at) VALUES ('l2', 'new', ?, ?)`).run(now, now);

    const app = mkApp();
    const res = await app.handle(new Request("http://localhost/api/v1/admin/collections/stats", {
      headers: { Authorization: `Bearer ${tok}` },
    }));
    const body = (await res.json()) as { data: Array<{ name: string; recordCount: number; recentWrites: number }> };
    const logs = body.data.find((s) => s.name === "logs");
    expect(logs?.recordCount).toBe(2);
    expect(logs?.recentWrites).toBe(1);
  });
});
