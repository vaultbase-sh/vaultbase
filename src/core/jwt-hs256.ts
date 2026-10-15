/**
 * Synchronous HS256 JWT verification for the request path.
 *
 * jose verifies through WebCrypto: it imports the key, base64-decodes with
 * `atob` and awaits `subtle.verify` on every call, which showed as ~7 % of
 * request CPU with the same token arriving thousands of times a second.
 * This checks the signature with `node:crypto` in a few microseconds and
 * remembers the parsed payload per token, so a token seen before costs a
 * Map lookup plus the claim checks.
 *
 * Only the signature and the structure are cached; `exp`, `nbf`, `iss` and
 * `aud` are checked on every call. Revocation and principal checks stay in
 * `verifyAuthToken`. Signing still goes through jose.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface VerifyHs256Options {
  issuer?: string;
  audience?: string;
  /** Unix seconds; defaults to the clock. */
  now?: number;
}

const CACHE_MAX = 2048;
const cache = new Map<string, { secret: string; payload: Record<string, unknown> }>();

const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

function segment(s: string): Buffer | null {
  return SEGMENT_RE.test(s) ? Buffer.from(s, "base64url") : null;
}

/** Signature and shape only. Returns the payload, cached per token. */
function signedPayload(token: string, secret: string): Record<string, unknown> | null {
  const hit = cache.get(token);
  if (hit) {
    if (hit.secret === secret) return hit.payload;
    cache.delete(token);
  }
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const header = segment(h);
  const body = segment(p);
  const sig = segment(s);
  if (!header || !body || !sig || sig.length !== 32) return null;
  let hdr: unknown;
  try { hdr = JSON.parse(header.toString("utf8")); } catch { return null; }
  if (!hdr || typeof hdr !== "object" || (hdr as { alg?: unknown }).alg !== "HS256") return null;
  // A `crit` header asks for extensions this verifier doesn't know.
  if ((hdr as { crit?: unknown }).crit !== undefined) return null;
  const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  if (!timingSafeEqual(expected, sig)) return null;
  let payload: unknown;
  try { payload = JSON.parse(body.toString("utf8")); } catch { return null; }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(token, { secret, payload: payload as Record<string, unknown> });
  return payload as Record<string, unknown>;
}

/**
 * Verify an HS256 JWT signed with `secret` (UTF-8 bytes, as jose used it)
 * and check its registered claims the way `jose.jwtVerify` does: `iss` and
 * `aud` must match when asked for, `exp` must be in the future, `nbf` must
 * have passed. Returns the payload, or null for any failure.
 */
export function verifyHs256(token: string, secret: string, opts: VerifyHs256Options = {}): Record<string, unknown> | null {
  const payload = signedPayload(token, secret);
  if (!payload) return null;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (opts.issuer !== undefined && payload["iss"] !== opts.issuer) return null;
  if (opts.audience !== undefined) {
    const aud = payload["aud"];
    const ok = typeof aud === "string" ? aud === opts.audience : Array.isArray(aud) && aud.includes(opts.audience);
    if (!ok) return null;
  }
  const exp = payload["exp"];
  if (exp !== undefined && (typeof exp !== "number" || exp <= now)) return null;
  const nbf = payload["nbf"];
  if (nbf !== undefined && (typeof nbf !== "number" || nbf > now)) return null;
  const iat = payload["iat"];
  if (iat !== undefined && typeof iat !== "number") return null;
  return payload;
}

/** Test hook. */
export function _resetJwtCache(): void {
  cache.clear();
}
