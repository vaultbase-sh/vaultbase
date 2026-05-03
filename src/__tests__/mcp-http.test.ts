/**
 * MCP Phase-3 — HTTP transport at /api/v1/mcp.
 *
 * Drives the Elysia plugin through `app.handle(Request)` so we exercise
 * the real auth path (extractBearer → verifyAuthToken → scope check),
 * dispatcher build, and JSON-RPC framing — without binding a port.
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
import { mintApiToken } from "../core/api-tokens.ts";
import { makeMcpPlugin } from "../api/mcp.ts";

const SECRET = "test-secret-mcp-http";
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

function mkApp(): Elysia {
  // The plugin attaches to /api/v1 but Elysia's generic type chain bloats
  // through .group() — the cast keeps test signatures readable.
  return new Elysia().group("/api/v1", (app) => app.use(makeMcpPlugin(SECRET))) as unknown as Elysia;
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-mcp-http-"));
  setLogsDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function rpc(app: Elysia, body: unknown, token: string | null): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return await app.handle(
    new Request("http://localhost/api/v1/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

describe("MCP HTTP transport", () => {
  it("returns 401 without a token", async () => {
    const app = mkApp();
    const res = await rpc(app, { jsonrpc: "2.0", id: 1, method: "ping" }, null);
    expect(res.status).toBe(401);
  });

  it("returns 401 for an invalid token", async () => {
    const app = mkApp();
    const res = await rpc(app, { jsonrpc: "2.0", id: 1, method: "ping" }, "vbat_garbage");
    expect(res.status).toBe(401);
  });

  it("returns 403 when token lacks any mcp:* scope", async () => {
    const a = await seedAdmin();
    const { token } = await mintApiToken({
      name: "no-mcp", scopes: ["read"], ttlSeconds: 600,
      createdBy: a.id, createdByEmail: a.email,
    }, SECRET);
    const app = mkApp();
    const res = await rpc(app, { jsonrpc: "2.0", id: 1, method: "ping" }, token);
    expect(res.status).toBe(403);
  });

  it("ping with valid mcp:read token returns {}", async () => {
    const a = await seedAdmin();
    const { token } = await mintApiToken({
      name: "claude", scopes: ["mcp:read"], ttlSeconds: 600,
      createdBy: a.id, createdByEmail: a.email,
    }, SECRET);
    const app = mkApp();
    const res = await rpc(app, { jsonrpc: "2.0", id: 1, method: "ping" }, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jsonrpc: string; id: number; result: unknown };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result).toEqual({});
  });

  it("initialize advertises tools + resources + prompts", async () => {
    const a = await seedAdmin();
    const { token } = await mintApiToken({
      name: "claude", scopes: ["mcp:read"], ttlSeconds: 600,
      createdBy: a.id, createdByEmail: a.email,
    }, SECRET);
    const app = mkApp();
    const res = await rpc(app, { jsonrpc: "2.0", id: 2, method: "initialize", params: {} }, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { capabilities: Record<string, unknown> } };
    expect(body.result.capabilities.tools).toBeTruthy();
    expect(body.result.capabilities.resources).toBeTruthy();
    expect(body.result.capabilities.prompts).toBeTruthy();
  });

  it("notifications/initialized returns 204 (no body)", async () => {
    const a = await seedAdmin();
    const { token } = await mintApiToken({
      name: "claude", scopes: ["mcp:read"], ttlSeconds: 600,
      createdBy: a.id, createdByEmail: a.email,
    }, SECRET);
    const app = mkApp();
    const res = await rpc(
      app, { jsonrpc: "2.0", method: "notifications/initialized" }, token,
    );
    expect(res.status).toBe(204);
  });

  it("rejects non-JSON-RPC body with 400", async () => {
    const a = await seedAdmin();
    const { token } = await mintApiToken({
      name: "claude", scopes: ["mcp:read"], ttlSeconds: 600,
      createdBy: a.id, createdByEmail: a.email,
    }, SECRET);
    const app = mkApp();
    const res = await rpc(app, { foo: "bar" }, token);
    expect(res.status).toBe(400);
  });

  it("tools/list returns the registered tool set", async () => {
    const a = await seedAdmin();
    const { token } = await mintApiToken({
      name: "claude", scopes: ["mcp:read"], ttlSeconds: 600,
      createdBy: a.id, createdByEmail: a.email,
    }, SECRET);
    const app = mkApp();
    const res = await rpc(app, { jsonrpc: "2.0", id: 3, method: "tools/list" }, token);
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain("vaultbase.list_collections");
  });
});
