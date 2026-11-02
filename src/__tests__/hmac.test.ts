import { describe, expect, it } from "bun:test";
import { hmacSha256Hex } from "../core/hmac.ts";

describe("hmacSha256Hex", () => {
  it("matches RFC 4231 test case 2", () => {
    expect(hmacSha256Hex("Jefe", "what do ya want for nothing?"))
      .toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  it("reads both as UTF-8", async () => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("ключ"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("données ✓"));
    expect(hmacSha256Hex("ключ", "données ✓")).toBe(Buffer.from(sig).toString("hex"));
  });
});
