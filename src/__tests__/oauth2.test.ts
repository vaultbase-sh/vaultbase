import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import {
  buildAuthorizeUrl,
  getProviderConfig,
  isProviderEnabled,
  listEnabledProviders,
  PROVIDERS,
} from "../core/oauth2.ts";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

describe("provider registry", () => {
  it.each([
    "google", "github", "gitlab", "facebook", "microsoft",
    "discord", "twitch", "spotify", "linkedin", "slack",
    "bitbucket", "notion", "patreon",
  ])("ships %s", (name) => {
    expect(PROVIDERS[name]).toBeDefined();
    expect(PROVIDERS[name]?.authorizeUrl).toMatch(/^https:\/\//);
    expect(PROVIDERS[name]?.tokenUrl).toMatch(/^https:\/\//);
  });

  it("each provider declares a defaultScopes array (may be empty for scope-less flows like Notion)", () => {
    for (const p of Object.values(PROVIDERS)) {
      expect(Array.isArray(p.defaultScopes)).toBe(true);
    }
  });
});

describe("getProviderConfig + isProviderEnabled", () => {
  it("returns disabled-empty when no settings exist", () => {
    const c = getProviderConfig("google");
    expect(c.enabled).toBe(false);
    expect(c.client_id).toBe("");
    expect(c.client_secret).toBe("");
    expect(isProviderEnabled("google")).toBe(false);
  });

  it("requires enabled + client_id + client_secret all present", () => {
    setSetting("oauth2.google.enabled", "1");
    setSetting("oauth2.google.client_id", "abc");
    expect(isProviderEnabled("google")).toBe(false); // no secret
    setSetting("oauth2.google.client_secret", "shh");
    expect(isProviderEnabled("google")).toBe(true);
  });

  it("flag accepts both '1' and 'true'", () => {
    setSetting("oauth2.github.enabled", "true");
    setSetting("oauth2.github.client_id", "x");
    setSetting("oauth2.github.client_secret", "y");
    expect(isProviderEnabled("github")).toBe(true);
  });

  it("unknown provider is never enabled", () => {
    expect(isProviderEnabled("notreal")).toBe(false);
  });
});

describe("listEnabledProviders", () => {
  it("only lists fully-configured + enabled providers", () => {
    setSetting("oauth2.google.enabled", "1");
    setSetting("oauth2.google.client_id", "g");
    setSetting("oauth2.google.client_secret", "s");
    setSetting("oauth2.github.enabled", "0");
    setSetting("oauth2.github.client_id", "g");
    setSetting("oauth2.github.client_secret", "s");
    const list = listEnabledProviders();
    expect(list.map((p) => p.name)).toEqual(["google"]);
  });
});

describe("buildAuthorizeUrl", () => {
  beforeEach(() => {
    setSetting("oauth2.google.enabled", "1");
    setSetting("oauth2.google.client_id", "client123");
    setSetting("oauth2.google.client_secret", "secret456");
  });

  it("includes client_id, redirect_uri, response_type, scope, state", () => {
    const url = buildAuthorizeUrl({
      provider: "google",
      redirectUri: "https://example.com/cb",
      state: "csrf-tok",
    });
    expect(url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
    const u = new URL(url);
    expect(u.searchParams.get("client_id")).toBe("client123");
    expect(u.searchParams.get("redirect_uri")).toBe("https://example.com/cb");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("state")).toBe("csrf-tok");
    expect(u.searchParams.get("scope")).toContain("email");
  });

  it("uses caller-supplied scopes when provided", () => {
    const url = buildAuthorizeUrl({
      provider: "google",
      redirectUri: "https://example.com/cb",
      state: "x",
      scopes: ["openid"],
    });
    expect(new URL(url).searchParams.get("scope")).toBe("openid");
  });

  it("throws on unknown provider", () => {
    expect(() => buildAuthorizeUrl({
      provider: "notreal",
      redirectUri: "https://example.com/cb",
      state: "x",
    })).toThrow(/Unknown OAuth2 provider/);
  });

  it("throws when provider isn't enabled", () => {
    setSetting("oauth2.github.enabled", "0");
    expect(() => buildAuthorizeUrl({
      provider: "github",
      redirectUri: "https://example.com/cb",
      state: "x",
    })).toThrow(/not enabled/);
  });
});
