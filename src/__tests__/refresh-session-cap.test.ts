/**
 * `/auth/refresh` used to mint a new token and leave the old one valid until
 * its own expiry, and re-stamp the expiry forever, so a stolen token could be
 * kept alive indefinitely (Shannon AUTH-04, AUTH-07). Admin refreshes also
 * never showed up in the session list. Now the old token is revoked, the
 * original sign-in time rides along as `auth_time`, and refresh stops once the
 * session is older than `auth.session.max_seconds` (default 30 days).
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as jose from "jose";
import { eq } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import { admin, adminSessions, authTokens } from "../db/schema.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { revokeToken, signAuthToken, verifyAuthToken } from "../core/sec.ts";
import { seedAuthUser } from "./_helpers.ts";

const SECRET = "test-secret-refresh-cap";
const DAY = 24 * 60 * 60;

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  await getDb().insert(admin).values({ id: "a1", email: "admin@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
});

afterEach(() => closeDb());

async function refresh(token: string) {
  const res = await makeAuthPlugin(SECRET).handle(new Request("http://localhost/auth/refresh", {
    method: "POST", headers: { authorization: `Bearer ${token}` },
  }));
  const body = (await res.json()) as { data?: { token: string } };
  return { status: res.status, token: body.data?.token ?? null };
}

/** A token that is still within its own expiry but was issued `ageSeconds` ago. */
async function aged(payload: Record<string, unknown>, aud: "user" | "admin", ageSeconds: number) {
  const iat = Math.floor(Date.now() / 1000) - ageSeconds;
  return new jose.SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" }).setIssuer("vaultbase").setAudience(aud)
    .setIssuedAt(iat).setExpirationTime(Math.floor(Date.now() / 1000) + 3600).setJti(crypto.randomUUID())
    .sign(new TextEncoder().encode(SECRET));
}

async function userToken(extra: Record<string, unknown> = {}, ageSeconds = 0) {
  const id = await seedAuthUser({ collection: "users", email: "u@test.local" });
  return aged({ id, email: "u@test.local", collection: "users", ...extra }, "user", ageSeconds);
}

describe("refresh revokes the token it replaces", () => {
  it("user: the old token stops working, the new one works", async () => {
    const old = await userToken();
    const r = await refresh(old);
    expect(r.status).toBe(200);
    expect(await verifyAuthToken(old, SECRET)).toBeNull();
    expect(await verifyAuthToken(r.token!, SECRET)).not.toBeNull();
  });

  it("refreshing the old token again returns the same replacement, then stops", async () => {
    const old = await userToken();
    const first = await refresh(old);
    expect(first.status).toBe(200);
    // Another tab or a retried request within 30 s: same session, no 401.
    const again = await refresh(old);
    expect(again.status).toBe(200);
    expect(again.token).toBe(first.token);
    // Past the window, the old token is just revoked.
    await getDb().update(authTokens).set({ expires_at: 0 }).where(eq(authTokens.purpose, "refresh_rotation"));
    expect((await refresh(old)).status).toBe(401);
  });

  it("parallel refreshes of one token all get the same replacement", async () => {
    const old = await userToken();
    const results = await Promise.all(Array.from({ length: 5 }, () => refresh(old)));
    // Nobody gets a 401 (which would sign every tab out), and there is one session.
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(new Set(results.map((r) => r.token)).size).toBe(1);
  });

  it("the repeat window doesn't revive a replacement that was signed out", async () => {
    const old = await userToken();
    const first = await refresh(old);
    const ctx = (await verifyAuthToken(first.token!, SECRET))!;
    await revokeToken(ctx.jti!, ctx.exp!);
    expect((await refresh(old)).status).toBe(401);
  });

  it("a replacement that was itself refreshed can't be fetched again with the old token", async () => {
    const old = await userToken();
    const first = await refresh(old);
    expect((await refresh(first.token!)).status).toBe(200);
    expect((await refresh(old)).status).toBe(401);
  });

  it("admin: the old token stops working and the new session is listed", async () => {
    const { token: old } = await signAuthToken({ payload: { id: "a1", email: "admin@test.local" }, audience: "admin", expiresInSeconds: 3600, jwtSecret: SECRET });
    const r = await refresh(old);
    expect(r.status).toBe(200);
    expect(await verifyAuthToken(old, SECRET)).toBeNull();
    const jti = jose.decodeJwt(r.token!).jti!;
    expect(await getDb().select().from(adminSessions).where(eq(adminSessions.jti, jti))).toHaveLength(1);
  });
});

describe("absolute session lifetime", () => {
  it("a session older than 30 days can't be refreshed", async () => {
    expect((await refresh(await userToken({}, 31 * DAY))).status).toBe(401);
  });

  it("the original sign-in time survives refreshes (auth_time)", async () => {
    const signedIn = Math.floor(Date.now() / 1000) - 20 * DAY;
    const r = await refresh(await userToken({ auth_time: signedIn }));
    expect(r.status).toBe(200);
    const claims = jose.decodeJwt(r.token!);
    expect(claims["auth_time"]).toBe(signedIn);
    // The new token can't outlive the session: at most 10 more days.
    expect(claims.exp!).toBeLessThanOrEqual(signedIn + 30 * DAY);
  });

  it("chained refreshes stop at the cap", async () => {
    const signedIn = Math.floor(Date.now() / 1000) - 31 * DAY;
    expect((await refresh(await userToken({ auth_time: signedIn }))).status).toBe(401);
  });

  it("applies to admins too", async () => {
    const old = await aged({ id: "a1", email: "admin@test.local" }, "admin", 31 * DAY);
    expect((await refresh(old)).status).toBe(401);
  });

  it("a recent session refreshes normally (legitimate path)", async () => {
    expect((await refresh(await userToken({}, DAY))).status).toBe(200);
  });

  it("is configurable, and 0 turns it off", async () => {
    setSetting("auth.session.max_seconds", "0");
    expect((await refresh(await userToken({}, 400 * DAY))).status).toBe(200);
  });

  it("a guest token for an account that was promoted is no longer exempt", async () => {
    const id = await seedAuthUser({ collection: "users", isAnonymous: false });
    const old = await aged({ id, email: "x@test.local", collection: "users", anonymous: true }, "user", 60 * DAY);
    expect((await refresh(old)).status).toBe(401);
  });

  it("anonymous sessions are exempt: a guest has no way to sign in again", async () => {
    const id = await seedAuthUser({ collection: "users", isAnonymous: true });
    const old = await aged({ id, email: "anon@test.local", collection: "users", anonymous: true }, "user", 60 * DAY);
    expect((await refresh(old)).status).toBe(200);
  });
});
