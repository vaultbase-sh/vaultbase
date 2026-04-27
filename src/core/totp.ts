import { createHmac, randomBytes } from "node:crypto";

// RFC 6238 TOTP — single 6-digit code, 30-second step, HMAC-SHA1.
// Implementation deliberately avoids any external dependency.

const STEP_SECONDS = 30;
const DIGITS = 6;

// ── Base32 (RFC 4648) ────────────────────────────────────────────────────────

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i]!;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  // No padding — authenticator apps don't care, and bare base32 is more portable.
  return out;
}

export function base32Decode(input: string): Uint8Array {
  const cleaned = input.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of cleaned) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

// ── Secret + URL ─────────────────────────────────────────────────────────────

/** 20-byte secret encoded as base32 — the standard length for SHA1 TOTP. */
export function generateSecret(): string {
  return base32Encode(new Uint8Array(randomBytes(20)));
}

/** Build the otpauth:// URL that authenticator apps scan via QR. */
export function buildOtpauthUrl(opts: {
  secret: string;
  accountName: string;
  issuer: string;
}): string {
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.accountName)}`;
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ── Code generation + verification ───────────────────────────────────────────

function counterAt(unixSeconds: number): Buffer {
  const counter = Math.floor(unixSeconds / STEP_SECONDS);
  const buf = Buffer.alloc(8);
  // Counter is uint64 big-endian; JS bitwise ops are 32-bit so split.
  buf.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  buf.writeUInt32BE(counter & 0xffff_ffff, 4);
  return buf;
}

/** Generate the TOTP code for a given secret + time (defaults to now). */
export function generateCode(secret: string, unixSeconds: number = Math.floor(Date.now() / 1000)): string {
  const key = base32Decode(secret);
  const hmac = createHmac("sha1", Buffer.from(key)).update(counterAt(unixSeconds)).digest();
  // Dynamic truncation per RFC 4226 §5.4
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  const code = binary % 10 ** DIGITS;
  return code.toString().padStart(DIGITS, "0");
}

/**
 * Verify a TOTP code with ±1 step drift to tolerate clock skew. Constant-time
 * comparison so timing leaks can't reveal partial matches.
 */
export function verifyCode(secret: string, code: string, unixSeconds: number = Math.floor(Date.now() / 1000)): boolean {
  if (typeof code !== "string" || code.length !== DIGITS) return false;
  for (const offset of [0, -STEP_SECONDS, STEP_SECONDS]) {
    const candidate = generateCode(secret, unixSeconds + offset);
    if (timingSafeEqual(candidate, code)) return true;
  }
  return false;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
