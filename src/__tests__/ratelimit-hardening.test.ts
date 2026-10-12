/**
 * Rate limiter lows: any Authorization header selected the "signed-in"
 * rules; IPv6 clients got a bucket per address (2^64 of them per /64); the
 * bucket map grew without bound between sweeps.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import Elysia from "elysia";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting } from "../api/settings.ts";
import { invalidateRateLimitCache, makeRateLimitPlugin, rateLimitKeyForIp } from "../api/ratelimit.ts";
import { signAuthToken } from "../core/sec.ts";

const SECRET = "test-secret-ratelimit";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  setSetting("rate_limit.enabled", "1");
  setSetting("rate_limit.rules", JSON.stringify([
    { label: "/api/*", max: 100, windowMs: 60_000, audience: "auth" },
    { label: "/api/*", max: 1, windowMs: 60_000, audience: "guest" },
  ]));
  invalidateRateLimitCache();
});

afterEach(() => { invalidateRateLimitCache(); closeDb(); });

const app = () => new Elysia().use(makeRateLimitPlugin(SECRET)).get("/api/thing", () => "ok");
const hit = (auth?: string) => app().handle(new Request("http://localhost/api/thing", { headers: auth ? { authorization: auth } : {} }));

describe("rate limit audience", () => {
  it("junk in Authorization doesn't buy the signed-in limits", async () => {
    expect((await hit("Bearer junk")).status).toBe(200);
    expect((await hit("Bearer junk")).status).toBe(429);
  });

  it("a real token does (legitimate path)", async () => {
    const { token } = await signAuthToken({ payload: { id: "u" }, audience: "user", expiresInSeconds: 600, jwtSecret: SECRET });
    for (let i = 0; i < 5; i++) expect((await hit(`Bearer ${token}`)).status).toBe(200);
  });
});

describe("rate limit keys", () => {
  it("IPv6 addresses in one /64 share a bucket; IPv4 and mapped IPv4 are per address", () => {
    expect(rateLimitKeyForIp("2001:db8:1:2::1")).toBe(rateLimitKeyForIp("2001:db8:1:2:ffff:ffff:ffff:fffe"));
    expect(rateLimitKeyForIp("2001:db8:1:2::1")).not.toBe(rateLimitKeyForIp("2001:db8:1:3::1"));
    expect(rateLimitKeyForIp("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(rateLimitKeyForIp("203.0.113.5")).toBe("203.0.113.5");
  });
});
