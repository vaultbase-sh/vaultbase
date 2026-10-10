import { describe, expect, it } from "bun:test";
import * as jose from "jose";
import { extractAuth } from "../api/logs.ts";

// Request-log attribution caches verified tokens instead of re-running the
// JWT HMAC on every request. Only signature-verified, unexpired tokens may
// come out of the cache.

const secret = new TextEncoder().encode("attribution-cache-test-secret-0123456789");

async function sign(exp: string | number, id = "u1") {
  return new jose.SignJWT({ id, collection: "users" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("vaultbase").setAudience("user").setIssuedAt()
    .setExpirationTime(exp)
    .sign(secret);
}

const req = (token: string) => new Request("http://localhost/x", { headers: { authorization: `Bearer ${token}` } });

describe("request-log attribution cache", () => {
  it("attributes a valid token, repeatedly", async () => {
    const t = await sign("1h");
    expect((await extractAuth(req(t), secret))?.id).toBe("u1");
    expect((await extractAuth(req(t), secret))?.id).toBe("u1");
  });

  it("never attributes a tampered token, even after the genuine one was cached", async () => {
    const t = await sign("1h", "u2");
    expect((await extractAuth(req(t), secret))?.id).toBe("u2");
    const tampered = t.slice(0, -3) + (t.endsWith("AAA") ? "BBB" : "AAA");
    expect(await extractAuth(req(tampered), secret)).toBeNull();
  });

  it("does not serve an expired token from the cache", async () => {
    const t = await sign(Math.floor(Date.now() / 1000) + 1, "u3");
    expect((await extractAuth(req(t), secret))?.id).toBe("u3");
    await Bun.sleep(2100);
    expect(await extractAuth(req(t), secret)).toBeNull();
  });
});
