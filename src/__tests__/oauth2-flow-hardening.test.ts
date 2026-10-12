/**
 * OAuth hardening (handoff #8, Shannon AUTH-03 / AUTH-06, Low "OAuth state",
 * "OIDC nonce", "redirect wildcard"), driven end to end against a stub OIDC
 * provider:
 *  - the state from /authorize is required, bound to provider + redirect URI
 *    and single-use at /exchange (it was only checked for server PKCE);
 *  - the id_token must carry the nonce this flow sent;
 *  - redirect URIs: no allow-list means app.url's origin only, and a
 *    wildcard extends the path, not the host;
 *  - a linked account with TOTP on gets an MFA ticket, also via merge-confirm;
 *  - an unverified provider email can't create a twin of an existing account;
 *  - a password reset drops the account's OAuth links.
 */
import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import * as jose from "jose";
import { and, eq } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { authTokens, oauthLinks } from "../db/schema.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { hashedTokenId, seedAuthUser } from "./_helpers.ts";
import { generateSecret } from "../core/totp.ts";
import { getCollection } from "../core/collections.ts";
import { updateUserById } from "../core/users-table.ts";

const SECRET = "test-secret-oauth-flow";
const APP = "https://app.example.com";
const CB = `${APP}/oauth/callback`;

// What the stub provider says about the signed-in user, and the nonce it echoes.
let profile: { sub: string; email: string; email_verified: boolean } = { sub: "p-1", email: "new@test.local", email_verified: true };
let echoNonce: string | null = null;
let stub: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  stub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/token") {
        const idToken = await new jose.SignJWT({ sub: profile.sub, ...(echoNonce !== null ? { nonce: echoNonce } : {}) })
          .setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("5m")
          .sign(new TextEncoder().encode("stub-key"));
        return Response.json({ access_token: "stub-access", token_type: "Bearer", id_token: idToken });
      }
      if (url.pathname === "/userinfo") return Response.json(profile);
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => stub.stop(true));

beforeEach(async () => {
  _resetCollectionCache();
  initDb(":memory:");
  await runMigrations();
  const base = `http://127.0.0.1:${stub.port}`;
  setSetting("app.url", APP);
  setSetting("oauth2.oidc.enabled", "1");
  setSetting("oauth2.oidc.client_id", "cid");
  setSetting("oauth2.oidc.client_secret", "csecret");
  setSetting("oauth2.oidc.authorization_url", `${base}/authorize`);
  setSetting("oauth2.oidc.token_url", `${base}/token`);
  setSetting("oauth2.oidc.userinfo_url", `${base}/userinfo`);
  profile = { sub: "p-1", email: "new@test.local", email_verified: true };
  await seedAuthUser({ collection: "users", email: "seed@test.local" });
});

afterEach(() => closeDb());

const app = () => makeAuthPlugin(SECRET);
const json = (path: string, body: unknown) => app().handle(new Request(`http://localhost${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));

async function authorize(redirectUri = CB, state?: string) {
  const q = new URLSearchParams({ provider: "oidc", redirectUri, ...(state ? { state } : {}) });
  const res = await app().handle(new Request(`http://localhost/auth/users/oauth2/authorize?${q}`));
  const body = await res.json() as { data?: { authorize_url: string; state: string } };
  return { status: res.status, data: body.data };
}

/** Run /authorize, have the stub echo the nonce it was given, then return the state. */
async function begin(): Promise<string> {
  const { data } = await authorize();
  echoNonce = new URL(data!.authorize_url).searchParams.get("nonce");
  return data!.state;
}

const exchange = (state: string | undefined, redirectUri = CB) =>
  json("/auth/users/oauth2/exchange", { provider: "oidc", code: "c", redirectUri, ...(state !== undefined ? { state } : {}) });

describe("state", () => {
  it("a full flow with the issued state signs in (legitimate path)", async () => {
    const res = await exchange(await begin());
    expect(res.status).toBe(200);
    expect((await res.json() as { data: { token?: string } }).data.token).toBeTruthy();
  });

  it("is required, must have been issued, and works once", async () => {
    const state = await begin();
    expect((await exchange(undefined)).status).toBe(400);
    expect((await exchange("forged-state")).status).toBe(400);
    expect((await exchange(state)).status).toBe(200);
    expect((await exchange(state)).status).toBe(400);
  });

  it("is bound to the redirect URI it was issued for", async () => {
    setSetting("oauth2.allowed_redirect_uris", `${CB},${APP}/other`);
    const state = await begin();
    expect((await exchange(state, `${APP}/other`)).status).toBe(400);
  });
});

describe("nonce", () => {
  it("an id_token with another flow's nonce is refused", async () => {
    const state = await begin();
    echoNonce = "someone-elses-nonce";
    expect((await exchange(state)).status).toBe(400);
  });
});

describe("redirect URI allow-list", () => {
  it("unset: only the app's own origin", async () => {
    expect((await authorize("https://evil.example.net/cb")).status).toBe(422);
    expect((await authorize(CB)).status).toBe(200);
  });

  it("a wildcard extends the path, not the host", async () => {
    setSetting("oauth2.allowed_redirect_uris", "https://app.example.com*");
    expect((await authorize("https://app.example.com.evil.tld/cb")).status).toBe(422);
    expect((await authorize("https://app.example.com/anything")).status).toBe(200);
  });
});

describe("accounts", () => {
  it("a linked account with TOTP on gets an MFA ticket, not a session", async () => {
    expect((await exchange(await begin())).status).toBe(200); // creates + links p-1
    const col = (await getCollection("users"))!;
    const link = (await getDb().select().from(oauthLinks).where(eq(oauthLinks.provider_user_id, "p-1")))[0]!;
    await updateUserById(col, link.user_id, { totp_enabled: 1, totp_secret: generateSecret() });
    const body = await (await exchange(await begin())).json() as { data: { mfa_required?: boolean; token?: string } };
    expect(body.data.mfa_required).toBe(true);
    expect(body.data.token).toBeUndefined();
  });

  it("merge-confirm by password honours TOTP too", async () => {
    const id = await seedAuthUser({ collection: "users", email: "has-mfa@test.local", passwordHash: await Bun.password.hash("pw-1234567890") });
    const col = (await getCollection("users"))!;
    await updateUserById(col, id, { totp_enabled: 1, totp_secret: generateSecret() });
    profile = { sub: "p-2", email: "has-mfa@test.local", email_verified: true };
    const merge = await (await exchange(await begin())).json() as { data: { merge_token: string } };
    const res = await json("/auth/users/oauth2/merge-confirm", { merge_token: merge.data.merge_token, password: "pw-1234567890" });
    const body = await res.json() as { data: { mfa_required?: boolean; token?: string } };
    expect(body.data.mfa_required).toBe(true);
    expect(body.data.token).toBeUndefined();
  });

  it("an unverified provider email can't create a twin of an existing account", async () => {
    profile = { sub: "p-3", email: "seed@test.local", email_verified: false };
    expect((await exchange(await begin())).status).toBe(409);
  });

  it("a password reset drops the account's OAuth links", async () => {
    expect((await exchange(await begin())).status).toBe(200);
    const col = (await getCollection("users"))!;
    const link = (await getDb().select().from(oauthLinks).where(eq(oauthLinks.provider_user_id, "p-1")))[0]!;
    await getDb().insert(authTokens).values({
      id: hashedTokenId("reset-tok"), user_id: link.user_id, collection_id: col.id, purpose: "password_reset",
      expires_at: Math.floor(Date.now() / 1000) + 600,
    });
    expect((await json("/auth/users/confirm-password-reset", { token: "reset-tok", password: "brand-new-pass-1" })).status).toBe(200);
    expect(await getDb().select().from(oauthLinks).where(and(eq(oauthLinks.user_id, link.user_id)))).toHaveLength(0);
  });
});
