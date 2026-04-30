/**
 * Regression test for N-1: every admin-API endpoint must reject revoked
 * admin JWTs (jti in vaultbase_token_revocations) and password-reset-stale
 * admin JWTs (iat < admin.password_reset_at).
 *
 * Pre-fix, each plugin had a local `isAdmin` calling `jose.jwtVerify`
 * directly with `audience: "admin"`. That bypassed the centralized
 * `verifyAuthToken` from core/sec.ts which performs the revocation +
 * password_reset_at check.
 *
 * This test signs a real admin JWT, revokes it, then asserts that an
 * exemplar admin endpoint rejects the now-revoked token. `/_/metrics`
 * is the cheapest endpoint to drive — no body, no DB writes, pure auth.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as jose from "jose";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { admin as adminTable, tokenRevocations } from "../db/schema.ts";
import { makeMetricsPlugin } from "../api/metrics.ts";
import { eq } from "drizzle-orm";

const SECRET = "test-secret-n1";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

async function signAdmin(opts: { id?: string; jti?: string; iat?: number } = {}): Promise<string> {
  const id = opts.id ?? "admin-1";
  const now = opts.iat ?? Math.floor(Date.now() / 1000);
  const jti = opts.jti ?? crypto.randomUUID();
  // Ensure the principal exists for the recheck pass.
  try {
    await getDb().insert(adminTable).values({
      id,
      email: "admin@test.local",
      password_hash: "x",
      password_reset_at: 0,
      created_at: now,
    });
  } catch { /* already inserted */ }
  return await new jose.SignJWT({ id, email: "admin@test.local", jti })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("vaultbase")
    .setAudience("admin")
    .setIssuedAt(now)
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
}

function metricsReq(token: string | null): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request("http://localhost/_/metrics", { headers });
}

describe("N-1: admin endpoints honour token revocation", () => {
  it("accepts a fresh admin token", async () => {
    const token = await signAdmin();
    const app = makeMetricsPlugin(SECRET);
    const res = await app.handle(metricsReq(token));
    expect(res.status).toBe(200);
  });

  it("rejects a revoked admin token (jti in tokenRevocations)", async () => {
    const jti = crypto.randomUUID();
    const token = await signAdmin({ jti });
    // Pre-revoke the jti.
    await getDb().insert(tokenRevocations).values({
      jti,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    const app = makeMetricsPlugin(SECRET);
    const res = await app.handle(metricsReq(token));
    expect(res.status).toBe(401);
  });

  it("rejects a token whose iat predates admin.password_reset_at", async () => {
    const id = "admin-2";
    const oldIat = Math.floor(Date.now() / 1000) - 3600;
    const token = await signAdmin({ id, iat: oldIat });
    // Bump password_reset_at to a moment AFTER iat.
    await getDb().update(adminTable).set({
      password_reset_at: oldIat + 60,
    }).where(eq(adminTable.id, id));
    const app = makeMetricsPlugin(SECRET);
    const res = await app.handle(metricsReq(token));
    expect(res.status).toBe(401);
  });

  it("rejects a token signed by an admin row that no longer exists", async () => {
    const token = await signAdmin({ id: "admin-3" });
    await getDb().delete(adminTable).where(eq(adminTable.id, "admin-3"));
    const app = makeMetricsPlugin(SECRET);
    const res = await app.handle(metricsReq(token));
    expect(res.status).toBe(401);
  });

  it("rejects a token with the wrong issuer", async () => {
    const id = "admin-4";
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(adminTable).values({
      id, email: "admin@test.local", password_hash: "x",
      password_reset_at: 0, created_at: now,
    });
    const token = await new jose.SignJWT({ id, email: "admin@test.local", jti: crypto.randomUUID() })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("not-vaultbase")
      .setAudience("admin")
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
    const app = makeMetricsPlugin(SECRET);
    const res = await app.handle(metricsReq(token));
    expect(res.status).toBe(401);
  });
});
