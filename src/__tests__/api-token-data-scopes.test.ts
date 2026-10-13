/**
 * API tokens on the data API: records, batch, files, realtime, custom routes
 * and refresh act within the token's scopes instead of as the minting admin.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { admin } from "../db/schema.ts";
import { mintApiToken, stripApiTokenPrefix } from "../core/api-tokens.ts";
import { createCollection, type FieldDef } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { dataPrincipal, revokeToken, signAuthToken, verifyAuthToken } from "../core/sec.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { makeBatchPlugin } from "../api/batch.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { makeCollectionsPlugin } from "../api/collections.ts";
import { ensureAuthCollection, seedAuthUser } from "./_helpers.ts";

const SECRET = "test-secret-api-token-scopes";
let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-api-token-scopes-"));
  setLogsDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
  await getDb().insert(admin).values({
    id: "a1", email: "ops@test.local", password_hash: "x", password_reset_at: 0, created_at: 0,
  });
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function apiToken(scopes: string[]): Promise<string> {
  const r = await mintApiToken({ name: "t", scopes, createdBy: "a1", createdByEmail: "ops@test.local" }, SECRET);
  return stripApiTokenPrefix(r.token);
}

async function adminOnlyNotes(): Promise<string> {
  const fields: FieldDef[] = [{ name: "title", type: "text", required: false }];
  await createCollection({
    name: "notes", type: "base", fields: JSON.stringify(fields),
    list_rule: "", view_rule: "", create_rule: "", update_rule: "", delete_rule: "",
  });
  const rec = await createRecord("notes", { title: "secret" }, null);
  return String((rec as { id: string }).id);
}

function req(method: string, path: string, token: string, body?: unknown): Request {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost${path}`, {
    method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("dataPrincipal", () => {
  it("maps API token scopes to a principal", async () => {
    const v = async (scopes: string[]) => verifyAuthToken(await apiToken(scopes), SECRET);
    expect(dataPrincipal(await v(["admin"]), "write")?.type).toBe("admin");
    expect(dataPrincipal(await v(["read"]), "read")?.type).toBe("admin");
    expect(dataPrincipal(await v(["read"]), "write")).toBeNull();
    expect(dataPrincipal(await v(["write"]), "write")?.type).toBe("user");
    expect(dataPrincipal(await v(["write"]), "read")).toBeNull();
    expect(dataPrincipal(await v(["mcp:read", "mcp:admin"]), "read")).toBeNull();
  });

  it("passes admin and user sessions through", async () => {
    const { token } = await signAuthToken({ payload: { id: "a1" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET });
    expect(dataPrincipal(await verifyAuthToken(token, SECRET), "write")).toEqual({ id: "a1", type: "admin" });
  });

  it("file download tokens are not sessions", async () => {
    const { token } = await signAuthToken({ payload: { filename: "x.png" }, audience: "file", expiresInSeconds: 60, jwtSecret: SECRET });
    expect(await verifyAuthToken(token, SECRET)).toBeNull();
    expect(await verifyAuthToken(token, SECRET, { audience: "file" })).not.toBeNull();
  });
});

describe("records API", () => {
  it("an MCP-only token cannot read admin-only records", async () => {
    await adminOnlyNotes();
    const res = await makeRecordsPlugin(SECRET).handle(req("GET", "/notes", await apiToken(["mcp:read"])));
    expect(res.status).toBe(403);
  });

  it("a read token reads but cannot write", async () => {
    const id = await adminOnlyNotes();
    const app = makeRecordsPlugin(SECRET);
    const tok = await apiToken(["read"]);
    expect((await app.handle(req("GET", `/notes/${id}`, tok))).status).toBe(200);
    expect((await app.handle(req("DELETE", `/notes/${id}`, tok))).status).toBe(403);
  });

  it("a write token mutates under collection rules, not as admin", async () => {
    const id = await adminOnlyNotes();
    const res = await makeRecordsPlugin(SECRET).handle(req("PATCH", `/notes/${id}`, await apiToken(["write"]), { title: "x" }));
    expect(res.status).toBe(403);
  });

  it("an admin-scoped token keeps full access", async () => {
    const id = await adminOnlyNotes();
    const res = await makeRecordsPlugin(SECRET).handle(req("DELETE", `/notes/${id}`, await apiToken(["admin"])));
    expect(res.status).toBe(200);
  });
});

describe("batch API", () => {
  it("applies scopes per op", async () => {
    const id = await adminOnlyNotes();
    const app = makeBatchPlugin(SECRET);
    const tok = await apiToken(["read"]);
    const read = await app.handle(req("POST", "/batch", tok, { requests: [{ method: "GET", url: `/api/v1/notes/${id}` }] }));
    expect(read.status).toBe(200);
    const write = await app.handle(req("POST", "/batch", tok, { requests: [{ method: "DELETE", url: `/api/v1/notes/${id}` }] }));
    expect(write.status).toBe(403);
  });
});

describe("POST /auth/refresh", () => {
  it("refuses API tokens", async () => {
    const res = await makeAuthPlugin(SECRET).handle(req("POST", "/auth/refresh", await apiToken(["mcp:read"])));
    expect(res.status).toBe(401);
  });
});

describe("collections admin check", () => {
  it("rejects a revoked admin token", async () => {
    const { token, jti, exp } = await signAuthToken({ payload: { id: "a1" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET });
    const del = () => makeCollectionsPlugin(SECRET).handle(req("DELETE", "/collections/missing", token));
    expect((await del()).status).toBe(200);
    await revokeToken(jti, exp);
    expect((await del()).status).toBe(401);
  });
});

describe("auth endpoints use the central verifier", () => {
  async function userToken(collection: string, id: string) {
    await seedAuthUser({ collection, id });
    return signAuthToken({ payload: { id, collection }, audience: "user", expiresInSeconds: 60, jwtSecret: SECRET });
  }
  const status = async (collection: string, token: string) =>
    (await makeAuthPlugin(SECRET).handle(req("GET", `/auth/${collection}/totp/recovery/status`, token))).status;

  it("rejects a logged-out user token", async () => {
    const { token, jti, exp } = await userToken("users", "u1");
    expect(await status("users", token)).toBe(200);
    await revokeToken(jti, exp);
    expect(await status("users", token)).toBe(401);
  });

  it("rejects a token from another auth collection", async () => {
    const { token } = await userToken("users", "u1");
    await ensureAuthCollection("staff");
    expect(await status("staff", token)).toBe(401);
  });

  it("impersonation rejects a revoked admin token", async () => {
    const { token, jti, exp } = await signAuthToken({ payload: { id: "a1" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET });
    await revokeToken(jti, exp);
    const res = await makeAuthPlugin(SECRET).handle(req("POST", "/admin/impersonate/users/u1", token));
    expect(res.status).toBe(401);
  });
});
