import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as jose from "jose";
import { closeDb, initDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import {
  buildAppleClientSecret,
  buildAuthorizeUrl,
  isProviderEnabled,
  listEnabledProviders,
  PROVIDERS,
  providerRequiresPkce,
  _clearAppleSecretCache,
} from "../core/oauth2.ts";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  _clearAppleSecretCache();
});

afterEach(() => closeDb());

// ── Apple ───────────────────────────────────────────────────────────────────

/**
 * Apple expects the client_secret to be an ES256 JWT signed with the .p8
 * private key. Generate a throwaway P-256 key for the test, export it as
 * PKCS8 PEM, and feed that PEM into the settings.
 */
async function generateAndStoreFakeApplePrivateKey(): Promise<{ privateKeyPem: string; publicKey: jose.KeyLike }> {
  const { privateKey, publicKey } = await jose.generateKeyPair("ES256", { extractable: true });
  const privateKeyPem = await jose.exportPKCS8(privateKey);
  return { privateKeyPem, publicKey };
}

describe("Apple OAuth2", () => {
  it("appears in the providers registry with the correct endpoints", () => {
    expect(PROVIDERS["apple"]).toBeDefined();
    expect(PROVIDERS["apple"]?.authorizeUrl).toBe("https://appleid.apple.com/auth/authorize");
    expect(PROVIDERS["apple"]?.tokenUrl).toBe("https://appleid.apple.com/auth/token");
    expect(PROVIDERS["apple"]?.fetchProfileFromTokenResponse).toBeDefined();
    expect(PROVIDERS["apple"]?.buildClientSecret).toBeDefined();
  });

  it("isProviderEnabled requires team_id, key_id, private_key + client_id all set", async () => {
    setSetting("oauth2.apple.enabled", "1");
    expect(isProviderEnabled("apple")).toBe(false); // no creds yet
    setSetting("oauth2.apple.client_id", "com.example.signin");
    setSetting("oauth2.apple.team_id", "TEAMID1234");
    setSetting("oauth2.apple.key_id", "KEYID12345");
    expect(isProviderEnabled("apple")).toBe(false); // still no key
    const { privateKeyPem } = await generateAndStoreFakeApplePrivateKey();
    setSetting("oauth2.apple.private_key", privateKeyPem);
    expect(isProviderEnabled("apple")).toBe(true);
  });

  it("buildAppleClientSecret signs an ES256 JWT with iss=team_id, sub=client_id, aud=appleid.apple.com, kid header, exp ≤ 15min from iat", async () => {
    const { privateKeyPem, publicKey } = await generateAndStoreFakeApplePrivateKey();
    setSetting("oauth2.apple.enabled", "1");
    setSetting("oauth2.apple.client_id", "com.example.signin");
    setSetting("oauth2.apple.team_id", "TEAMID1234");
    setSetting("oauth2.apple.key_id", "KEYID12345");
    setSetting("oauth2.apple.private_key", privateKeyPem);

    const jwt = await buildAppleClientSecret();
    expect(typeof jwt).toBe("string");
    expect(jwt.split(".").length).toBe(3);

    // Decode header — alg must be ES256 with the configured kid.
    const headerJson = JSON.parse(
      new TextDecoder().decode(jose.base64url.decode(jwt.split(".")[0]!))
    );
    expect(headerJson.alg).toBe("ES256");
    expect(headerJson.kid).toBe("KEYID12345");

    // Verify signature against the matching public key + check claims.
    const { payload } = await jose.jwtVerify(jwt, publicKey, {
      issuer: "TEAMID1234",
      audience: "https://appleid.apple.com",
    });
    expect(payload.iss).toBe("TEAMID1234");
    expect(payload.sub).toBe("com.example.signin");
    expect(payload.aud).toBe("https://appleid.apple.com");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(15 * 60);
    expect((payload.exp as number) - (payload.iat as number)).toBeGreaterThan(0);
  });

  it("caches the signed JWT across calls within the TTL", async () => {
    const { privateKeyPem } = await generateAndStoreFakeApplePrivateKey();
    setSetting("oauth2.apple.enabled", "1");
    setSetting("oauth2.apple.client_id", "com.example.signin");
    setSetting("oauth2.apple.team_id", "TEAMID1234");
    setSetting("oauth2.apple.key_id", "KEYID12345");
    setSetting("oauth2.apple.private_key", privateKeyPem);
    const a = await buildAppleClientSecret();
    const b = await buildAppleClientSecret();
    expect(a).toBe(b);
  });

  it("throws a clear error when Apple settings are incomplete", async () => {
    await expect(buildAppleClientSecret()).rejects.toThrow(/not fully configured/);
  });

  it("authorize URL forces response_type=code id_token + response_mode=form_post", async () => {
    const { privateKeyPem } = await generateAndStoreFakeApplePrivateKey();
    setSetting("oauth2.apple.enabled", "1");
    setSetting("oauth2.apple.client_id", "com.example.signin");
    setSetting("oauth2.apple.team_id", "TEAMID1234");
    setSetting("oauth2.apple.key_id", "KEYID12345");
    setSetting("oauth2.apple.private_key", privateKeyPem);

    const url = buildAuthorizeUrl({
      provider: "apple",
      redirectUri: "https://example.com/cb",
      state: "csrf",
    });
    const u = new URL(url);
    expect(u.searchParams.get("response_type")).toBe("code id_token");
    expect(u.searchParams.get("response_mode")).toBe("form_post");
    expect(u.searchParams.get("client_id")).toBe("com.example.signin");
  });
});

// ── Twitter ────────────────────────────────────────────────────────────────

describe("Twitter OAuth2", () => {
  it("is registered with the v2 endpoints + requiresPkce flag", () => {
    expect(PROVIDERS["twitter"]).toBeDefined();
    expect(PROVIDERS["twitter"]?.authorizeUrl).toBe("https://twitter.com/i/oauth2/authorize");
    expect(PROVIDERS["twitter"]?.tokenUrl).toBe("https://api.twitter.com/2/oauth2/token");
    expect(PROVIDERS["twitter"]?.requiresPkce).toBe(true);
    expect(providerRequiresPkce("twitter")).toBe(true);
  });

  it("buildAuthorizeUrl includes PKCE params when a challenge is supplied", async () => {
    setSetting("oauth2.twitter.enabled", "1");
    setSetting("oauth2.twitter.client_id", "twitter-client-id");
    setSetting("oauth2.twitter.client_secret", "twitter-secret");
    const url = buildAuthorizeUrl({
      provider: "twitter",
      redirectUri: "https://example.com/cb",
      state: "csrf",
      codeChallenge: "challenge-value-43-chars-min-aaaaaaaaaaaaa",
    });
    const u = new URL(url);
    expect(u.searchParams.get("code_challenge")).toBe("challenge-value-43-chars-min-aaaaaaaaaaaaa");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    // Default scopes for Twitter OAuth2.
    expect(u.searchParams.get("scope")).toBe("users.read tweet.read offline.access");
  });
});

// ── OIDC ───────────────────────────────────────────────────────────────────

describe("Generic OIDC", () => {
  it("does NOT appear in /providers when only partially configured", () => {
    setSetting("oauth2.oidc.enabled", "1");
    setSetting("oauth2.oidc.client_id", "oidc-id");
    setSetting("oauth2.oidc.client_secret", "oidc-secret");
    // No URLs yet
    expect(isProviderEnabled("oidc")).toBe(false);
    expect(listEnabledProviders().some((p) => p.name === "oidc")).toBe(false);
  });

  it("appears with the configured display_name once fully set up", () => {
    setSetting("oauth2.oidc.enabled", "1");
    setSetting("oauth2.oidc.client_id", "oidc-id");
    setSetting("oauth2.oidc.client_secret", "oidc-secret");
    setSetting("oauth2.oidc.authorization_url", "https://idp.example/authorize");
    setSetting("oauth2.oidc.token_url", "https://idp.example/oauth/token");
    setSetting("oauth2.oidc.userinfo_url", "https://idp.example/userinfo");
    setSetting("oauth2.oidc.display_name", "My Auth0");
    expect(isProviderEnabled("oidc")).toBe(true);
    const providers = listEnabledProviders();
    const oidc = providers.find((p) => p.name === "oidc");
    expect(oidc).toBeDefined();
    expect(oidc?.displayName).toBe("My Auth0");
  });

  it("authorize URL is built from the dynamically-resolved authorization_url + scopes", () => {
    setSetting("oauth2.oidc.enabled", "1");
    setSetting("oauth2.oidc.client_id", "oidc-id");
    setSetting("oauth2.oidc.client_secret", "oidc-secret");
    setSetting("oauth2.oidc.authorization_url", "https://idp.example/authorize");
    setSetting("oauth2.oidc.token_url", "https://idp.example/oauth/token");
    setSetting("oauth2.oidc.userinfo_url", "https://idp.example/userinfo");
    setSetting("oauth2.oidc.scopes", "openid profile email groups");
    const url = buildAuthorizeUrl({
      provider: "oidc",
      redirectUri: "https://example.com/cb",
      state: "csrf",
    });
    expect(url.startsWith("https://idp.example/authorize?")).toBe(true);
    const u = new URL(url);
    expect(u.searchParams.get("client_id")).toBe("oidc-id");
    expect(u.searchParams.get("scope")).toBe("openid profile email groups");
  });

  it("falls back to default display name 'OIDC' when not configured", () => {
    setSetting("oauth2.oidc.enabled", "1");
    setSetting("oauth2.oidc.client_id", "oidc-id");
    setSetting("oauth2.oidc.client_secret", "oidc-secret");
    setSetting("oauth2.oidc.authorization_url", "https://idp.example/authorize");
    setSetting("oauth2.oidc.token_url", "https://idp.example/oauth/token");
    // display_name unset
    const oidc = listEnabledProviders().find((p) => p.name === "oidc");
    expect(oidc?.displayName).toBe("OIDC");
  });
});
