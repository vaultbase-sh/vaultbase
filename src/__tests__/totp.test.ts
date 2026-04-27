import { describe, expect, it } from "bun:test";
import {
  base32Decode,
  base32Encode,
  buildOtpauthUrl,
  generateCode,
  generateSecret,
  verifyCode,
} from "../core/totp.ts";

describe("base32 round-trip", () => {
  it("encodes and decodes arbitrary bytes", () => {
    const inputs = [
      new Uint8Array([1, 2, 3, 4, 5]),
      new Uint8Array(20).fill(0xab),
      new Uint8Array([0]),
    ];
    for (const buf of inputs) {
      const decoded = base32Decode(base32Encode(buf));
      expect(Array.from(decoded.slice(0, buf.length))).toEqual(Array.from(buf));
    }
  });

  it("rejects invalid characters", () => {
    expect(() => base32Decode("not-base32!")).toThrow();
  });
});

describe("generateSecret", () => {
  it("returns a 32-character base32 string (20 bytes)", () => {
    const s = generateSecret();
    expect(s).toMatch(/^[A-Z2-7]+$/);
    // 20 bytes -> 32 chars (160 bits / 5 bits per char)
    expect(s.length).toBe(32);
  });

  it("produces unique secrets", () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(a).not.toBe(b);
  });
});

describe("generateCode (RFC 6238 reference vectors)", () => {
  // Test vectors from RFC 6238 Appendix B with the SHA-1 test seed "12345678901234567890"
  // Base32 of that ASCII string is "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ".
  const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  it.each([
    [59,           "94287082"],
    [1111111109,   "07081804"],
    [1111111111,   "14050471"],
    [1234567890,   "89005924"],
    [2000000000,   "69279037"],
  ])("at unix %i produces a code ending with %s", (time, expected) => {
    // Our implementation emits 6 digits; the RFC vectors are 8. Compare last 6.
    const code = generateCode(SECRET, time);
    expect(code).toBe(expected.slice(-6));
  });
});

describe("verifyCode", () => {
  const secret = generateSecret();

  it("accepts the current-window code", () => {
    const now = Math.floor(Date.now() / 1000);
    const code = generateCode(secret, now);
    expect(verifyCode(secret, code, now)).toBe(true);
  });

  it("accepts a code from one step ago (drift tolerance)", () => {
    const now = Math.floor(Date.now() / 1000);
    const codePrev = generateCode(secret, now - 30);
    expect(verifyCode(secret, codePrev, now)).toBe(true);
  });

  it("accepts a code from one step ahead (drift tolerance)", () => {
    const now = Math.floor(Date.now() / 1000);
    const codeNext = generateCode(secret, now + 30);
    expect(verifyCode(secret, codeNext, now)).toBe(true);
  });

  it("rejects a code from two steps ago", () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = generateCode(secret, now - 60);
    expect(verifyCode(secret, stale, now)).toBe(false);
  });

  it("rejects a malformed code", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(verifyCode(secret, "12345", now)).toBe(false);    // too short
    expect(verifyCode(secret, "abcdef", now)).toBe(false);   // non-numeric
    expect(verifyCode(secret, "", now)).toBe(false);
  });
});

describe("buildOtpauthUrl", () => {
  it("returns an otpauth:// URL with the expected parameters", () => {
    const url = buildOtpauthUrl({
      secret: "JBSWY3DPEHPK3PXP",
      accountName: "alice@example.com",
      issuer: "Vaultbase",
    });
    expect(url.startsWith("otpauth://totp/Vaultbase:alice%40example.com?")).toBe(true);
    const u = new URL(url);
    expect(u.searchParams.get("secret")).toBe("JBSWY3DPEHPK3PXP");
    expect(u.searchParams.get("issuer")).toBe("Vaultbase");
    expect(u.searchParams.get("digits")).toBe("6");
    expect(u.searchParams.get("period")).toBe("30");
    expect(u.searchParams.get("algorithm")).toBe("SHA1");
  });
});
