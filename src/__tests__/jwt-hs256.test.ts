/**
 * The sync HS256 verifier (core/jwt-hs256.ts) must accept exactly what
 * jose.jwtVerify accepted for our tokens and reject everything else.
 */
import { describe, expect, it, beforeEach } from "bun:test";
import * as jose from "jose";
import { createHmac } from "node:crypto";
import { verifyHs256, _resetJwtCache } from "../core/jwt-hs256.ts";

const SECRET = "test-secret-hs256-ünïcode";
const key = new TextEncoder().encode(SECRET);
const now = Math.floor(Date.now() / 1000);

async function sign(claims: Record<string, unknown>, alg = "HS256", k: Uint8Array = key): Promise<string> {
  return new jose.SignJWT(claims).setProtectedHeader({ alg }).sign(k);
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function handSigned(header: unknown, payload: unknown, secret = SECRET): string {
  const h = b64(header), p = b64(payload);
  const s = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${s}`;
}

beforeEach(() => _resetJwtCache());

describe("verifyHs256", () => {
  it("accepts a jose-signed token with matching issuer and audience and returns its claims", async () => {
    const token = await sign({ id: "u1", iss: "vaultbase", aud: "api", jti: "j1", iat: now, exp: now + 60 });
    const p = verifyHs256(token, SECRET, { issuer: "vaultbase", audience: "api" });
    expect(p).toMatchObject({ id: "u1", jti: "j1", exp: now + 60 });
    // Same answer as jose.
    const viaJose = await jose.jwtVerify(token, key, { issuer: "vaultbase", audience: "api" });
    expect(p).toEqual(viaJose.payload as Record<string, unknown>);
  });

  it("accepts an audience given as an array, and tokens without exp", async () => {
    expect(verifyHs256(await sign({ iss: "vaultbase", aud: ["x", "admin"] }), SECRET, { issuer: "vaultbase", audience: "admin" })).not.toBeNull();
  });

  it("rejects the wrong secret, a tampered payload and a tampered signature", async () => {
    const token = await sign({ iss: "vaultbase", exp: now + 60 });
    expect(verifyHs256(token, SECRET + "x", { issuer: "vaultbase" })).toBeNull();
    const [h, , s] = token.split(".") as [string, string, string];
    expect(verifyHs256(`${h}.${b64({ iss: "vaultbase", exp: now + 60, id: "admin" })}.${s}`, SECRET)).toBeNull();
    const flipped = s.slice(0, -1) + (s.endsWith("A") ? "B" : "A");
    expect(verifyHs256(`${h}.${token.split(".")[1]}.${flipped}`, SECRET)).toBeNull();
  });

  it("rejects expired, not-yet-valid, wrong issuer and wrong audience", async () => {
    expect(verifyHs256(await sign({ iss: "vaultbase", exp: now - 1 }), SECRET, { issuer: "vaultbase" })).toBeNull();
    expect(verifyHs256(await sign({ iss: "vaultbase", exp: now }), SECRET, { issuer: "vaultbase" })).toBeNull();
    expect(verifyHs256(await sign({ iss: "vaultbase", nbf: now + 30 }), SECRET, { issuer: "vaultbase" })).toBeNull();
    expect(verifyHs256(await sign({ iss: "other" }), SECRET, { issuer: "vaultbase" })).toBeNull();
    expect(verifyHs256(await sign({ iss: "vaultbase", aud: "user" }), SECRET, { issuer: "vaultbase", audience: "api" })).toBeNull();
    expect(verifyHs256(await sign({ iss: "vaultbase" }), SECRET, { issuer: "vaultbase", audience: "api" })).toBeNull();
    // `exp` is re-checked on a cached token.
    const t = await sign({ iss: "vaultbase", exp: now + 5 });
    expect(verifyHs256(t, SECRET, { now })).not.toBeNull();
    expect(verifyHs256(t, SECRET, { now: now + 5 })).toBeNull();
  });

  it("rejects other algorithms, including an HS256-signed token whose header says otherwise", async () => {
    expect(verifyHs256(handSigned({ alg: "none", typ: "JWT" }, { iss: "vaultbase" }), SECRET)).toBeNull();
    expect(verifyHs256(handSigned({ alg: "HS512", typ: "JWT" }, { iss: "vaultbase" }), SECRET)).toBeNull();
    expect(verifyHs256(handSigned({ alg: "HS256", crit: ["b64"], b64: false }, { iss: "vaultbase" }), SECRET)).toBeNull();
    const unsigned = `${b64({ alg: "none" })}.${b64({ iss: "vaultbase" })}.`;
    expect(verifyHs256(unsigned, SECRET)).toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    for (const bad of ["", "a", "a.b", "a.b.c.d", "é.é.é", `${b64({ alg: "HS256" })}.notjson.${"A".repeat(43)}`, `${b64({ alg: "HS256" })}.${b64([1])}.${"A".repeat(43)}`]) {
      expect(verifyHs256(bad, SECRET)).toBeNull();
    }
  });

  it("caches per token but never across secrets", async () => {
    const token = await sign({ iss: "vaultbase", exp: now + 60 });
    expect(verifyHs256(token, SECRET)).not.toBeNull();
    expect(verifyHs256(token, "another-secret")).toBeNull();
    expect(verifyHs256(token, SECRET)).not.toBeNull();
  });

  it("matches jose on a hand-built token with the secret's UTF-8 bytes", async () => {
    const t = handSigned({ alg: "HS256", typ: "JWT" }, { iss: "vaultbase", aud: "admin", exp: now + 60 });
    expect(verifyHs256(t, SECRET, { issuer: "vaultbase", audience: "admin" })).not.toBeNull();
    await expect(jose.jwtVerify(t, key, { issuer: "vaultbase", audience: "admin" })).resolves.toBeTruthy();
  });
});
