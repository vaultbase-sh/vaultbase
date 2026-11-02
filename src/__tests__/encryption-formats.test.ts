/**
 * encryptValue / decryptValue are the synchronous form behind an async
 * signature. Values written by the WebCrypto implementation they replaced
 * (ciphertext then tag, the same wire format) still decrypt.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { decryptValue, decryptValueSync, encryptValue, encryptValueSync } from "../core/encryption.ts";

const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("base64");

beforeEach(() => { process.env["VAULTBASE_ENCRYPTION_KEY"] = KEY; });
afterEach(() => { delete process.env["VAULTBASE_ENCRYPTION_KEY"]; });

async function webCryptoEncrypt(plaintext: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", Buffer.from(KEY, "base64"), { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)));
  return `vbenc:1:${Buffer.from(iv).toString("base64")}:${Buffer.from(ct).toString("base64")}`;
}

describe("encryption", () => {
  it("decrypts values the WebCrypto implementation wrote", async () => {
    const stored = await webCryptoEncrypt("héllo ✓");
    expect(await decryptValue(stored)).toBe("héllo ✓");
    expect(decryptValueSync(stored)).toBe("héllo ✓");
  });

  it("round-trips through either form, and leaves plaintext as is", async () => {
    expect(decryptValueSync(await encryptValue("a"))).toBe("a");
    expect(await decryptValue(encryptValueSync("b"))).toBe("b");
    expect(await decryptValue("plain")).toBe("plain");
  });

  it("refuses a tampered value", async () => {
    const stored = await encryptValue("secret");
    const tampered = stored.slice(0, -4) + (stored.endsWith("AAAA") ? "BBBB" : "AAAA");
    await expect(decryptValue(tampered)).rejects.toThrow();
  });

  it("rejects, not throws, from the async form", async () => {
    delete process.env["VAULTBASE_ENCRYPTION_KEY"];
    const p = encryptValue("x");
    expect(p).toBeInstanceOf(Promise);
    await expect(p).rejects.toThrow(/VAULTBASE_ENCRYPTION_KEY/);
  });
});
