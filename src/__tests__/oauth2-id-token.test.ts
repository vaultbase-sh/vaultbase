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
  sub?: string; aud?: string; iss?: string; nonce?: string | null; exp?: string | number | null;
  key?: jose.KeyLike; claims?: Record<string, unknown>;
} = {}) {
  const claims: Record<string, unknown> = {
    email: "ann@example.com",
    email_verified: provider === "apple" ? "true" : true,
    ...over.claims,
  };
  if (over.nonce !== null && over.nonce !== undefined) claims["nonce"] = over.nonce;
  const jwt = new jose.SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(over.iss ?? (provider === "apple" ? "https://appleid.apple.com" : "https://accounts.google.com"))
    .setAudience(over.aud ?? (provider === "apple" ? APPLE_APP : GOOGLE_IOS))
    .setSubject(over.sub ?? `${provider}-user-1`)
    .setIssuedAt();
  if (over.exp !== null) jwt.setExpirationTime(over.exp ?? "5m");
  return jwt.sign(over.key ?? key);
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

  it("runs beforeCreate on a new account: it may refuse it, or set its fields and address", async () => {
    const { hooks } = await import("../db/schema.ts");
    const { invalidateHookCache } = await import("../core/hooks.ts");
    const hook = async (code: string) => {
      await getDb().delete(hooks);
      const now = Math.floor(Date.now() / 1000);
      await getDb().insert(hooks).values({ id: crypto.randomUUID(), name: "h", collection_name: "users", event: "beforeCreate", code, enabled: 1, created_at: now, updated_at: now });
      invalidateHookCache();
    };
    await hook("if (String(ctx.record.email).endsWith('@example.com')) throw new Error('no example.com');");
    const refused = await signIn("google");
    expect(refused.status).toBe(422);
    expect(await getDb().select().from(oauthLinks)).toHaveLength(0);

    await hook("ctx.record.email = 'ann@moved.test';");
    const moved = await signIn("google", { sub: "google-user-2" });
    expect(moved.status).toBe(200);
    const id = (moved.body.data!["record"] as { id: string }).id;
    expect((moved.body.data!["record"] as { email: string }).email).toBe("ann@moved.test");
    const u = await findUserById((await getCollection("users"))!, id);
    expect(u!.email).toBe("ann@moved.test");
    // Not the address the provider verified.
    expect(u!.email_verified).toBe(0);

    // An address that has an account is refused.
    await hook("ctx.record.email = 'seed@test.local';");
    expect((await signIn("google", { sub: "google-user-3" })).status).toBe(409);
  });

  it("takes the provider's values as they come: a name the field refuses is left out, not the account", async () => {
    const users = (await getCollection("users"))!;
    const fields = [...JSON.parse(users.fields), { name: "name", type: "text", options: { max: 3 } }]
      .map((f: { name: string; options?: Record<string, unknown> }) => f.name === "email" ? { ...f, options: { ...f.options, max: 30 } } : f);
    await updateCollection("users", { fields: JSON.stringify(fields) });
    _resetCollectionCache();
    const res = await signIn("google", { claims: { name: "Annabelle Long-Name" } });
    expect(res.status).toBe(200);
    // Unverified: the placeholder is longer than the email field's max, and is still used.
    const unverified = await signIn("google", { sub: "google-user-9", claims: { email: "bob@example.com", email_verified: false } });
    expect(unverified.status).toBe(200);
    expect((unverified.body.data!["record"] as { email: string }).email.endsWith("@oauth.invalid")).toBe(true);
  });

  it("keeps a hook's address that differs only in case, trims it, and survives odd values", async () => {
    const { hooks } = await import("../db/schema.ts");
    const { invalidateHookCache } = await import("../core/hooks.ts");
    const hook = async (code: string) => {
      await getDb().delete(hooks);
      const now = Math.floor(Date.now() / 1000);
      await getDb().insert(hooks).values({ id: crypto.randomUUID(), name: "h", collection_name: "users", event: "beforeCreate", code, enabled: 1, created_at: now, updated_at: now });
      invalidateHookCache();
    };
    await hook("ctx.record.email = String(ctx.record.email).toLowerCase();");
    const lower = await signIn("google", { sub: "g-case", claims: { email: "Mixed@Case.test" } });
    expect((lower.body.data!["record"] as { email: string }).email).toBe("mixed@case.test");
    const u = await findUserById((await getCollection("users"))!, (lower.body.data!["record"] as { id: string }).id);
    expect(u!.email_verified).toBe(1);

    await hook("ctx.record.email = '  padded@case.test  ';");
    const padded = await signIn("google", { sub: "g-pad" });
    expect((padded.body.data!["record"] as { email: string }).email).toBe("padded@case.test");

    await hook("ctx.record.email = null;");
    const kept = await signIn("google", { sub: "g-null", claims: { email: "kept@example.com" } });
    expect((kept.body.data!["record"] as { email: string }).email).toBe("kept@example.com");

    await hook("const o = {}; o.self = o; ctx.record.junk = o;");
    expect((await signIn("google", { sub: "g-cyclic", claims: { email: "cyc@example.com" } })).status).toBe(200);
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

  it("without the nonce that was sent, or with another one", async () => {
    expect((await signIn("google", { nonce: null })).status).toBe(401);
    expect((await signIn("google", { nonce: "someone-elses" })).status).toBe(401);
  });

  it("without an expiry", async () => {
    expect((await signIn("google", { exp: null })).status).toBe(401);
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

  it("a replayed token is refused, with or without its nonce", async () => {
    const first = await signIn("google");
    expect(first.status).toBe(200);
    const withNonce = await post("/auth/users/oauth2/id-token", { provider: "google", id_token: first.token, nonce: first.nonce });
    expect(withNonce.status).toBe(400);
    const without = await post("/auth/users/oauth2/id-token", { provider: "google", id_token: first.token });
    expect(without.status).toBe(401);
  });

  it("Google: optional (its Flutter plugin fixes it per launch); the token still works once", async () => {
    const token = await idToken("google", { nonce: "client-chosen-at-launch" });
    expect((await post("/auth/users/oauth2/id-token", { provider: "google", id_token: token })).status).toBe(200);
    expect((await post("/auth/users/oauth2/id-token", { provider: "google", id_token: token })).status).toBe(401);
  });

  it("Apple: required", async () => {
    const token = await idToken("apple", { nonce: null });
    const res = await post("/auth/users/oauth2/id-token", { provider: "apple", id_token: token });
    expect(res.status).toBe(400);
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
