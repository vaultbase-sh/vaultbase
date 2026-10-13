/**
 * OAuth2 providers an extension registers go through the same flow as the
 * built-ins: enabled from settings, listed, authorize URL, code exchange,
 * profile.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import {
  buildAuthorizeUrl, exchangeCodeForToken, fetchProviderProfileFromExchange, isProviderEnabled,
  listEnabledProviders, listOAuthProviders, registerOAuthProvider,
} from "../core/oauth2.ts";

let server: ReturnType<typeof Bun.serve>;
let off: () => void;

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = new URLSearchParams(await req.text());
      if (body.get("client_secret") !== "acme-secret" || body.get("code") !== "good") return new Response("no", { status: 400 });
      return Response.json({ access_token: "acme-token" });
    },
  });
  off = registerOAuthProvider({
    name: "acme", displayName: "Acme",
    authorizeUrl: "https://id.acme.test/authorize",
    tokenUrl: `http://127.0.0.1:${server.port}/token`,
    defaultScopes: ["profile"],
    fetchProfile: async (token) => ({ id: `u-${token}`, email: "a@acme.test", emailVerified: true }),
  });
});

afterEach(() => {
  off();
  server.stop(true);
  closeDb();
});

describe("registered OAuth2 providers", () => {
  it("is off until enabled and configured in settings", () => {
    expect(isProviderEnabled("acme")).toBe(false);
    setSetting("oauth2.acme.enabled", "1");
    expect(isProviderEnabled("acme")).toBe(false);
    setSetting("oauth2.acme.client_id", "acme-client");
    setSetting("oauth2.acme.client_secret", "acme-secret");
    expect(isProviderEnabled("acme")).toBe(true);
    expect(listEnabledProviders()).toEqual([{ name: "acme", displayName: "Acme" }]);
  });

  it("runs the authorize → exchange → profile flow", async () => {
    setSetting("oauth2.acme.enabled", "1");
    setSetting("oauth2.acme.client_id", "acme-client");
    setSetting("oauth2.acme.client_secret", "acme-secret");

    const url = new URL(buildAuthorizeUrl({ provider: "acme", redirectUri: "https://app.test/cb", state: "s1" }));
    expect(url.origin + url.pathname).toBe("https://id.acme.test/authorize");
    expect(url.searchParams.get("client_id")).toBe("acme-client");
    expect(url.searchParams.get("scope")).toBe("profile");

    const exchanged = await exchangeCodeForToken({ provider: "acme", code: "good", redirectUri: "https://app.test/cb" });
    expect(exchanged.access_token).toBe("acme-token");
    const profile = await fetchProviderProfileFromExchange("acme", exchanged);
    expect(profile).toEqual({ id: "u-acme-token", email: "a@acme.test", emailVerified: true });
  });

  it("uses the provider's own isConfigured when it has one", () => {
    const offB = registerOAuthProvider({
      name: "keyed", displayName: "Keyed", authorizeUrl: "https://k.test/a", tokenUrl: "https://k.test/t",
      defaultScopes: [], fetchProfile: async () => ({ id: "", email: "", emailVerified: false }),
      isConfigured: (s) => s["oauth2.keyed.api_key"] === "k",
    });
    try {
      setSetting("oauth2.keyed.enabled", "1");
      expect(isProviderEnabled("keyed")).toBe(false);
      setSetting("oauth2.keyed.api_key", "k");
      expect(isProviderEnabled("keyed")).toBe(true);
    } finally { offB(); }
  });

  it("lists built-ins and registered providers, and refuses duplicates or bad names", () => {
    const all = listOAuthProviders();
    expect(all.find((p) => p.name === "google")?.builtin).toBe(true);
    expect(all.find((p) => p.name === "acme")).toEqual({ name: "acme", displayName: "Acme", builtin: false });
    const base = { displayName: "x", authorizeUrl: "", tokenUrl: "", defaultScopes: [], fetchProfile: async () => ({ id: "", email: "", emailVerified: false }) };
    expect(() => registerOAuthProvider({ ...base, name: "google" })).toThrow(/already registered/);
    expect(() => registerOAuthProvider({ ...base, name: "Bad Name" })).toThrow(/invalid/);
  });

  it("doesn't treat object prototype names as providers", () => {
    expect(isProviderEnabled("constructor")).toBe(false);
    expect(() => buildAuthorizeUrl({ provider: "__proto__", redirectUri: "x", state: "s" })).toThrow(/Unknown OAuth2 provider/);
  });
});
