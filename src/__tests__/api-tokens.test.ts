/**
 * API tokens — mint / verify / revoke / scope-check + extractBearer
 * vbat_-prefix handling.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { admin } from "../db/schema.ts";
import {
  API_TOKEN_PREFIX,
  hasScope,
  listApiTokens,
  mintApiToken,
  revokeApiToken,
  stripApiTokenPrefix,
  isApiTokenFormat,
} from "../core/api-tokens.ts";
import { extractBearer, verifyAuthToken } from "../core/sec.ts";

const SECRET = "test-secret-api-tokens";
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

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-api-tokens-"));
  setLogsDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("mintApiToken", () => {
  it("returns a vbat_-prefixed token + matching DB row", async () => {
    const me = await seedAdmin();
    const r = await mintApiToken({
      name: "test", scopes: ["read"], createdBy: me.id, createdByEmail: me.email,
    }, SECRET);
    expect(r.token.startsWith("vbat_")).toBe(true);
    expect(r.id.length).toBeGreaterThan(10);
    expect(r.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));

    const rows = await listApiTokens();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(r.id);
    expect(rows[0]?.name).toBe("test");
    expect(rows[0]?.scopes).toEqual(["read"]);
    expect(rows[0]?.created_by_email).toBe(me.email);
    expect(rows[0]?.revoked_at).toBeNull();
  });

  it("rejects invalid input", async () => {
    const me = await seedAdmin();
    await expect(mintApiToken({ name: "", scopes: ["read"], createdBy: me.id, createdByEmail: me.email }, SECRET))
      .rejects.toThrow(/name is required/);
    await expect(mintApiToken({ name: "ok", scopes: [], createdBy: me.id, createdByEmail: me.email }, SECRET))
      .rejects.toThrow(/scope/);
    await expect(mintApiToken({ name: "x".repeat(101), scopes: ["read"], createdBy: me.id, createdByEmail: me.email }, SECRET))
      .rejects.toThrow(/100 characters/);
  });

  it("clamps TTL to MAX (10y) and uses default (90d) when omitted", async () => {
    const me = await seedAdmin();
    const insane = await mintApiToken({
      name: "insane", scopes: ["read"], ttlSeconds: 99999999999,
      createdBy: me.id, createdByEmail: me.email,
    }, SECRET);
    const cap = Math.floor(Date.now() / 1000) + 10 * 365 * 24 * 60 * 60 + 5;
    expect(insane.expires_at).toBeLessThan(cap);

    const default90 = await mintApiToken({
      name: "default", scopes: ["read"],
      createdBy: me.id, createdByEmail: me.email,
    }, SECRET);
    const expectedExp = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;
    expect(Math.abs(default90.expires_at - expectedExp)).toBeLessThan(5);
  });
});

describe("verifyAuthToken — audience=api", () => {
  it("accepts a freshly-minted token + returns scopes + tokenName + viaApiToken", async () => {
    const me = await seedAdmin();
    const r = await mintApiToken({
      name: "ci", scopes: ["read", "write"],
      createdBy: me.id, createdByEmail: me.email,
    }, SECRET);
    const ctx = await verifyAuthToken(stripApiTokenPrefix(r.token), SECRET, { audience: "api" });
    expect(ctx).toBeTruthy();
    expect(ctx?.viaApiToken).toBe(true);
    expect(ctx?.scopes).toEqual(["read", "write"]);
    expect(ctx?.tokenName).toBe("ci");
    expect(ctx?.email).toBe(me.email);
    expect(ctx?.id).toBe(me.id);
    expect(ctx?.type).toBe("admin");
  });

  it("rejects when audience mismatched", async () => {
    const me = await seedAdmin();
    const r = await mintApiToken({
      name: "ci", scopes: ["read"], createdBy: me.id, createdByEmail: me.email,
    }, SECRET);
    const wrongAud = await verifyAuthToken(stripApiTokenPrefix(r.token), SECRET, { audience: "admin" });
    expect(wrongAud).toBeNull();
  });

  it("rejects when token row is missing (signature alone insufficient)", async () => {
    const me = await seedAdmin();
    const r = await mintApiToken({
      name: "x", scopes: ["read"], createdBy: me.id, createdByEmail: me.email,
    }, SECRET);
    // Drop the row but keep the JWT valid by signature
    const { eq } = await import("drizzle-orm");
    const { apiTokens } = await import("../db/schema.ts");
    await getDb().delete(apiTokens).where(eq(apiTokens.id, r.id));
    const ctx = await verifyAuthToken(stripApiTokenPrefix(r.token), SECRET, { audience: "api" });
    expect(ctx).toBeNull();
  });

  it("rejects after revoke", async () => {
    const me = await seedAdmin();
    const r = await mintApiToken({
      name: "x", scopes: ["read"], createdBy: me.id, createdByEmail: me.email,
    }, SECRET);
    const before = await verifyAuthToken(stripApiTokenPrefix(r.token), SECRET, { audience: "api" });
    expect(before).toBeTruthy();
    await revokeApiToken(r.id);
    const after = await verifyAuthToken(stripApiTokenPrefix(r.token), SECRET, { audience: "api" });
    expect(after).toBeNull();
  });

  it("rejects when minting admin's password_reset_at is bumped (force-logout-all kills API tokens too)", async () => {
    const me = await seedAdmin();
    const r = await mintApiToken({
      name: "x", scopes: ["read"], createdBy: me.id, createdByEmail: me.email,
    }, SECRET);
    // Bump password_reset_at past the token's iat
    const { eq } = await import("drizzle-orm");
    await getDb().update(admin).set({ password_reset_at: Math.floor(Date.now() / 1000) + 60 }).where(eq(admin.id, me.id));
    const ctx = await verifyAuthToken(stripApiTokenPrefix(r.token), SECRET, { audience: "api" });
    expect(ctx).toBeNull();
  });
});

describe("hasScope", () => {
  it("admin scope implies everything", () => {
    expect(hasScope(["admin"], "read")).toBe(true);
    expect(hasScope(["admin"], "write")).toBe(true);
    expect(hasScope(["admin"], "mcp:write")).toBe(true);
    expect(hasScope(["admin"], "collection:posts:read")).toBe(true);
  });

  it("explicit scope match", () => {
    expect(hasScope(["read"], "read")).toBe(true);
    expect(hasScope(["read"], "write")).toBe(false);
    expect(hasScope(["mcp:read"], "mcp:read")).toBe(true);
  });

  it("mcp:admin implies all mcp:*", () => {
    expect(hasScope(["mcp:admin"], "mcp:read")).toBe(true);
    expect(hasScope(["mcp:admin"], "mcp:write")).toBe(true);
    expect(hasScope(["mcp:admin"], "mcp:sql")).toBe(true);
    expect(hasScope(["mcp:admin"], "write")).toBe(false); // doesn't cross to non-mcp
  });

  it("missing scope returns false", () => {
    expect(hasScope([], "read")).toBe(false);
    expect(hasScope(["read"], "delete")).toBe(false);
  });
});

describe("extractBearer", () => {
  it("strips the vbat_ prefix from Authorization headers", () => {
    const req = new Request("http://localhost/", {
      headers: { authorization: "Bearer vbat_abc.def.ghi" },
    });
    expect(extractBearer(req)).toBe("abc.def.ghi");
  });

  it("returns plain JWT unchanged when no prefix", () => {
    const req = new Request("http://localhost/", {
      headers: { authorization: "Bearer abc.def.ghi" },
    });
    expect(extractBearer(req)).toBe("abc.def.ghi");
  });

  it("isApiTokenFormat / stripApiTokenPrefix round-trip", () => {
    const t = "vbat_xyz.abc.123";
    expect(isApiTokenFormat(t)).toBe(true);
    expect(stripApiTokenPrefix(t)).toBe("xyz.abc.123");
    expect(stripApiTokenPrefix("xyz.abc.123")).toBe("xyz.abc.123");
    expect(API_TOKEN_PREFIX).toBe("vbat_");
  });
});

describe("listApiTokens", () => {
  it("returns rows ordered by created_at desc", async () => {
    const me = await seedAdmin();
    await mintApiToken({ name: "first",  scopes: ["read"],  createdBy: me.id, createdByEmail: me.email }, SECRET);
    await new Promise((r) => setTimeout(r, 1100)); // unix-second granularity
    await mintApiToken({ name: "second", scopes: ["write"], createdBy: me.id, createdByEmail: me.email }, SECRET);
    const rows = await listApiTokens();
    expect(rows[0]?.name).toBe("second");
    expect(rows[1]?.name).toBe("first");
  });
});
