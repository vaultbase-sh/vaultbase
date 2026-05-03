/**
 * AES-GCM encryption for "encrypted" field values.
 *
 * Storage format (single string):  vbenc:1:<base64-iv>:<base64-ciphertext>
 *   - iv:           12 random bytes (96 bits)
 *   - ciphertext:   ciphertext + 128-bit GCM auth tag (WebCrypto appends it)
 *
 * Key source: env `VAULTBASE_ENCRYPTION_KEY` — must be 32 bytes when decoded
 * from base64, hex, or used as a UTF-8 string of exactly 32 chars. Loss of
 * the key = permanent loss of encrypted data.
 */

import { createCipheriv, createDecipheriv, randomBytes as nodeRandomBytes } from "node:crypto";

const PREFIX = "vbenc:1:";
const TAG_BYTES = 16;

let cachedKey: CryptoKey | null = null;
let cachedRawKey: string | null = null;
let cachedRawBytes: Uint8Array | null = null;
let cachedRawForBytes: string | null = null;

function decodeKey(raw: string): Uint8Array {
  // Try base64 (most common form)
  try {
    const buf = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    if (buf.length === 32) return buf;
  } catch { /* not base64 */ }
  // Try hex
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    const buf = new Uint8Array(32);
    for (let i = 0; i < 32; i++) buf[i] = parseInt(raw.substr(i * 2, 2), 16);
    return buf;
  }
  // Fall back to raw UTF-8 — must be exactly 32 chars
  const utf8 = new TextEncoder().encode(raw);
  if (utf8.length === 32) return utf8;
  throw new Error("VAULTBASE_ENCRYPTION_KEY must decode to 32 bytes (base64, hex, or 32-char string)");
}

async function getKey(): Promise<CryptoKey> {
  const raw = process.env["VAULTBASE_ENCRYPTION_KEY"] ?? "";
  if (!raw) throw new Error("VAULTBASE_ENCRYPTION_KEY env var not set — required for encrypted fields");
  if (cachedKey && cachedRawKey === raw) return cachedKey;
  const bytes = decodeKey(raw);
  cachedKey = await crypto.subtle.importKey("raw", bytes as unknown as ArrayBuffer, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  cachedRawKey = raw;
  return cachedKey;
}

export function isEncryptionAvailable(): boolean {
  return !!process.env["VAULTBASE_ENCRYPTION_KEY"];
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export async function encryptValue(plaintext: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as unknown as ArrayBuffer },
      key,
      new TextEncoder().encode(plaintext) as unknown as ArrayBuffer
    )
  );
  return PREFIX + toBase64(iv) + ":" + toBase64(ct);
}

export function isEncrypted(s: unknown): boolean {
  return typeof s === "string" && s.startsWith(PREFIX);
}

export async function decryptValue(stored: string): Promise<string> {
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext row
  const rest = stored.slice(PREFIX.length);
  const [ivB64, ctB64] = rest.split(":");
  if (!ivB64 || !ctB64) throw new Error("Malformed encrypted value");
  const key = await getKey();
  const iv = fromBase64(ivB64);
  const ct = fromBase64(ctB64);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as unknown as ArrayBuffer },
    key,
    ct as unknown as ArrayBuffer
  );
  return new TextDecoder().decode(pt);
}

/**
 * Synchronous variants — same `vbenc:1:<iv>:<ct>` wire format as
 * {@link encryptValue} / {@link decryptValue}, implemented via `node:crypto`
 * so callers on hot, fully-sync paths (settings reads called from inside
 * Elysia plugin factories, CORS resolution, etc.) don't have to await.
 *
 * Values produced by either form decrypt with either form — backups +
 * restores stay symmetric and you can mix sync/async at will.
 */
function getRawKeyBytes(): Uint8Array {
  const raw = process.env["VAULTBASE_ENCRYPTION_KEY"] ?? "";
  if (!raw) throw new Error("VAULTBASE_ENCRYPTION_KEY env var not set — required for encryption");
  if (cachedRawBytes && cachedRawForBytes === raw) return cachedRawBytes;
  cachedRawBytes = decodeKey(raw);
  cachedRawForBytes = raw;
  return cachedRawBytes;
}

export function encryptValueSync(plaintext: string): string {
  const key = getRawKeyBytes();
  const iv = nodeRandomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ctTag = Buffer.concat([ct, tag]);
  return PREFIX + toBase64(new Uint8Array(iv)) + ":" + toBase64(new Uint8Array(ctTag));
}

export function decryptValueSync(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored;
  const rest = stored.slice(PREFIX.length);
  const [ivB64, ctB64] = rest.split(":");
  if (!ivB64 || !ctB64) throw new Error("Malformed encrypted value");
  const key = getRawKeyBytes();
  const iv = fromBase64(ivB64);
  const ctTag = fromBase64(ctB64);
  if (ctTag.length < TAG_BYTES) throw new Error("Encrypted value too short");
  const ct = ctTag.subarray(0, ctTag.length - TAG_BYTES);
  const tag = ctTag.subarray(ctTag.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}
