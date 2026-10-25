/**
 * Native sign-in with an ID token (Sign in with Apple / Google sign-in on the
 * device): POST /auth/:collection/oauth2/id-token/nonce, then
 * POST /auth/:collection/oauth2/id-token. Tokens are signed with a local key
 * standing in for the provider's published keys.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as jose from "jose";
import { and, eq } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import { _resetCollectionCache, getCollection, updateCollection } from "../core/collections.ts";
import { oauthLinks } from "../db/schema.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { _setAppleKeysForTests, _setGoogleKeysForTests } from "../core/oauth2.ts";
import { seedAuthUser } from "./_helpers.ts";
import { generateSecret } from "../core/totp.ts";
import { findUserById, updateUserById } from "../core/users-table.ts";

const SECRET = "test-secret-id-token";
const APPLE_APP = "com.example.notes";
const GOOGLE_IOS = "123-ios.apps.googleusercontent.com";
const GOOGLE_WEB = "123-web.apps.googleusercontent.com";

let key: jose.KeyLike;

beforeEach(async () => {
  _resetCollectionCache();
  await initDb(":memory:");
  await runMigrations();
  const pair = await jose.generateKeyPair("RS256", { extractable: true });
  key = pair.privateKey;
  const jwks = jose.createLocalJWKSet({
    keys: [{ ...(await jose.exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }],
  });
  _setAppleKeysForTests(jwks);
  _setGoogleKeysForTests(jwks);
  setSetting("oauth2.apple.enabled", "1");
  setSetting("oauth2.apple.native_client_ids", APPLE_APP);
  setSetting("oauth2.google.enabled", "1");
  setSetting("oauth2.google.client_id", GOOGLE_WEB);
  setSetting("oauth2.google.native_client_ids", `${GOOGLE_IOS}, other-android-id`);
  await seedAuthUser({ collection: "users", email: "seed@test.local" });
});

afterEach(async () => {
  _setAppleKeysForTests(null);
  _setGoogleKeysForTests(null);
  await closeDb();
});

const app = () => makeAuthPlugin(SECRET);
const post = (path: string, body: unknown) => app().handle(new Request(`http://localhost${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}));

type Body = { data?: Record<string, unknown>; error?: string };

async function nonceFor(provider: string, collection = "users"): Promise<string> {
  const res = await post(`/auth/${collection}/oauth2/id-token/nonce`, { provider });
  expect(res.status).toBe(200);
  return ((await res.json()) as Body).data!["nonce"] as string;
}

function idToken(provider: "apple" | "google", over: {
  sub?: string; aud?: string; iss?: string; nonce?: string | null; exp?: string | number;
  key?: jose.KeyLike; claims?: Record<string, unknown>;
} = {}) {
  const claims: Record<string, unknown> = {
    email: "ann@example.com",
    email_verified: provider === "apple" ? "true" : true,
    ...over.claims,
  };
  if (over.nonce !== null && over.nonce !== undefined) claims["nonce"] = over.nonce;
  return new jose.SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(over.iss ?? (provider === "apple" ? "https://appleid.apple.com" : "https://accounts.google.com"))
    .setAudience(over.aud ?? (provider === "apple" ? APPLE_APP : GOOGLE_IOS))
    .setSubject(over.sub ?? `${provider}-user-1`)
    .setIssuedAt()
    .setExpirationTime(over.exp ?? "5m")
    .sign(over.key ?? key);
}

const sha256hex = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

async function signIn(provider: "apple" | "google", tokenOver: Parameters<typeof idToken>[1] = {}, extra: Record<string, unknown> = {}) {
  const nonce = await nonceFor(provider);
  const token = await idToken(provider, { nonce, ...tokenOver });
  const res = await post("/auth/users/oauth2/id-token", { provider, id_token: token, nonce, ...extra });
  return { status: res.status, body: (await res.json()) as Body, nonce, token };
}

describe("signing in", () => {
  it("Google: a new account, linked; signing in again finds it", async () => {
    const first = await signIn("google");
    expect(first.status).toBe(200);
    const id = (first.body.data!["record"] as { id: string }).id;
    expect(first.body.data!["token"]).toBeTruthy();
    expect((first.body.data!["record"] as { email: string }).email).toBe("ann@example.com");

    const again = await signIn("google");
    expect(again.status).toBe(200);
    expect((again.body.data!["record"] as { id: string }).id).toBe(id);

    const links = await getDb().select().from(oauthLinks)
      .where(and(eq(oauthLinks.provider, "google"), eq(oauthLinks.user_id, id)));
    expect(links).toHaveLength(1);
  });

  it("Apple: the nonce may come back hashed; the app can pass the name", async () => {
    const users = (await getCollection("users"))!;
    await updateCollection(users.id, { fields: JSON.stringify([{ name: "name", type: "text" }]) });
    _resetCollectionCache();
    const nonce = await nonceFor("apple");
    const token = await idToken("apple", { nonce: sha256hex(nonce) });
    const res = await post("/auth/users/oauth2/id-token", {
      provider: "apple", id_token: token, nonce, name: "  Ann Lee  ",
    });
    expect(res.status).toBe(200);
    const id = (((await res.json()) as Body).data!["record"] as { id: string }).id;
    const col = (await getCollection("users"))!;
    const user = await findUserById(col, id);
    expect(user?.email_verified).toBe(1);
    const { getRecord } = await import("../core/records.ts");
    expect((await getRecord("users", id))?.["name"]).toBe("Ann Lee");
  });

  it("the web client ID and every native one are accepted audiences", async () => {
    expect((await signIn("google", { aud: GOOGLE_WEB })).status).toBe(200);
    expect((await signIn("google", { aud: "other-android-id", sub: "g-2", claims: { email: "b@example.com" } })).status).toBe(200);
  });

  it("an existing account with the same verified email needs a merge", async () => {
    const res = await signIn("google", { claims: { email: "seed@test.local" } });
    expect(res.status).toBe(200);
    expect(res.body.data!["merge_required"]).toBe(true);
    expect(res.body.data!["merge_token"]).toBeTruthy();
    expect(res.body.data!["token"]).toBeUndefined();
  });

  it("an unverified email isn't claimed for the new account", async () => {
    const res = await signIn("google", { claims: { email: "seed@test.local", email_verified: false } });
    expect(res.status).toBe(200);
    expect((res.body.data!["record"] as { email: string }).email).toMatch(/@oauth\.invalid$/);
  });

  it("a linked account with TOTP on gets an MFA ticket", async () => {
    const first = await signIn("google");
    const id = (first.body.data!["record"] as { id: string }).id;
    await updateUserById((await getCollection("users"))!, id, { totp_enabled: 1, totp_secret: generateSecret() });
    const again = await signIn("google");
    expect(again.body.data!["mfa_required"]).toBe(true);
    expect(again.body.data!["token"]).toBeUndefined();
  });

  it("sign-up closed: a new account is refused", async () => {
    const col = (await getCollection("users"))!;
    await updateCollection(col.id, { create_rule: "" });
    _resetCollectionCache();
    expect((await signIn("google")).status).toBe(403);
  });
});

describe("the token is refused", () => {
  it("signed by another key", async () => {
    const { privateKey } = await jose.generateKeyPair("RS256");
    expect((await signIn("google", { key: privateKey })).status).toBe(401);
  });

  it("issued to another app", async () => {
    expect((await signIn("google", { aud: "attacker.apps.googleusercontent.com" })).status).toBe(401);
    expect((await signIn("apple", { aud: "com.attacker.app" })).status).toBe(401);
  });

  it("from another issuer, or the other provider's", async () => {
    expect((await signIn("google", { iss: "https://evil.example" })).status).toBe(401);
    expect((await signIn("google", { iss: "https://appleid.apple.com" })).status).toBe(401);
  });

  it("expired", async () => {
    expect((await signIn("google", { exp: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
  });

  it("without the nonce, or with another one", async () => {
    expect((await signIn("google", { nonce: null })).status).toBe(401);
    expect((await signIn("google", { nonce: "someone-elses" })).status).toBe(401);
  });

  it("without an email", async () => {
    expect((await signIn("google", { claims: { email: undefined } })).status).toBe(400);
  });
});

describe("the nonce", () => {
  it("works once, even when the first try failed", async () => {
    const nonce = await nonceFor("google");
    const good = await idToken("google", { nonce });
    const { privateKey } = await jose.generateKeyPair("RS256");
    const forged = await idToken("google", { nonce, key: privateKey });
    expect((await post("/auth/users/oauth2/id-token", { provider: "google", id_token: forged, nonce })).status).toBe(401);
    expect((await post("/auth/users/oauth2/id-token", { provider: "google", id_token: good, nonce })).status).toBe(400);
  });

  it("a replayed token is refused", async () => {
    const first = await signIn("google");
    expect(first.status).toBe(200);
    const replay = await post("/auth/users/oauth2/id-token", { provider: "google", id_token: first.token, nonce: first.nonce });
    expect(replay.status).toBe(400);
  });

  it("must be issued by this server, for this provider", async () => {
    const forged = await idToken("google", { nonce: "made-up" });
    expect((await post("/auth/users/oauth2/id-token", { provider: "google", id_token: forged, nonce: "made-up" })).status).toBe(400);
    const appleNonce = await nonceFor("apple");
    const token = await idToken("google", { nonce: appleNonce });
    expect((await post("/auth/users/oauth2/id-token", { provider: "google", id_token: token, nonce: appleNonce })).status).toBe(400);
  });
});

describe("configuration", () => {
  it("a provider that's off, unconfigured or unsupported is refused", async () => {
    setSetting("oauth2.apple.enabled", "0");
    expect((await post("/auth/users/oauth2/id-token/nonce", { provider: "apple" })).status).toBe(422);
    setSetting("oauth2.google.client_id", "");
    setSetting("oauth2.google.native_client_ids", "");
    expect((await post("/auth/users/oauth2/id-token/nonce", { provider: "google" })).status).toBe(422);
    setSetting("oauth2.github.enabled", "1");
    expect((await post("/auth/users/oauth2/id-token/nonce", { provider: "github" })).status).toBe(422);
    expect((await post("/auth/users/oauth2/id-token", { provider: "github", id_token: "x", nonce: "y" })).status).toBe(422);
  });

  it("only on auth collections", async () => {
    expect((await post("/auth/nope/oauth2/id-token/nonce", { provider: "google" })).status).toBe(404);
  });
});
