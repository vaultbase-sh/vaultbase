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
import { admin, adminSessions } from "../db/schema.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { signAuthToken, verifyAuthToken } from "../core/sec.ts";
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

  it("the old token can't be refreshed a second time", async () => {
    const old = await userToken();
    expect((await refresh(old)).status).toBe(200);
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

  it("anonymous sessions are exempt: a guest has no way to sign in again", async () => {
    const id = await seedAuthUser({ collection: "users", isAnonymous: true });
    const old = await aged({ id, email: "anon@test.local", collection: "users", anonymous: true }, "user", 60 * DAY);
    expect((await refresh(old)).status).toBe(200);
  });
});
