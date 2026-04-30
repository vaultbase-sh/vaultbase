import * as jose from "jose";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { admin, tokenRevocations, users } from "../db/schema.ts";
import type { AuthContext } from "./rules.ts";

/**
 * Centralized auth-token verification.
 *
 * Verifies the signature, audience, expiry, issuer, and revocation list, then
 * (optionally) confirms the principal still exists in the database and that
 * `password_reset_at` is not newer than the token's `iat`. Returns null on any
 * failure so callers can produce a uniform 401 without leaking the cause.
 */
export interface VerifiedAuth extends AuthContext {
  jti?: string;
  exp?: number;
  iat?: number;
}

export const ISSUER = "vaultbase";

const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$cnVzdHl0cnVzdHk$0000000000000000000000000000000000000000000";

/**
 * Constant-time equivalent dummy hash for failed user lookups so login timing
 * is independent of whether the email exists.
 */
export function dummyPasswordHash(): string {
  return DUMMY_HASH;
}

function getSecret(jwtSecret: string): Uint8Array {
  return new TextEncoder().encode(jwtSecret);
}

/** True if `jti` was revoked. Cheap synchronous lookup. */
async function isRevoked(jti: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select()
    .from(tokenRevocations)
    .where(eq(tokenRevocations.jti, jti))
    .limit(1);
  return rows.length > 0;
}

interface VerifyOpts {
  audience?: "user" | "admin" | "file" | undefined;
  /** Re-confirm the user/admin row still exists. Defaults to true. */
  recheckPrincipal?: boolean;
}

export async function verifyAuthToken(
  token: string,
  jwtSecret: string,
  opts: VerifyOpts = {}
): Promise<VerifiedAuth | null> {
  const recheck = opts.recheckPrincipal ?? true;
  try {
    const verifyOpts: jose.JWTVerifyOptions = { issuer: ISSUER };
    if (opts.audience) verifyOpts.audience = opts.audience;
    const { payload } = await jose.jwtVerify(token, getSecret(jwtSecret), verifyOpts);

    const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
    if (aud !== "user" && aud !== "admin" && aud !== "file") return null;
    if (opts.audience && aud !== opts.audience) return null;

    if (typeof payload.jti === "string" && (await isRevoked(payload.jti))) return null;

    if (aud === "file") {
      // File tokens carry no principal — caller validates filename binding.
      return {
        id: "",
        type: "user",
        ...(typeof payload.jti === "string" ? { jti: payload.jti } : {}),
        ...(typeof payload.exp === "number" ? { exp: payload.exp } : {}),
        ...(typeof payload.iat === "number" ? { iat: payload.iat } : {}),
      };
    }

    const id = String(payload["id"] ?? "");
    if (!id) return null;
    const ctx: VerifiedAuth = { id, type: aud as "user" | "admin" };
    if (typeof payload["email"] === "string") ctx.email = payload["email"];
    if (typeof payload.jti === "string") ctx.jti = payload.jti;
    if (typeof payload.exp === "number") ctx.exp = payload.exp;
    if (typeof payload.iat === "number") ctx.iat = payload.iat;

    if (recheck) {
      const db = getDb();
      if (aud === "admin") {
        const rows = await db.select().from(admin).where(eq(admin.id, id)).limit(1);
        const a = rows[0];
        if (!a) return null;
        if (typeof ctx.iat === "number" && a.password_reset_at > ctx.iat) return null;
      } else {
        const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
        const u = rows[0];
        if (!u) return null;
      }
    }

    return ctx;
  } catch {
    return null;
  }
}

/** Mint a fresh signed JWT with `iss`, `jti`, and standard claims wired in. */
export async function signAuthToken(opts: {
  payload: jose.JWTPayload;
  audience: "user" | "admin" | "file";
  expiresInSeconds: number;
  jwtSecret: string;
}): Promise<{ token: string; jti: string; exp: number; iat: number }> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + opts.expiresInSeconds;
  const jti = crypto.randomUUID();
  const token = await new jose.SignJWT({ ...opts.payload, jti })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(opts.audience)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(getSecret(opts.jwtSecret));
  return { token, jti, exp, iat };
}

/** Add `jti` to the revocation list (idempotent). */
export async function revokeToken(jti: string, expiresAt: number): Promise<void> {
  try {
    await getDb().insert(tokenRevocations).values({
      jti,
      expires_at: expiresAt,
      revoked_at: Math.floor(Date.now() / 1000),
    });
  } catch {
    /* already revoked */
  }
}

/**
 * Storage filenames must be a single path segment with no traversal tokens.
 * Allows alphanumeric, underscore, dash, and a single trailing extension.
 * The upload flow always produces `<uuid>.<ext>`; this regex is permissive
 * enough for legacy / migrated filenames while still blocking `..`, `/`, `\`,
 * NUL, and any other separator.
 */
const STORAGE_FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}(\.[A-Za-z0-9]{1,12})?$/;

export function isValidStorageFilename(name: string): boolean {
  if (!name || name.length > 140) return false;
  if (name.includes("..") || name.includes("/") || name.includes("\\") || name.includes("\0")) return false;
  return STORAGE_FILENAME_RE.test(name);
}

const ALLOWED_UPLOAD_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/avif",
  "image/gif",
  "application/pdf",
  "text/plain",
  "application/json",
  "application/octet-stream",
]);

const SAFE_RENDER_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/avif",
  "image/gif",
]);

export function isSafeToRenderInline(mime: string): boolean {
  return SAFE_RENDER_MIME.has(mime.toLowerCase());
}

export function isAllowedUploadMime(mime: string): boolean {
  if (ALLOWED_UPLOAD_MIME.has(mime.toLowerCase())) return true;
  return mime.toLowerCase().startsWith("image/");
}

/**
 * IP extraction that respects only the immediate proxy when the listening
 * peer is in `VAULTBASE_TRUSTED_PROXIES`. Returns the socket peer otherwise.
 */
export function trustedClientIp(request: Request, peerIp: string | null): string {
  const trustedRaw = process.env["VAULTBASE_TRUSTED_PROXIES"] ?? "";
  if (!trustedRaw || !peerIp) return peerIp ?? "unknown";
  const trusted = new Set(trustedRaw.split(",").map((s) => s.trim()).filter(Boolean));
  if (!trusted.has(peerIp)) return peerIp;
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get("x-real-ip");
  if (real) return real;
  return peerIp;
}

/** HMAC-SHA256 for recovery-code O(1) lookup. Returns hex. */
export async function hmacRecoveryCode(code: string, jwtSecret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(jwtSecret) as unknown as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(code.trim().toUpperCase()) as unknown as ArrayBuffer
  );
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Extract a bearer token from `Authorization: Bearer …` OR the
 * `vaultbase_admin_token` / `vaultbase_user_token` cookie. Cookie path lets
 * the admin SPA migrate off `localStorage` without changing every API call.
 */
export function extractBearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (h) return h.replace(/^Bearer\s+/i, "").trim() || null;
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === "vaultbase_admin_token" || k === "vaultbase_user_token") {
      return v ? decodeURIComponent(v) : null;
    }
  }
  return null;
}

/** Suite of security headers attached to every response. */
export function securityHeaders(opts: { isApi?: boolean } = {}): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "interest-cohort=()",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  };
  if (!opts.isApi) {
    headers["Content-Security-Policy"] =
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
  }
  return headers;
}

/** Redact PII from email for log output. `alice@example.com` → `a***@example.com`. */
export function redactEmail(email: string | null | undefined): string {
  if (!email) return "<none>";
  const at = email.indexOf("@");
  if (at < 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at);
  return `${local[0]}***${domain}`;
}
