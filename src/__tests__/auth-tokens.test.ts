import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as jose from "jose";
import { closeDb, initDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import { createCollection } from "../core/collections.ts";
import { authTokens, users } from "../db/schema.ts";
import { getDb } from "../db/client.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import {
  AUTH_WINDOW_BOUNDS,
  DEFAULT_WINDOWS,
  isAuthWindowKey,
  listAuthWindowKinds,
  tokenWindowSeconds,
  validateWindowSeconds,
} from "../core/auth-tokens.ts";

const SECRET = "test-secret-auth-tokens";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

describe("tokenWindowSeconds()", () => {
  it("returns the default when unset", () => {
    expect(tokenWindowSeconds("anonymous")).toBe(DEFAULT_WINDOWS.anonymous);
    expect(tokenWindowSeconds("user")).toBe(DEFAULT_WINDOWS.user);
    expect(tokenWindowSeconds("admin")).toBe(DEFAULT_WINDOWS.admin);
    expect(tokenWindowSeconds("impersonate")).toBe(DEFAULT_WINDOWS.impersonate);
    expect(tokenWindowSeconds("refresh")).toBe(DEFAULT_WINDOWS.refresh);
    expect(tokenWindowSeconds("file")).toBe(DEFAULT_WINDOWS.file);
  });

  it("reads from settings when set", () => {
    setSetting("auth.anonymous.window_seconds", "172800"); // 2d
    expect(tokenWindowSeconds("anonymous")).toBe(172800);
  });

  it("falls back when value is non-numeric / NaN", () => {
    setSetting("auth.anonymous.window_seconds", "abc");
    expect(tokenWindowSeconds("anonymous")).toBe(DEFAULT_WINDOWS.anonymous);
  });

  it("falls back when value is below minimum", () => {
    setSetting("auth.anonymous.window_seconds", "30"); // below 60s floor
    expect(tokenWindowSeconds("anonymous")).toBe(DEFAULT_WINDOWS.anonymous);
  });

  it("clamps to MAX_SECONDS when value is too large", () => {
    setSetting("auth.anonymous.window_seconds", "999999999999");
    expect(tokenWindowSeconds("anonymous")).toBe(AUTH_WINDOW_BOUNDS.MAX_SECONDS);
  });

  it("each kind reads its own setting", () => {
    setSetting("auth.user.window_seconds", "3600");
    setSetting("auth.admin.window_seconds", "7200");
    expect(tokenWindowSeconds("user")).toBe(3600);
    expect(tokenWindowSeconds("admin")).toBe(7200);
    expect(tokenWindowSeconds("anonymous")).toBe(DEFAULT_WINDOWS.anonymous);
  });
});

describe("validateWindowSeconds()", () => {
  it("accepts integer in range", () => {
    expect(validateWindowSeconds(60)).toBeNull();
    expect(validateWindowSeconds("3600")).toBeNull();
    expect(validateWindowSeconds(2_592_000)).toBeNull();
  });

  it("rejects non-numeric", () => {
    expect(validateWindowSeconds("abc")).toMatch(/integer/);
    expect(validateWindowSeconds(NaN)).toMatch(/integer/);
    expect(validateWindowSeconds(undefined)).toMatch(/integer/);
  });

  it("rejects below minimum", () => {
    expect(validateWindowSeconds(0)).toMatch(/at least/);
    expect(validateWindowSeconds(59)).toMatch(/at least/);
  });

  it("rejects above maximum", () => {
    expect(validateWindowSeconds(AUTH_WINDOW_BOUNDS.MAX_SECONDS + 1)).toMatch(/at most/);
  });
});

describe("isAuthWindowKey()", () => {
  it.each([
    "auth.user.window_seconds",
    "auth.admin.window_seconds",
    "auth.anonymous.window_seconds",
    "auth.impersonate.window_seconds",
    "auth.refresh.window_seconds",
    "auth.file.window_seconds",
  ])("recognizes %s", (k) => {
    expect(isAuthWindowKey(k)).toBe(true);
  });

  it("rejects unrelated keys", () => {
    expect(isAuthWindowKey("auth.bogus.window_seconds")).toBe(false);
    expect(isAuthWindowKey("smtp.host")).toBe(false);
    expect(isAuthWindowKey("auth.user")).toBe(false);
    expect(isAuthWindowKey("")).toBe(false);
  });
});

describe("listAuthWindowKinds() covers every default", () => {
  it("listed kinds match DEFAULT_WINDOWS keys", () => {
    expect(new Set<string>(listAuthWindowKinds())).toEqual(new Set<string>(Object.keys(DEFAULT_WINDOWS)));
  });
});

// ── End-to-end: anonymous endpoint honors the configured window ─────────────

async function setupAuthCol(): Promise<{ id: string; name: string }> {
  const col = await createCollection({
    name: "users",
    type: "auth",
    fields: JSON.stringify([]),
  });
  return { id: col.id, name: col.name };
}

describe("anonymous endpoint honors auth.anonymous.window_seconds", () => {
  it("default window mints a 30d JWT", async () => {
    await setupAuthCol();
    setSetting("auth.anonymous.enabled", "1");
    const app = makeAuthPlugin(SECRET);
    const req = new Request("http://localhost/auth/users/anonymous", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const res = await app.handle(req);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { token: string } };
    const { payload } = await jose.jwtVerify(
      body.data.token,
      new TextEncoder().encode(SECRET),
      { audience: "user" }
    );
    const issuedFor = (payload.exp as number) - (payload.iat as number || Math.floor(Date.now() / 1000));
    // 30d ± 5s tolerance for clock skew during the request
    expect(Math.abs(issuedFor - DEFAULT_WINDOWS.anonymous)).toBeLessThan(5);
  });

  it("configured window overrides the default", async () => {
    await setupAuthCol();
    setSetting("auth.anonymous.enabled", "1");
    setSetting("auth.anonymous.window_seconds", "3600"); // 1h
    const app = makeAuthPlugin(SECRET);
    const req = new Request("http://localhost/auth/users/anonymous", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const res = await app.handle(req);
    const body = await res.json() as { data: { token: string } };
    const { payload } = await jose.jwtVerify(body.data.token, new TextEncoder().encode(SECRET));
    const issuedFor = (payload.exp as number) - Math.floor(Date.now() / 1000);
    expect(Math.abs(issuedFor - 3600)).toBeLessThan(5);
  });

  it("invalid configured window falls back to default (30d)", async () => {
    await setupAuthCol();
    setSetting("auth.anonymous.enabled", "1");
    setSetting("auth.anonymous.window_seconds", "garbage");
    const app = makeAuthPlugin(SECRET);
    const req = new Request("http://localhost/auth/users/anonymous", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const res = await app.handle(req);
    const body = await res.json() as { data: { token: string } };
    const { payload } = await jose.jwtVerify(body.data.token, new TextEncoder().encode(SECRET));
    const issuedFor = (payload.exp as number) - Math.floor(Date.now() / 1000);
    expect(Math.abs(issuedFor - DEFAULT_WINDOWS.anonymous)).toBeLessThan(5);
  });
});
