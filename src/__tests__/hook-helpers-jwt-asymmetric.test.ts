import { describe, expect, it } from "bun:test";
import * as jose from "jose";
import { makeExtraHelpers } from "../core/hook-helpers-extra.ts";

const helpers = makeExtraHelpers();
const sec = helpers.security;

describe("helpers.security.jwtSign / jwtVerify — algorithm support", () => {
  it("HS256 round-trips with no algorithm specified (back-compat)", async () => {
    const token = await sec.jwtSign({ sub: "u1", role: "admin" }, "shared-secret", { expiresIn: "1h" });
    const claims = await sec.jwtVerify(token, "shared-secret");
    expect(claims.sub).toBe("u1");
    expect(claims.role).toBe("admin");
  });

  it("HS256 round-trips with algorithm explicit", async () => {
    const token = await sec.jwtSign({ sub: "u1" }, "shared-secret", { algorithm: "HS256" });
    const claims = await sec.jwtVerify(token, "shared-secret", { algorithm: "HS256" });
    expect(claims.sub).toBe("u1");
  });

  it("RS256 round-trips with PKCS8 private key for sign + SPKI public for verify", async () => {
    const { publicKey, privateKey } = await jose.generateKeyPair("RS256", { extractable: true });
    const privPem = await jose.exportPKCS8(privateKey);
    const pubPem = await jose.exportSPKI(publicKey);

    const token = await sec.jwtSign(
      { sub: "rs-user", iat_for: "fcm" },
      privPem,
      { algorithm: "RS256", expiresIn: 3600, issuer: "vaultbase", audience: "https://oauth2.googleapis.com/token" },
    );
    const claims = await sec.jwtVerify(token, pubPem, {
      algorithm: "RS256",
      issuer: "vaultbase",
      audience: "https://oauth2.googleapis.com/token",
    });
    expect(claims.sub).toBe("rs-user");
    expect(claims.iat_for).toBe("fcm");
    expect(claims.iss).toBe("vaultbase");
  });

  it("ES256 round-trips (VAPID / APNs use case)", async () => {
    const { publicKey, privateKey } = await jose.generateKeyPair("ES256", { extractable: true });
    const privPem = await jose.exportPKCS8(privateKey);
    const pubPem = await jose.exportSPKI(publicKey);

    const token = await sec.jwtSign({ sub: "es-user" }, privPem, { algorithm: "ES256", expiresIn: 600 });
    const claims = await sec.jwtVerify(token, pubPem, { algorithm: "ES256" });
    expect(claims.sub).toBe("es-user");
  });

  it("rejects when verifier expects a different algorithm than the token uses", async () => {
    const { publicKey, privateKey } = await jose.generateKeyPair("RS256", { extractable: true });
    const privPem = await jose.exportPKCS8(privateKey);
    const pubPem = await jose.exportSPKI(publicKey);

    const token = await sec.jwtSign({ sub: "x" }, privPem, { algorithm: "RS256" });
    await expect(sec.jwtVerify(token, pubPem, { algorithm: "ES256" })).rejects.toThrow();
  });

  it("rejects RS256-signed token verified with HS256 secret", async () => {
    const { privateKey } = await jose.generateKeyPair("RS256", { extractable: true });
    const privPem = await jose.exportPKCS8(privateKey);
    const token = await sec.jwtSign({ sub: "x" }, privPem, { algorithm: "RS256" });
    await expect(sec.jwtVerify(token, "any-shared-secret")).rejects.toThrow();
  });

  it("RS256 sign with garbage PEM throws cleanly", async () => {
    await expect(
      sec.jwtSign({ sub: "x" }, "not a valid pem", { algorithm: "RS256" }),
    ).rejects.toThrow();
  });
});
