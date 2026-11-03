/**
 * Regressions for the fourth November 2026 security audit pass (run-4),
 * session-vs-reset findings (OTP / provider / API-token / impersonation),
 * push devices outside `users`, and rules on unnormalised write bodies.
 * Each block reproduces the reported schedule and expects the fixed behavior.
 */
import { describe, expect, it, beforeEach, afterEach, setSystemTime } from "bun:test";
import * as jose from "jose";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { admin, authTokens } from "../db/schema.ts";
import { createCollection, _resetCollectionCache } from "../core/collections.ts";
import { insertUser, updateUserById } from "../core/users-table.ts";
import { forceLogoutAllAdmins } from "../core/security.ts";
import { verifyAuthToken } from "../core/sec.ts";
import { generateCode, generateSecret } from "../core/totp.ts";
import { _setGoogleKeysForTests } from "../core/oauth2.ts";
import { setSetting } from "../api/settings.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { makeApiTokensPlugin } from "../api/api-tokens.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { ensureAuthCollection, hashedTokenId } from "./_helpers.ts";

const SECRET = "test-secret-audit-run4-sessions";
const OLD_PW = "old-password-12345";
const NEW_PW = "brand-new-password-6789";

beforeEach(async () => {
  _resetCollectionCache();
  await initDb(":memory:");
  await runMigrations();
  setSetting("auth.otp.enabled", "1");
});

afterEach(async () => {
  setSystemTime();
  _setGoogleKeysForTests(null);
  _resetCollectionCache();
  await closeDb();
});

type Plugin = { handle: (r: Request) => Promise<Response> };
const app = () => makeAuthPlugin(SECRET);

function send(a: Plugin, method: string, path: string, body: unknown, bearer?: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return a.handle(new Request(`http://localhost${path}`, { method, headers, body: JSON.stringify(body) }));
}
const post = (a: Plugin, path: string, body: unknown, bearer?: string) => send(a, "POST", path, body, bearer);

async function seedUser(email: string, extra: Record<string, unknown> = {}, collection = "users"): Promise<string> {
  const col = await ensureAuthCollection(collection);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await insertUser(col, {
    id, email, password_hash: await Bun.password.hash(OLD_PW), email_verified: 1, created_at: now, updated_at: now,
    ...extra,
  } as Parameters<typeof insertUser>[1]);
  return id;
}

async function stageToken(userId: string, purpose: string, collection = "users"): Promise<string> {
  const col = await ensureAuthCollection(collection);
  const raw = crypto.randomUUID() + crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(authTokens).values({
    id: hashedTokenId(raw), user_id: userId, collection_id: col.id, purpose,
    expires_at: now + 900, used_at: null, created_at: now,
  });
  return raw;
}

const resetPassword = async (a: Plugin, userId: string, collection = "users") =>
  post(a, `/auth/${collection}/confirm-password-reset`, { token: await stageToken(userId, "password_reset", collection), password: NEW_PW });

const tokenOf = async (res: Response) => ((await res.json()) as { data: { token: string } }).data.token;

describe("magic-link sign-in racing a password reset", () => {
  it("ends the session when the reset commits right after the link is spent", async () => {
    const userId = await seedUser("owner@test.local");
    const link = await stageToken(userId, "otp");
    const a = app();
    // Run the whole reset as soon as otp/auth's spend of the link resolves.
    const d = getDb() as unknown as { update: (t: unknown) => unknown };
    const realUpdate = d.update;
    let fired = false;
    d.update = function (this: unknown, table: unknown) {
      const qb = realUpdate.call(this, table) as { set: (v: Record<string, unknown>) => unknown };
      if (table !== authTokens) return qb;
      const realSet = qb.set.bind(qb);
      qb.set = (v: Record<string, unknown>) => {
        const w = realSet(v) as { where: (c: unknown) => unknown };
        if (!("used_at" in v)) return w;
        const realWhere = w.where.bind(w);
        w.where = (c: unknown) => {
          const r = realWhere(c) as { returning: (...args: unknown[]) => PromiseLike<unknown[]> };
          const realReturning = r.returning.bind(r);
          r.returning = (...args: unknown[]) => Promise.resolve(realReturning(...args)).then(async (rows) => {
            if (!fired && rows.length > 0) {
              fired = true;
              expect((await resetPassword(a, userId)).status).toBe(200);
            }
            return rows;
          }) as unknown as PromiseLike<unknown[]>;
          return r;
        };
        return w;
      };
      return qb;
    } as typeof d.update;
    let res: Response;
    try {
      res = await post(a, "/auth/users/otp/auth", { token: link });
    } finally {
      d.update = realUpdate;
    }
    expect(fired).toBe(true);
    if (res.status === 200) {
      expect(await verifyAuthToken(await tokenOf(res), SECRET)).toBeNull();
    } else {
      expect(res.status).toBe(400);
    }
  });

  it("ends a session minted on a node whose clock runs ahead of the resetting node", async () => {
    const userId = await seedUser("owner@test.local");
    const link = await stageToken(userId, "otp");
    const a = app();
    const T = Date.now();
    setSystemTime(new Date(T + 800));
    const res = await post(a, "/auth/users/otp/auth", { token: link });
    expect(res.status).toBe(200);
    const token = await tokenOf(res);
    setSystemTime(new Date(T + 250));
    expect((await resetPassword(a, userId)).status).toBe(200);
    setSystemTime(new Date(T + 3000));
    expect(await verifyAuthToken(token, SECRET)).toBeNull();
    expect((await post(a, "/auth/refresh", {}, token)).status).toBe(401);
  });

  it("the MFA ticket carries the stamp read at the link check", async () => {
    const totp = generateSecret();
    const userId = await seedUser("owner@test.local", { totp_secret: totp, totp_enabled: 1 });
    const a = app();
    const step1 = await post(a, "/auth/users/otp/auth", { token: await stageToken(userId, "otp") });
    expect(step1.status).toBe(200);
    const { data } = await step1.json() as { data: { mfa_token: string } };
    // A reset stamped after the link check whose ticket void hasn't landed.
    const col = await ensureAuthCollection("users");
    await updateUserById(col, userId, { password_reset_at: Date.now() });
    const res = await post(a, "/auth/users/login/mfa", { mfa_token: data.mfa_token, code: await generateCode(totp) });
    expect(res.status).toBe(400);
  });

  it("still signs in with no reset, and a claim's session survives its own stamp", async () => {
    const userId = await seedUser("owner@test.local");
    const res = await post(app(), "/auth/users/otp/auth", { token: await stageToken(userId, "otp") });
    expect(res.status).toBe(200);
    expect(await verifyAuthToken(await tokenOf(res), SECRET)).not.toBeNull();

    const fresh = await seedUser("fresh@test.local", { email_verified: 0 });
    const claim = await post(app(), "/auth/users/otp/auth", { token: await stageToken(fresh, "otp") });
    expect(claim.status).toBe(200);
    const token = await tokenOf(claim);
    expect(await verifyAuthToken(token, SECRET)).not.toBeNull();
    expect((await post(app(), "/auth/refresh", {}, token)).status).toBe(200);
  });
});

describe("provider sign-in and the reset cutoff", () => {
  const GOOGLE_IOS = "123-ios.apps.googleusercontent.com";
  let key: jose.KeyLike;
  beforeEach(async () => {
    const pair = await jose.generateKeyPair("RS256", { extractable: true });
    key = pair.privateKey;
    _setGoogleKeysForTests(jose.createLocalJWKSet({ keys: [{ ...(await jose.exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }] }));
    setSetting("oauth2.google.enabled", "1");
    setSetting("oauth2.google.client_id", "123-web.apps.googleusercontent.com");
    setSetting("oauth2.google.native_client_ids", GOOGLE_IOS);
    await ensureAuthCollection("users");
  });

  async function signIn(a: Plugin): Promise<Response> {
    const n = await post(a, "/auth/users/oauth2/id-token/nonce", { provider: "google" });
    const nonce = ((await n.json()) as { data: { nonce: string } }).data.nonce;
    const idToken = await new jose.SignJWT({ email: "ann@example.com", email_verified: true, nonce })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer("https://accounts.google.com").setAudience(GOOGLE_IOS).setSubject("google-user-1")
      .setIssuedAt().setExpirationTime("5m").sign(key);
    return post(a, "/auth/users/oauth2/id-token", { provider: "google", id_token: idToken, nonce });
  }

  it("ends a provider session minted on a node whose clock runs ahead of the reset", async () => {
    const a = app();
    const first = await signIn(a);
    expect(first.status).toBe(200);
    const userId = ((await first.json()) as { data: { record: { id: string } } }).data.record.id;
    const T = Date.now();
    setSystemTime(new Date(T + 800));
    const res = await signIn(a);
    expect(res.status).toBe(200);
    const token = await tokenOf(res);
    expect(await verifyAuthToken(token, SECRET)).not.toBeNull();
    setSystemTime(new Date(T + 250));
    expect((await resetPassword(a, userId)).status).toBe(200);
    setSystemTime(new Date(T + 3000));
    expect(await verifyAuthToken(token, SECRET)).toBeNull();
  });

  it("the provider MFA ticket carries the stamp read with the link", async () => {
    const a = app();
    const first = await signIn(a);
    const userId = ((await first.json()) as { data: { record: { id: string } } }).data.record.id;
    const totp = generateSecret();
    const col = await ensureAuthCollection("users");
    await updateUserById(col, userId, { totp_secret: totp, totp_enabled: 1 });
    const step1 = await signIn(a);
    const { data } = await step1.json() as { data: { mfa_token: string } };
    expect(data.mfa_token).toBeTruthy();
    await updateUserById(col, userId, { password_reset_at: Date.now() });
    const res = await post(a, "/auth/users/login/mfa", { mfa_token: data.mfa_token, code: await generateCode(totp) });
    expect(res.status).toBe(400);
  });
});

describe("API tokens and impersonation follow the admin's stamp, not clocks", () => {
  async function adminSession(): Promise<string> {
    await getDb().insert(admin).values({ id: "a1", email: "a1@test.local", password_hash: await Bun.password.hash(OLD_PW), password_reset_at: 0, created_at: 1 });
    const res = await post(app(), "/admin/auth/login", { email: "a1@test.local", password: OLD_PW });
    expect(res.status).toBe(200);
    return tokenOf(res);
  }
  const mint = async (session: string) => {
    const res = await post(makeApiTokensPlugin(SECRET), "/admin/api-tokens", { name: "ci", scopes: ["admin"] }, session);
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { token: string } }).data.token;
  };

  it("an API token minted ahead of force-logout-all's clock ends with it", async () => {
    const T = Date.now();
    setSystemTime(new Date(T + 800));
    const session = await adminSession();
    const apiToken = await mint(session);
    setSystemTime(new Date(T + 100));
    await forceLogoutAllAdmins();
    setSystemTime(new Date(T + 3000));
    expect(await verifyAuthToken(apiToken, SECRET)).toBeNull();
  });

  it("an API token without a reset keeps working", async () => {
    const apiToken = await mint(await adminSession());
    const ctx = await verifyAuthToken(apiToken, SECRET);
    expect(ctx?.viaApiToken).toBe(true);
  });

  it("an impersonation session minted ahead of force-logout-all's clock ends with it", async () => {
    const userId = await seedUser("victim@test.local");
    const T = Date.now();
    setSystemTime(new Date(T + 800));
    const session = await adminSession();
    const res = await post(app(), `/admin/impersonate/users/${userId}`, {}, session);
    expect(res.status).toBe(200);
    const imp = await tokenOf(res);
    expect(await verifyAuthToken(imp, SECRET)).not.toBeNull();
    setSystemTime(new Date(T + 100));
    await forceLogoutAllAdmins();
    setSystemTime(new Date(T + 3000));
    expect(await verifyAuthToken(imp, SECRET)).toBeNull();
  });
});

describe("push devices of users outside `users`", () => {
  it("are disabled when a member resets their password", async () => {
    await ensureAuthCollection("users");
    const memberId = await seedUser("member@test.local", {}, "members");
    await db.exec(`
      CREATE TABLE vb_device_tokens (
        id TEXT PRIMARY KEY, "user" TEXT NOT NULL, provider TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE, platform TEXT NOT NULL, app_version TEXT,
        enabled INTEGER NOT NULL DEFAULT 1, last_seen INTEGER NOT NULL, created_at INTEGER NOT NULL
      )`);
    await db.run(`INSERT INTO vb_device_tokens (id, "user", provider, token, platform, enabled, last_seen, created_at) VALUES (?, ?, 'fcm', 'dev-member', 'android', 1, 1, 1)`,
      [crypto.randomUUID(), memberId]);
    expect((await resetPassword(app(), memberId, "members")).status).toBe(200);
    const row = await db.get<{ enabled: number }>(`SELECT enabled FROM vb_device_tokens WHERE token = ?`, ["dev-member"]);
    expect(row?.enabled).toBe(0);
  });
});

describe("create and update rules see stored values", () => {
  const PAST = "1999-06-01T00:00:00Z";
  const FUTURE = "2099-06-01T00:00:00Z";
  const records = () => makeRecordsPlugin(SECRET);
  const slot = { name: "slot", type: "group", options: { multiple: false, fields: [{ name: "at", type: "date" }] } };

  it("a past ISO date in a group subfield fails `> @now` on create", async () => {
    await createCollection({ name: "bookings", type: "base", fields: JSON.stringify([slot]), create_rule: "slot.at > @now", list_rule: null, view_rule: null });
    expect((await post(records(), "/bookings", { slot: { at: PAST } })).status).toBe(403);
    expect((await post(records(), "/bookings", { slot: { at: FUTURE } })).status).toBe(200);
  });

  it("a past ISO date in a group list item fails the rule too", async () => {
    const items = { name: "items", type: "group", options: { fields: [{ name: "at", type: "date" }] } };
    await createCollection({ name: "plans", type: "base", fields: JSON.stringify([items]), create_rule: "items.at:each > @now", list_rule: null, view_rule: null });
    expect((await post(records(), "/plans", { items: [{ at: PAST }] })).status).toBe(403);
    expect((await post(records(), "/plans", { items: [{ at: FUTURE }] })).status).toBe(200);
  });

  it("a past ISO date in a group subfield fails `> @now` on update", async () => {
    await createCollection({ name: "b2", type: "base", fields: JSON.stringify([slot]), create_rule: null, update_rule: "slot.at > @now", list_rule: null, view_rule: null });
    const created = await post(records(), "/b2", { slot: { at: FUTURE } });
    expect(created.status).toBe(200);
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    expect((await send(records(), "PATCH", `/b2/${id}`, { slot: { at: PAST } })).status).toBe(403);
    expect((await send(records(), "PATCH", `/b2/${id}`, { slot: { at: FUTURE } })).status).toBe(200);
  });

  it("a short or uppercase color is compared in its stored form", async () => {
    await createCollection({ name: "paints", type: "base", fields: JSON.stringify([{ name: "color", type: "color" }]), create_rule: `color != "#00ff00"`, list_rule: null, view_rule: null });
    expect((await post(records(), "/paints", { color: "#0F0" })).status).toBe(403);
    expect((await post(records(), "/paints", { color: "#F00" })).status).toBe(200);
  });

  it("sign-up's create rule sees the sign-up fields in stored form", async () => {
    await createCollection({
      name: "users", type: "auth",
      fields: JSON.stringify([{ name: "starts", type: "date" }]),
      create_rule: "starts > @now",
    });
    const reg = (email: string, starts: string) => post(app(), "/auth/users/register", { email, password: NEW_PW, starts });
    expect((await reg("past@test.local", PAST)).status).toBe(403);
    expect((await reg("future@test.local", FUTURE)).status).toBe(200);
  });
});
