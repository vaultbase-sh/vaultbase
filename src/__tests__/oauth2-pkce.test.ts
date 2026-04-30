import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import {
  buildAuthorizeUrl,
  codeChallengeFromVerifier,
  generateCodeVerifier,
  verifyChallenge,
} from "../core/oauth2.ts";

// RFC 7636 §4.1 charset — ALPHA / DIGIT / "-" / "." / "_" / "~".
const PKCE_CHARSET_RE = /^[A-Za-z0-9\-._~]+$/;

describe("generateCodeVerifier", () => {
  it("returns 43-128 chars matching the RFC 7636 unreserved charset", () => {
    for (let i = 0; i < 50; i++) {
      const v = generateCodeVerifier();
      expect(v.length).toBeGreaterThanOrEqual(43);
      expect(v.length).toBeLessThanOrEqual(128);
      expect(PKCE_CHARSET_RE.test(v)).toBe(true);
    }
  });

  it("default 32-byte input yields exactly 43 chars (base64url, no padding)", () => {
    const v = generateCodeVerifier();
    expect(v.length).toBe(43);
    expect(v.includes("=")).toBe(false);
    expect(v.includes("+")).toBe(false);
    expect(v.includes("/")).toBe(false);
  });

  it("clamps oversized requests to <= 128 chars", () => {
    const v = generateCodeVerifier(1024);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(PKCE_CHARSET_RE.test(v)).toBe(true);
  });

  it("clamps undersized requests so output stays >= 43 chars", () => {
    const v = generateCodeVerifier(1);
    expect(v.length).toBeGreaterThanOrEqual(43);
  });

  it("produces unique values across calls (entropy smoke test)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generateCodeVerifier());
    expect(seen.size).toBe(100);
  });
});

describe("codeChallengeFromVerifier", () => {
  it("matches the RFC 7636 Appendix B test vector", async () => {
    // RFC 7636 §B: verifier "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    // → S256 challenge "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM".
    const challenge = await codeChallengeFromVerifier(
      "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    );
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("rejects non-S256 methods", async () => {
    // @ts-expect-error — runtime-only guard
    await expect(codeChallengeFromVerifier("x".repeat(43), "plain")).rejects.toThrow();
  });

  it("is deterministic for a given verifier", async () => {
    const v = generateCodeVerifier();
    const a = await codeChallengeFromVerifier(v);
    const b = await codeChallengeFromVerifier(v);
    expect(a).toBe(b);
  });
});

describe("verifyChallenge round-trip", () => {
  it("verifier → challenge → verifyChallenge returns true", async () => {
    const v = generateCodeVerifier();
    const c = await codeChallengeFromVerifier(v);
    expect(await verifyChallenge(v, c)).toBe(true);
  });

  it("returns false for a tampered verifier", async () => {
    const v = generateCodeVerifier();
    const c = await codeChallengeFromVerifier(v);
    // Flip one char of the verifier — changing the first must reliably differ.
    const tamperedFirst = (v[0] === "A" ? "B" : "A") + v.slice(1);
    expect(await verifyChallenge(tamperedFirst, c)).toBe(false);
  });

  it("returns false for a tampered challenge", async () => {
    const v = generateCodeVerifier();
    const c = await codeChallengeFromVerifier(v);
    const tampered = (c[0] === "A" ? "B" : "A") + c.slice(1);
    expect(await verifyChallenge(v, tampered)).toBe(false);
  });

  it("returns false for a verifier shorter than 43 chars", async () => {
    const c = await codeChallengeFromVerifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
    expect(await verifyChallenge("tooshort", c)).toBe(false);
  });

  it("returns false for a verifier with disallowed characters", async () => {
    // 43 chars but contains '!' which is not in the unreserved set.
    const bad = "!" + "a".repeat(42);
    const c = await codeChallengeFromVerifier(bad); // valid hash, but the verifier itself is invalid
    expect(await verifyChallenge(bad, c)).toBe(false);
  });

  it("returns false on length mismatch between expected and provided challenge", async () => {
    const v = generateCodeVerifier();
    const c = await codeChallengeFromVerifier(v);
    expect(await verifyChallenge(v, c + "x")).toBe(false);
    expect(await verifyChallenge(v, c.slice(0, -1))).toBe(false);
  });
});

describe("buildAuthorizeUrl with PKCE params", () => {
  beforeEach(async () => {
    initDb(":memory:");
    await runMigrations();
    setSetting("oauth2.google.enabled", "1");
    setSetting("oauth2.google.client_id", "client123");
    setSetting("oauth2.google.client_secret", "secret456");
  });

  afterEach(() => closeDb());

  it("appends code_challenge + code_challenge_method=S256 when provided", async () => {
    const verifier = generateCodeVerifier();
    const challenge = await codeChallengeFromVerifier(verifier);
    const url = buildAuthorizeUrl({
      provider: "google",
      redirectUri: "https://example.com/cb",
      state: "csrf-tok",
      codeChallenge: challenge,
    });
    const u = new URL(url);
    expect(u.searchParams.get("code_challenge")).toBe(challenge);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("omits PKCE params when no challenge is supplied (existing behaviour preserved)", () => {
    const url = buildAuthorizeUrl({
      provider: "google",
      redirectUri: "https://example.com/cb",
      state: "csrf-tok",
    });
    const u = new URL(url);
    expect(u.searchParams.has("code_challenge")).toBe(false);
    expect(u.searchParams.has("code_challenge_method")).toBe(false);
  });
});
