import * as jose from "jose";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { admin, apiTokens, tokenRevocations } from "../db/schema.ts";
import type { AuthContext } from "./rules.ts";
import { parseCidr, ipInCidr, embeddedIPv4, type ParsedCidr } from "./hook-egress.ts";
import { getTrustedProxiesRaw } from "./security.ts";

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
  /**
   * Scopes carried by an API-token-backed request. Empty / undefined for
   * direct user / admin JWT auth — those have full audience-scope access.
   * Endpoint-level guards check this via `core/api-tokens.hasScope()`.
   */
  scopes?: string[];
  /** Display name of the API token, when authenticated via one. */
  tokenName?: string;
  /**
   * True when this auth came from an API token rather than a user-/admin-
   * initiated session. Used for audit-log labelling + scope enforcement.
   */
  viaApiToken?: boolean;
  /** User tokens: the auth collection the user belongs to. */
  collection?: string;
  /** User tokens: an anonymous (guest) session. */
  anonymous?: boolean;
}

export const ISSUER = "vaultbase";

/**
 * Pinned argon2id parameters so a Bun upgrade cannot silently downgrade
 * password hashing. Used by every code path that calls `Bun.password.hash`
 * — see also `admins.ts` and `auth.ts`.
 *
 * memoryCost = 19456 (≈19 MiB) and timeCost = 2 are OWASP's 2024 baseline
 * for argon2id.
 */
export const HASH_OPTS = { algorithm: "argon2id" as const, memoryCost: 19456, timeCost: 2 };

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
  audience?: "user" | "admin" | "file" | "api" | undefined;
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
    if (aud !== "user" && aud !== "admin" && aud !== "file" && aud !== "api") return null;
    if (opts.audience && aud !== opts.audience) return null;
    // File tokens are download grants, not sessions: only a caller that asks
    // for them explicitly gets one back.
    if (!opts.audience && aud === "file") return null;

    if (typeof payload.jti === "string" && (await isRevoked(payload.jti))) return null;

    if (aud === "api") {
      // API tokens map to the admin who minted them. Scopes are pulled
      // from the DB row so a token's effective permissions can be tightened
      // post-mint without re-issuing — the JWT's claims are advisory.
      if (typeof payload.jti !== "string") return null;
      const rows = await getDb().select().from(apiTokens).where(eq(apiTokens.id, payload.jti)).limit(1);
      const tok = rows[0];
      if (!tok || tok.revoked_at != null) return null;
      let scopes: string[] = [];
      try {
        const p = JSON.parse(tok.scopes);
        if (Array.isArray(p)) scopes = p.filter((s): s is string => typeof s === "string");
      } catch { /* malformed — empty */ }
      // The principal is the minting admin; rule engine + admin endpoints
      // see them as that admin. Scope middleware further restricts what
      // the token may DO across the surface that the admin could.
      const ctx: VerifiedAuth = {
        id: tok.created_by,
        type: "admin",
        email: tok.created_by_email,
        jti: payload.jti,
        scopes,
        tokenName: tok.name,
        viaApiToken: true,
      };
      if (typeof payload.exp === "number") ctx.exp = payload.exp;
      if (typeof payload.iat === "number") ctx.iat = payload.iat;
      // recheckPrincipal still verifies the admin row exists / wasn't force-
      // logged-out before mint — a leaked token still goes invalid when the
      // minting admin's password is reset.
      if (recheck) {
        const aRows = await getDb().select().from(admin).where(eq(admin.id, tok.created_by)).limit(1);
        const a = aRows[0];
        if (!a) return null;
        if (typeof ctx.iat === "number" && a.password_reset_at > ctx.iat) return null;
      }
      return ctx;
    }

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
    if (aud === "user") {
      if (typeof payload["collection"] === "string") ctx.collection = payload["collection"];
      if (payload["anonymous"] === true) ctx.anonymous = true;
    }

    if (recheck) {
      const db = getDb();
      if (aud === "admin") {
        const rows = await db.select().from(admin).where(eq(admin.id, id)).limit(1);
        const a = rows[0];
        if (!a) return null;
        if (typeof ctx.iat === "number" && a.password_reset_at > ctx.iat) return null;
      } else {
        // v0.11: user-token recheck routes to `vb_<col>` via the JWT
        // `collection` claim. Tokens minted before v0.11 lack the claim
        // and now hard-fail — users re-login on upgrade. Documented.
        const collectionName = typeof payload["collection"] === "string"
          ? payload["collection"] : null;
        if (!collectionName) return null;
        const { getCollection } = await import("./collections.ts");
        const col = await getCollection(collectionName);
        if (!col) return null;
        const { findUserById } = await import("./users-table.ts");
        const u = findUserById(col, id);
        if (!u) return null;
        // password_reset_at on per-collection table — bumping it (via
        // force-logout-all) invalidates this token.
        if (typeof ctx.iat === "number" && typeof u.password_reset_at === "number" && u.password_reset_at > ctx.iat) {
          return null;
        }
      }
    }

    return ctx;
  } catch {
    return null;
  }
}

/**
 * The principal a verified token acts as on the data API (records, files,
 * batch, realtime). User and admin sessions pass through. API tokens follow
 * their scopes: `admin` is the minting admin; `read` gets admin-level reads;
 * `write` gets mutations as a non-admin principal, so collection rules still
 * apply; anything else is treated as anonymous. Never more than anonymous for
 * a token without the scope, so a narrow token can't escalate.
 */
export function dataPrincipal(ctx: VerifiedAuth | null, access: "read" | "write"): AuthContext | null {
  if (!ctx || (ctx.type !== "user" && ctx.type !== "admin")) return null;
  if (ctx.viaApiToken) {
    const scopes = ctx.scopes ?? [];
    const asAdmin = scopes.includes("admin") || (access === "read" && scopes.includes("read"));
    if (!asAdmin) {
      return access === "write" && scopes.includes("write")
        ? { id: `api:${ctx.jti ?? ""}`, type: "user" }
        : null;
    }
  }
  const out: AuthContext = { id: ctx.id, type: ctx.type };
  if (ctx.email) out.email = ctx.email;
  return out;
}

/** Read vs write for `dataPrincipal`, from the HTTP method. */
export function accessFor(request: Request): "read" | "write" {
  return request.method === "GET" || request.method === "HEAD" ? "read" : "write";
}

/** Mint a fresh signed JWT with `iss`, `jti`, and standard claims wired in. */
export async function signAuthToken(opts: {
  payload: jose.JWTPayload;
  audience: "user" | "admin" | "file" | "api";
  expiresInSeconds: number;
  jwtSecret: string;
  /** Re-mint a token that was already issued: same jti and iat give the same bytes. */
  reissue?: { jti: string; iat: number };
}): Promise<{ token: string; jti: string; exp: number; iat: number }> {
  const iat = opts.reissue?.iat ?? Math.floor(Date.now() / 1000);
  const exp = iat + opts.expiresInSeconds;
  const jti = opts.reissue?.jti ?? crypto.randomUUID();
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
 * IP extraction that respects `X-Forwarded-For` only when the immediate peer
 * is in `VAULTBASE_TRUSTED_PROXIES`. Returns the socket peer otherwise.
 *
 * Trust list accepts both bare IPs (`10.0.0.5`) and CIDR ranges
 * (`10.0.0.0/8`, `2001:db8::/32`) — the typical "everything from my private
 * cluster" case shouldn't require enumerating every replica IP. Backwards-
 * compatible with the v0.10 string-set form: bare IPs without `/` are still
 * matched as exact peers.
 *
 * Parsed CIDR list is cached per-process; env reads are cheap but the regex
 * parse isn't.
 */
let _trustedProxiesCache: { raw: string; cidrs: ParsedCidr[]; bare: Set<string> } | null = null;

function getTrustedProxies(): { cidrs: ParsedCidr[]; bare: Set<string> } | null {
  // Settings → Security → Trusted proxies wins over the env var, the same
  // precedence getTrustedProxiesRaw() documents; this used to read the env
  // var only, so the setting changed lockout keys but not rate limits.
  const raw = getTrustedProxiesRaw();
  if (!raw) return null;
  if (_trustedProxiesCache && _trustedProxiesCache.raw === raw) {
    return { cidrs: _trustedProxiesCache.cidrs, bare: _trustedProxiesCache.bare };
  }
  const cidrs: ParsedCidr[] = [];
  const bare = new Set<string>();
  for (const tok of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (tok.includes("/")) {
      const c = parseCidr(tok);
      if (c) cidrs.push(c);
      // Silently skip malformed entries; operator notices via logs/metrics.
    } else {
      bare.add(tok);
    }
  }
  _trustedProxiesCache = { raw, cidrs, bare };
  return { cidrs, bare };
}

function isTrustedProxy(ip: string): boolean {
  const t = getTrustedProxies();
  if (!t) return false;
  if (t.bare.has(ip)) return true;
  for (const c of t.cidrs) {
    if (ipInCidr(ip, c)) return true;
  }
  return false;
}

const LOCAL_NETWORK_CIDRS = [
  "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
  "::1/128", "fc00::/7", "fe80::/10",
].map((c) => parseCidr(c)!);

/**
 * The address to apply a per-client cap to, or null to skip that cap. With
 * no trusted proxies configured, a peer on loopback or a private network is
 * most likely a reverse proxy that every client arrives through — a per-IP
 * cap keyed on it would be a cap on the whole site. Global caps still apply.
 */
export function perClientLimitIp(request: Request | null, peerIp: string | null): string | null {
  if (!peerIp) return null;
  if (!getTrustedProxies()) {
    const ip = embeddedIPv4(peerIp) ?? peerIp;
    if (LOCAL_NETWORK_CIDRS.some((c) => ipInCidr(ip, c))) return null;
    return peerIp;
  }
  return request ? trustedClientIp(request, peerIp) : peerIp;
}

export function trustedClientIp(request: Request, peerIp: string | null): string {
  if (!peerIp) return "unknown";
  if (!isTrustedProxy(peerIp)) return peerIp;
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    // Walk right to left: each trusted proxy appends the address it got the
    // request from, so the rightmost entry that isn't one of our proxies is
    // the client. The leftmost entry is whatever the client chose to send.
    const hops = fwd.split(",").map((h) => h.trim()).filter(Boolean);
    for (let i = hops.length - 1; i >= 0; i--) {
      if (!isTrustedProxy(hops[i]!)) return hops[i]!;
    }
    if (hops[0]) return hops[0];
  }
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  return peerIp;
}

/**
 * The socket peer of each request, recorded by the server as the request
 * comes in, so code without access to Bun's `server.requestIP()` (audit log,
 * lockout, logs, custom routes) can still apply the trusted-proxy rule
 * instead of reading X-Forwarded-For on its own.
 */
const requestPeers = new WeakMap<Request, string | null>();

export function rememberPeer(request: Request, ip: string | null): void {
  requestPeers.set(request, ip);
}

/**
 * Whether the client reached us over HTTPS: the request URL itself, or a
 * trusted proxy saying so in X-Forwarded-Proto (a TLS-terminating proxy, the
 * deployment the guide recommends, hands us plain http).
 */
export function requestIsHttps(request: Request): boolean {
  if (new URL(request.url).protocol === "https:") return true;
  const peer = requestPeers.get(request);
  if (!peer || !isTrustedProxy(peer)) return false;
  return (request.headers.get("x-forwarded-proto") ?? "").split(",")[0]!.trim().toLowerCase() === "https";
}

/**
 * The client's address for `request`, by the trusted-proxy rule above. Null
 * when the peer is unknown (a request that didn't come through the server),
 * rather than trusting a header nothing vouched for.
 */
export function clientIp(request: Request): string | null {
  const peer = requestPeers.get(request);
  if (peer === undefined || peer === null) return null;
  return trustedClientIp(request, peer);
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
 * Whether a request demonstrably originated from this site, or from something
 * that is not a browser at all.
 *
 * `Sec-Fetch-Site` is computed by the browser and survives reverse proxying,
 * so it is the primary signal. `none` means a user-initiated navigation (a
 * typed URL or a bookmark), which is not a cross-site attack. When the header
 * is absent the client is not a modern browser: fall back to comparing
 * `Origin` against the request's own host, and allow when there is no `Origin`
 * either — a non-browser client does not attach cookies by accident.
 *
 * `same-site` is deliberately *not* accepted. The cookies below are host-only
 * (no `Domain=`), so a sibling subdomain never receives them anyway, and
 * treating a subdomain as trusted would turn any XSS there into admin access
 * here.
 */
export function isSameOriginRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

/**
 * Extract a bearer token from `Authorization: Bearer …` OR the
 * `vaultbase_admin_token` / `vaultbase_user_token` cookie. Cookie path lets
 * the admin SPA migrate off `localStorage` without changing every API call.
 *
 * The cookie is only honoured on a same-origin request. It is ambient
 * authority — the browser attaches it to *any* request to this host, including
 * one a third-party page caused — and it is accepted on `/admin/sql/run`,
 * `/admin/api-tokens` and `/admin/mcp`. `SameSite=Lax` blocks cross-site form
 * posts but still rides along on top-level GET navigations, so the check is
 * made here rather than relied upon from the cookie attribute alone.
 *
 * `Authorization` needs no such check: a cross-site page cannot set that
 * header without a CORS preflight the server never approves.
 *
 * Also strips the `vbat_` API-token prefix when present so downstream
 * callers always see a raw JWT — the prefix is purely for log-scanner /
 * secret-scanning detection on the wire.
 */
export function extractBearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (h) {
    const raw = h.replace(/^Bearer\s+/i, "").trim();
    if (!raw) return null;
    return raw.startsWith("vbat_") ? raw.slice(5) : raw;
  }
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  if (!isSameOriginRequest(request)) return null;
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
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob: https://*.tile.openstreetmap.org; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
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
