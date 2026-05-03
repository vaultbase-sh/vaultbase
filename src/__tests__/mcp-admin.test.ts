/**
 * /api/v1/admin/mcp/* — admin REST surface backing the /_/mcp SPA page.
 *
 * Live SSE clients: registry is in-memory so we drive it directly here.
 * Catalog: drives the real plugin to ensure tools/resources/prompts are
 * enumerated.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import Elysia from "elysia";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { admin } from "../db/schema.ts";
import { signAuthToken } from "../core/sec.ts";
import { createCollection } from "../core/collections.ts";
import { makeMcpAdminPlugin } from "../api/mcp-admin.ts";
import { registerMcpEventClient, unregisterMcpEventClient } from "../mcp/events.ts";

const SECRET = "test-secret-mcp-admin";
let tmpDir: string;

async function seedAdmin(): Promise<{ id: string; email: string }> {
  const id = "a1";
  const email = "ops@test.local";
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(admin).values({
    id, email, password_hash: "x", password_reset_at: 0, created_at: now,
  });
  return { id, email };
}

async function adminToken(adminId: string, adminEmail: string): Promise<string> {
  const { token } = await signAuthToken({
    payload: { id: adminId, email: adminEmail },
    audience: "admin",
    expiresInSeconds: 3600,
    jwtSecret: SECRET,
  });
  return token;
}

function mkApp(): Elysia {
  return new Elysia().group("/api/v1", (app) => app.use(makeMcpAdminPlugin(SECRET))) as unknown as Elysia;
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-mcp-admin-"));
  setLogsDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /admin/mcp/clients", () => {
  it("requires admin auth", async () => {
    const app = mkApp();
    const res = await app.handle(new Request("http://localhost/api/v1/admin/mcp/clients"));
    expect(res.status).toBe(401);
  });

  it("returns empty when nothing is connected", async () => {
    const a = await seedAdmin();
    const tok = await adminToken(a.id, a.email);
    const app = mkApp();
    const res = await app.handle(new Request("http://localhost/api/v1/admin/mcp/clients", {
      headers: { Authorization: `Bearer ${tok}` },
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);
  });

  it("lists registered SSE clients", async () => {
    const a = await seedAdmin();
    const tok = await adminToken(a.id, a.email);
    const app = mkApp();

    const id = registerMcpEventClient({
      tokenId: "tok-1",
      tokenName: "claude-desktop",
      scopes: ["mcp:read"],
      adminId: a.id,
      adminEmail: a.email,
      ip: "10.0.0.1",
      userAgent: "Claude/1.0",
      connectedAt: Math.floor(Date.now() / 1000),
      send: () => {},
    });

    try {
      const res = await app.handle(new Request("http://localhost/api/v1/admin/mcp/clients", {
        headers: { Authorization: `Bearer ${tok}` },
      }));
      const body = (await res.json()) as { data: Array<{ tokenName: string; ip: string }> };
      expect(body.data).toHaveLength(1);
      expect(body.data[0]!.tokenName).toBe("claude-desktop");
      expect(body.data[0]!.ip).toBe("10.0.0.1");
    } finally {
      unregisterMcpEventClient(id);
    }
  });
});

describe("GET /admin/mcp/catalog", () => {
  it("requires admin auth", async () => {
    const app = mkApp();
    const res = await app.handle(new Request("http://localhost/api/v1/admin/mcp/catalog"));
    expect(res.status).toBe(401);
  });

  it("returns tools / resources / prompts with counts", async () => {
    const a = await seedAdmin();
    const tok = await adminToken(a.id, a.email);
    // Seed a collection so per-collection tools materialise.
    await createCollection({
      name: "posts", type: "base",
      fields: JSON.stringify([{ name: "title", type: "text", required: true }]),
      view_rule: null,
    });
    const app = mkApp();
    const res = await app.handle(new Request("http://localhost/api/v1/admin/mcp/catalog", {
      headers: { Authorization: `Bearer ${tok}` },
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        tools: Array<{ name: string }>;
        resources: Array<{ uri: string }>;
        resourceTemplates: Array<{ uriTemplate: string }>;
        prompts: Array<{ name: string }>;
        counts: { tools: number; resources: number; templates: number; prompts: number };
      };
    };
    const toolNames = body.data.tools.map((t) => t.name);
    expect(toolNames).toContain("vaultbase.list_collections");
    expect(toolNames).toContain("vaultbase.list_posts");
    expect(body.data.resources.map((r) => r.uri)).toContain("vaultbase://collections");
    expect(body.data.resourceTemplates.map((r) => r.uriTemplate)).toContain("vaultbase://collection/{name}");
    expect(body.data.prompts.map((p) => p.name)).toContain("design-collection");
    expect(body.data.counts.tools).toBe(toolNames.length);
    expect(body.data.counts.prompts).toBeGreaterThan(0);
  });
});
