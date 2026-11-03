/**
 * Regressions for the third November 2026 security audit pass (run-3),
 * session-vs-reset findings in auth.ts / sec.ts. Each block reproduces the
 * reported schedule and expects the fixed behavior.
 */
import { describe, expect, it, beforeEach, afterEach, setSystemTime } from "bun:test";
import * as jose from "jose";
import { eq } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { admin, authTokens, oauthLinks } from "../db/schema.ts";
import { createCollection, _resetCollectionCache } from "../core/collections.ts";
import { insertUser, updateUserById } from "../core/users-table.ts";
import { forceLogoutAllAdmins } from "../core/security.ts";
import { signAuthToken, verifyAuthToken } from "../core/sec.ts";
import { generateCode, generateSecret } from "../core/totp.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { ensureAuthCollection, hashedTokenId } from "./_helpers.ts";

const SECRET = "test-secret-audit-run3-auth";
const OLD_PW = "old-password-12345";
const NEW_PW = "brand-new-password-6789";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
});

afterEach(async () => {
  setSystemTime();
  _resetCollectionCache();
  await closeDb();
});

const app = () => makeAuthPlugin(SECRET);

function post(a: ReturnType<typeof makeAuthPlugin>, path: string, body: unknown, bearer?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return a.handle(new Request(`http://localhost${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
}

async function seedUser(email: string, extra: Record<string, unknown> = {}): Promise<string> {
  const col = await ensureAuthCollection("users");
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await insertUser(col, {
    id, email, password_hash: await Bun.password.hash(OLD_PW), email_verified: 1, created_at: now, updated_at: now,
    ...extra,
  } as Parameters<typeof insertUser>[1]);
  return id;
}

async function stageToken(userId: string, purpose: string, code?: string): Promise<string> {
  const col = await ensureAuthCollection("users");
  const raw = crypto.randomUUID() + crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(authTokens).values({
    id: hashedTokenId(raw), user_id: userId, collection_id: col.id, purpose,
    ...(code !== undefined ? { code } : {}),
    expires_at: now + 900, used_at: null, created_at: now,
  });
  return raw;
}

const stageMerge = (userId: string, providerUserId = "attacker-google-uid") =>
  stageToken(userId, "oauth2_merge", JSON.stringify({ provider: "google", provider_user_id: providerUserId, email: "victim@test.local", name: null }));

async function linkCount(userId: string): Promise<number> {
  return (await getDb().select().from(oauthLinks).where(eq(oauthLinks.user_id, userId))).length;
}

const resetPassword = async (a: ReturnType<typeof makeAuthPlugin>, userId: string) =>
  post(a, "/auth/users/confirm-password-reset", { token: await stageToken(userId, "password_reset"), password: NEW_PW });

describe("merge-confirm racing a password reset", () => {
  it("refuses, drops the link and mints nothing when the reset lands during the password check", async () => {
    const userId = await seedUser("victim@test.local");
    const merge = await stageMerge(userId);
    const spare = await stageMerge(userId, "attacker-uid-2");
    const resetTok = await stageToken(userId, "password_reset");
    const a = app();

    // Block merge-confirm inside its password check (row already read).
    const realVerify = Bun.password.verify;
    let entered!: () => void;
    const blocked = new Promise<void>((r) => { entered = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let first = true;
    (Bun.password as { verify: typeof realVerify }).verify = (async (...args: Parameters<typeof realVerify>) => {
      if (first) { first = false; entered(); await gate; }
      return realVerify(...args);
    }) as typeof realVerify;
    try {
      const pending = post(a, "/auth/users/oauth2/merge-confirm", { merge_token: merge, password: OLD_PW });
      await blocked;
      const reset = await post(a, "/auth/users/confirm-password-reset", { token: resetTok, password: NEW_PW });
      expect(reset.status).toBe(200);
      expect(await linkCount(userId)).toBe(0);
      release();
      const res = await pending;
      expect(res.status).toBe(401);
      const body = await res.json() as { data?: { token?: string } };
      expect(body.data?.token).toBeUndefined();
      expect(await linkCount(userId)).toBe(0);
    } finally {
      (Bun.password as { verify: typeof realVerify }).verify = realVerify;
    }

    // The reset voided the other open merge token too.
    const row = (await getDb().select().from(authTokens).where(eq(authTokens.id, hashedTokenId(spare))))[0]!;
    expect(row.used_at).not.toBeNull();
  });

  it("still links and signs in without a race", async () => {
    const userId = await seedUser("victim@test.local");
    const merge = await stageMerge(userId);
    const res = await post(app(), "/auth/users/oauth2/merge-confirm", { merge_token: merge, password: OLD_PW });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { token: string } };
    expect(await verifyAuthToken(body.data.token, SECRET)).not.toBeNull();
    expect(await linkCount(userId)).toBe(1);
  });

  it("refuses a collection that is not an auth collection", async () => {
    await createCollection({ name: "posts", type: "base", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    const res = await post(app(), "/auth/posts/oauth2/merge-confirm", { merge_token: "x", password: "y" });
    expect(res.status).toBe(422);
  });

  it("/login/mfa drops the pending link when the password was reset since the first factor", async () => {
    const totp = generateSecret();
    const userId = await seedUser("victim@test.local", { totp_secret: totp, totp_enabled: 1 });
    const merge = await stageMerge(userId);
    const a = app();
    const step1 = await post(a, "/auth/users/oauth2/merge-confirm", { merge_token: merge, password: OLD_PW });
    expect(step1.status).toBe(200);
    const { data } = await step1.json() as { data: { mfa_token: string } };
    // A reset that stamped after the password check but before its ticket
    // void reached this ticket (the race the post-link recheck closes).
    const col = await ensureAuthCollection("users");
    await updateUserById(col, userId, { password_reset_at: Date.now() });
    const res = await post(a, "/auth/users/login/mfa", { mfa_token: data.mfa_token, code: await generateCode(totp) });
    expect(res.status).toBe(400);
    expect(await linkCount(userId)).toBe(0);
  });

  it("/login/mfa still finishes a pending merge without a reset", async () => {
    const totp = generateSecret();
    const userId = await seedUser("victim@test.local", { totp_secret: totp, totp_enabled: 1 });
    const merge = await stageMerge(userId);
    const a = app();
    const step1 = await post(a, "/auth/users/oauth2/merge-confirm", { merge_token: merge, password: OLD_PW });
    const { data } = await step1.json() as { data: { mfa_token: string } };
    const res = await post(a, "/auth/users/login/mfa", { mfa_token: data.mfa_token, code: await generateCode(totp) });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { token: string } };
    expect(await verifyAuthToken(body.data.token, SECRET)).not.toBeNull();
    expect(await linkCount(userId)).toBe(1);
  });
});

describe("refresh racing a password reset", () => {
  const userToken = async (userId: string) => (await signAuthToken({
    payload: { id: userId, email: "victim@test.local", collection: "users" },
    audience: "user", expiresInSeconds: 3600, jwtSecret: SECRET, issuedAtMs: Date.now() - 5000,
  })).token;

  it("refuses when the reset commits right after the refresh's verify read", async () => {
    const userId = await seedUser("victim@test.local");
    const stolen = await userToken(userId);
    const a = app();
    const realGet = db.get;
    let fired = false;
    (db as { get: typeof realGet }).get = (async (sql: string, params?: unknown[]) => {
      const row = await realGet(sql, params as never);
      if (!fired && /FROM "vb_users" WHERE id = \?/.test(sql) && (params as unknown[] | undefined)?.[0] === userId) {
        fired = true;
        expect((await resetPassword(a, userId)).status).toBe(200);
      }
      return row;
    }) as typeof realGet;
    let res: Response;
    try {
      res = await post(a, "/auth/refresh", {}, stolen);
    } finally {
      (db as { get: typeof realGet }).get = realGet;
    }
    expect(fired).toBe(true);
    expect(res.status).toBe(401);
    expect(await verifyAuthToken(stolen, SECRET)).toBeNull();
    // No rotation row left to re-mint a replacement from.
    const { payload } = await jose.jwtVerify(stolen, new TextEncoder().encode(SECRET));
    const rot = await getDb().select().from(authTokens).where(eq(authTokens.id, `refresh_rotation:${payload.jti}`));
    expect(rot).toHaveLength(0);
    expect((await post(a, "/auth/refresh", {}, stolen)).status).toBe(401);
  });

  it("ends the replacement when a reset stamped before the refresh is written after it", async () => {
    const userId = await seedUser("victim@test.local");
    const stolen = await userToken(userId);
    const stampTakenAt = Date.now();
    const res = await post(app(), "/auth/refresh", {}, stolen);
    expect(res.status).toBe(200);
    const { data } = await res.json() as { data: { token: string } };
    expect(await verifyAuthToken(data.token, SECRET)).not.toBeNull();
    // The reset's UPDATE lands only now, carrying its earlier stamp.
    const col = await ensureAuthCollection("users");
    await updateUserById(col, userId, { password_reset_at: stampTakenAt });
    expect(await verifyAuthToken(data.token, SECRET)).toBeNull();
  });

  it("dates the replacement by the check with iat and iat_ms agreeing, and repeats the same replacement", async () => {
    const userId = await seedUser("victim@test.local");
    const stolen = await userToken(userId);
    const a = app();
    const before = Date.now();
    const first = await (await post(a, "/auth/refresh", {}, stolen)).json() as { data: { token: string } };
    const after = Date.now();
    const claims = jose.decodeJwt(first.data.token);
    const iatMs = claims["iat_ms"] as number;
    expect(iatMs).toBeGreaterThanOrEqual(before);
    expect(iatMs).toBeLessThanOrEqual(after);
    expect(claims.iat).toBe(Math.floor(iatMs / 1000));
    const again = await (await post(a, "/auth/refresh", {}, stolen)).json() as { data: { token: string } };
    expect(again.data.token).toBe(first.data.token);
    expect(await verifyAuthToken(again.data.token, SECRET)).not.toBeNull();
  });
});

describe("impersonation tokens follow the minting admin", () => {
  const seedAdmin = async (id: string) => {
    await getDb().insert(admin).values({ id, email: `${id}@test.local`, password_hash: "x", password_reset_at: 0, created_at: 1 });
    return (await signAuthToken({ payload: { id, email: `${id}@test.local` }, audience: "admin", expiresInSeconds: 3600, jwtSecret: SECRET })).token;
  };
  const impersonate = async (adminJwt: string, userId: string) => {
    const res = await post(app(), `/admin/impersonate/users/${userId}`, {}, adminJwt);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { token: string } }).data.token;
  };

  it("ends after force-logout-all", async () => {
    const userId = await seedUser("victim@test.local");
    const imp = await impersonate(await seedAdmin("a1"), userId);
    expect(await verifyAuthToken(imp, SECRET)).not.toBeNull();
    await forceLogoutAllAdmins();
    expect(await verifyAuthToken(imp, SECRET)).toBeNull();
  });

  it("ends when the admin is deleted", async () => {
    const userId = await seedUser("victim@test.local");
    const imp = await impersonate(await seedAdmin("a2"), userId);
    expect(await verifyAuthToken(imp, SECRET)).not.toBeNull();
    await getDb().delete(admin).where(eq(admin.id, "a2"));
    expect(await verifyAuthToken(imp, SECRET)).toBeNull();
  });
});

describe("reset cutoff across servers with skewed clocks", () => {
  it("ends a session minted on a node whose clock runs ahead of the resetting node", async () => {
    const userId = await seedUser("owner@test.local");
    const a = app();
    const T = Date.now();
    setSystemTime(new Date(T + 800)); // node B
    const login = await post(a, "/auth/users/login", { email: "owner@test.local", password: OLD_PW });
    expect(login.status).toBe(200);
    const { data } = await login.json() as { data: { token: string } };
    setSystemTime(new Date(T + 250)); // node A
    expect((await resetPassword(a, userId)).status).toBe(200);
    setSystemTime(new Date(T + 3000));
    expect(await verifyAuthToken(data.token, SECRET)).toBeNull();
    expect((await post(a, "/auth/refresh", {}, data.token)).status).toBe(401);
  });

  it("ends an admin session minted ahead of force-logout-all's clock", async () => {
    await getDb().insert(admin).values({ id: "a1", email: "a1@test.local", password_hash: await Bun.password.hash(OLD_PW), password_reset_at: 0, created_at: 1 });
    const a = app();
    const T = Date.now();
    setSystemTime(new Date(T + 800));
    const login = await post(a, "/admin/auth/login", { email: "a1@test.local", password: OLD_PW });
    expect(login.status).toBe(200);
    const { data } = await login.json() as { data: { token: string } };
    setSystemTime(new Date(T + 100));
    await forceLogoutAllAdmins();
    setSystemTime(new Date(T + 3000));
    expect(await verifyAuthToken(data.token, SECRET)).toBeNull();
  });

  it("a sign-in right after a reset is good at once, even on a node whose clock lags", async () => {
    const userId = await seedUser("owner@test.local");
    const a = app();
    const T = Date.now();
    setSystemTime(new Date(T + 800)); // the resetting node runs ahead
    expect((await resetPassword(a, userId)).status).toBe(200);
    setSystemTime(new Date(T)); // the signing-in node lags
    const login = await post(a, "/auth/users/login", { email: "owner@test.local", password: NEW_PW });
    expect(login.status).toBe(200);
    const { data } = await login.json() as { data: { token: string } };
    expect(await verifyAuthToken(data.token, SECRET)).not.toBeNull();
    const refreshed = await post(a, "/auth/refresh", {}, data.token);
    expect(refreshed.status).toBe(200);
  });

  it("a sign-in right after a reset on the same node works", async () => {
    const userId = await seedUser("owner@test.local");
    const a = app();
    expect((await resetPassword(a, userId)).status).toBe(200);
    const login = await post(a, "/auth/users/login", { email: "owner@test.local", password: NEW_PW });
    const { data } = await login.json() as { data: { token: string } };
    expect(await verifyAuthToken(data.token, SECRET)).not.toBeNull();
  });
});
