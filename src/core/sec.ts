import * as jose from "jose";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { verifyHs256 } from "./jwt-hs256.ts";
import { hmacSha256Hex } from "./hmac.ts";
import type { AuthContext } from "./rules.ts";
import { embeddedIPv4, parseCidr, ipInCidr, type ParsedCidr } from "./hook-egress.ts";
import { isIPv6 } from "node:net";
import { getTrustedProxiesRaw } from "./security.ts";

/**
 * Centralized auth-token verification.
 *
 * Verifies the signature, audience, expiry, issuer, and revocation list, then
 * (optionally) confirms the principal still exists in the database and that
 * `password_reset_at` is older than the token's `iat`. Returns null on any
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
  /**
   * User / admin tokens verified with the principal recheck: the
   * `password_reset_at` that check read. A caller that mints from this
   * verification carries it on (`rs`), so a reset landing after the read
   * still ends what it mints.
   */
  resetSeen?: number;
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

// The per-request lookups below go through the driver, which caches the
// compiled statement; a drizzle select re-prepared its SQL on every call.

/** True if `jti` was revoked. */
async function isRevoked(jti: string): Promise<boolean> {
  return (await db.get(`SELECT 1 FROM vaultbase_token_revocations WHERE jti = ? LIMIT 1`, [jti])) != null;
}

interface ApiTokenRow {
  name: string;
  scopes: string;
  created_by: string;
  created_by_email: string;
  revoked_at: number | null;
}

async function apiTokenById(jti: string): Promise<ApiTokenRow | null> {
  return await db.get<ApiTokenRow>(`SELECT name, scopes, created_by, created_by_email, revoked_at FROM vaultbase_api_tokens WHERE id = ? LIMIT 1`, [jti]);
}

async function adminResetAt(id: string): Promise<number | null> {
  const row = await db.get<{ password_reset_at: number }>(`SELECT password_reset_at FROM vaultbase_admin WHERE id = ? LIMIT 1`, [id]);
  return row ? row.password_reset_at : null;
}

/**
 * `password_reset_at` in unix milliseconds. Stamps written before it moved
 * to milliseconds are whole seconds; such a stamp ended every token issued
 * in its second, so it counts as the last millisecond of that second.
 */
export function resetStampMs(stamp: number): number {
  return stamp > 0 && stamp < 100_000_000_000 ? stamp * 1000 + 999 : stamp;
}

/** When a token was issued, in unix milliseconds: `iat_ms`, or `iat` for tokens minted before that claim. */
function tokenIssuedMs(payload: Record<string, unknown>): number | null {
  if (typeof payload["iat_ms"] === "number") return payload["iat_ms"];
  return typeof payload["iat"] === "number" ? payload["iat"] * 1000 : null;
}

/** A reset stamped at `stamp` ends tokens issued at or before it, by `iat_ms` / `iat`. */
function issuedByResetAt(stamp: number, payload: Record<string, unknown>): boolean {
  const issued = tokenIssuedMs(payload);
  return issued !== null && stamp > 0 && resetStampMs(stamp) >= issued;
}

/**
 * Whether a password reset (or sign-out-all) ended this token. A token that
 * carries `rs` (the principal's `password_reset_at` read when its credential
 * was checked) is ended by any change to the stamp since: no clocks are
 * compared, so a server whose clock runs ahead of the one that stamped the
 * reset can't mint a session that outlives it, and a sign-in right after a
 * reset is good at once. Tokens without the claim fall back to `iat_ms`.
 */
function endedByReset(stamp: number, payload: Record<string, unknown>): boolean {
  if (typeof payload["rs"] === "number") return stamp !== payload["rs"];
  return issuedByResetAt(stamp, payload);
}

/**
 * The current `password_reset_at` of the principal behind a verified user /
 * admin token, or null when the principal is gone.
 */
export async function principalResetStamp(ctx: { id: string; type: string; collection?: string | undefined }): Promise<number | null> {
  if (ctx.type === "admin") return await adminResetAt(ctx.id);
  if (!ctx.collection) return null;
  const { getCollection } = await import("./collections.ts");
  const col = await getCollection(ctx.collection);
  if (!col) return null;
  const { findUserById } = await import("./users-table.ts");
  const u = await findUserById(col, ctx.id);
  return u ? (typeof u.password_reset_at === "number" ? u.password_reset_at : 0) : null;
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
  // API tokens are handed out as vbat_<jwt>; take them that way wherever a
  // token arrives (realtime auth messages, SSE, request bodies).
  if (token.startsWith("vbat_")) token = token.slice(5);
  try {
    const payload = verifyHs256(token, jwtSecret, { issuer: ISSUER, ...(opts.audience ? { audience: opts.audience } : {}) });
    if (!payload) return null;

    const aud = Array.isArray(payload["aud"]) ? payload["aud"][0] : payload["aud"];
    if (aud !== "user" && aud !== "admin" && aud !== "file" && aud !== "api") return null;
    if (opts.audience && aud !== opts.audience) return null;
    // File tokens are download grants, not sessions: only a caller that asks
    // for them explicitly gets one back.
    if (!opts.audience && aud === "file") return null;

    if (typeof payload["jti"] === "string" && (await isRevoked(payload["jti"]))) return null;

    if (aud === "api") {
      // API tokens map to the admin who minted them. Scopes are pulled
      // from the DB row so a token's effective permissions can be tightened
      // post-mint without re-issuing — the JWT's claims are advisory.
      if (typeof payload["jti"] !== "string") return null;
      const tok = await apiTokenById(payload["jti"]);
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
        jti: payload["jti"],
        scopes,
        tokenName: tok.name,
        viaApiToken: true,
      };
      if (typeof payload["exp"] === "number") ctx.exp = payload["exp"];
      if (typeof payload["iat"] === "number") ctx.iat = payload["iat"];
      // recheckPrincipal still verifies the admin row exists / wasn't force-
      // logged-out before mint — a leaked token still goes invalid when the
      // minting admin's password is reset.
      if (recheck) {
        const resetAt = await adminResetAt(tok.created_by);
        if (resetAt === null) return null;
        if (issuedByResetAt(resetAt, payload)) return null;
      }
      return ctx;
    }

    if (aud === "file") {
      // File tokens carry no principal — caller validates filename binding.
      return {
        id: "",
        type: "user",
        ...(typeof payload["jti"] === "string" ? { jti: payload["jti"] } : {}),
        ...(typeof payload["exp"] === "number" ? { exp: payload["exp"] } : {}),
        ...(typeof payload["iat"] === "number" ? { iat: payload["iat"] } : {}),
      };
    }

    const id = String(payload["id"] ?? "");
    if (!id) return null;
    const ctx: VerifiedAuth = { id, type: aud as "user" | "admin" };
    if (typeof payload["email"] === "string") ctx.email = payload["email"];
    if (typeof payload["jti"] === "string") ctx.jti = payload["jti"];
    if (typeof payload["exp"] === "number") ctx.exp = payload["exp"];
    if (typeof payload["iat"] === "number") ctx.iat = payload["iat"];
    if (aud === "user") {
      if (typeof payload["collection"] === "string") ctx.collection = payload["collection"];
      if (payload["anonymous"] === true) ctx.anonymous = true;
    }

    if (recheck) {
      if (aud === "admin") {
        const resetAt = await adminResetAt(id);
        if (resetAt === null) return null;
        if (endedByReset(resetAt, payload)) return null;
        ctx.resetSeen = resetAt;
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
        const u = await findUserById(col, id);
        if (!u) return null;
        // password_reset_at on per-collection table — bumping it (via
        // force-logout-all) invalidates this token.
        if (typeof u.password_reset_at === "number" && endedByReset(u.password_reset_at, payload)) {
          return null;
        }
        ctx.resetSeen = typeof u.password_reset_at === "number" ? u.password_reset_at : 0;
        // An impersonation session acts for the admin who minted it: it ends
        // with that admin (deleted, password reset, force-logout-all), as an
        // API token does. By `iat_ms`: `rs` is the user's stamp, not theirs.
        if (typeof payload["impersonated_by"] === "string") {
          const adminReset = await adminResetAt(payload["impersonated_by"]);
          if (adminReset === null || issuedByResetAt(adminReset, payload)) return null;
        }
        // Read from the row, not the token, so verifying takes effect at once.
        if (u.email_verified === 1) ctx.verified = true;
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
  if (ctx.collection) out.collection = ctx.collection;
  if (ctx.anonymous) out.anonymous = true;
  if (ctx.verified) out.verified = true;
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
  /** Re-mint a token that was already issued: same jti and issue time give the same bytes. */
  reissue?: { jti: string; iat: number; iatMs?: number };
  /**
   * When the credential behind this token was checked (unix milliseconds).
   * `password_reset_at` ends tokens issued at or before it, so dating a
   * sign-in by its check, not by when signing finished, ends one whose
   * password was checked before a reset that landed in between.
   */
  issuedAtMs?: number;
  /**
   * The principal's `password_reset_at` read with the credential check,
   * carried as `rs`: any reset after that read ends the token, whatever the
   * clocks of the servers involved say (see endedByReset).
   */
  resetSeen?: number;
}): Promise<{ token: string; jti: string; exp: number; iat: number; iatMs: number }> {
  const iatMs = opts.reissue ? (opts.reissue.iatMs ?? opts.reissue.iat * 1000) : (opts.issuedAtMs ?? Date.now());
  const iat = opts.reissue?.iat ?? Math.floor(iatMs / 1000);
  const exp = iat + opts.expiresInSeconds;
  const jti = opts.reissue?.jti ?? crypto.randomUUID();
  // `iat_ms` after the caller's claims: a refresh copies the old token's.
  const token = await new jose.SignJWT({ ...opts.payload, jti, iat_ms: iatMs, ...(opts.resetSeen !== undefined ? { rs: opts.resetSeen } : {}) })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(opts.audience)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(getSecret(opts.jwtSecret));
  return { token, jti, exp, iat, iatMs };
}

/**
 * `password_reset_at` (unix ms) ends every token issued at or before it.
 * Callers that stamp a reset wait until the clock has passed the stamp
 * before issuing a token or answering, so the next sign-in isn't ended by
 * a reset in the same millisecond.
 */
export async function waitPastReset(stampMs: number): Promise<void> {
  const ms = stampMs + 1 - Date.now();
  if (ms > 0) await Bun.sleep(ms);
}

/** Add `jti` to the revocation list (idempotent). */
export async function revokeToken(jti: string, expiresAt: number): Promise<void> {
  // Through the driver, not drizzle: a sign-out made while another request's
  // transaction is open waits for it instead of landing inside it, where a
  // rollback would undo it.
  await db.run(
    `INSERT INTO vaultbase_token_revocations (jti, expires_at, revoked_at) VALUES (?, ?, ?) ON CONFLICT(jti) DO NOTHING`,
    [jti, expiresAt, Math.floor(Date.now() / 1000)],
  );
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

/**
 * `::ffff:a.b.c.d` → `a.b.c.d`. A server listening on IPv6 sees IPv4 peers
 * in this mapped form, which never matched `127.0.0.1` or `10.0.0.0/8` in
 * the trusted-proxy list: the proxy's forwarded address was ignored and every
 * client shared its rate-limit bucket.
 */
export function normalizePeerIp(ip: string): string {
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return m ? m[1]! : ip;
}

function isTrustedProxy(ip: string): boolean {
  ip = normalizePeerIp(ip);
  const t = getTrustedProxies();
  if (!t) return false;
  if (t.bare.has(ip)) return true;
  for (const c of t.cidrs) {
    if (ipInCidr(ip, c)) return true;
  }
  return false;
}

const LOOPBACK_CIDRS = ["127.0.0.0/8", "::1/128"].map((c) => parseCidr(c)!);

/**
 * The address to apply a per-client cap to, or null to skip that cap. With
 * no trusted proxies configured, every client behind a reverse proxy shares
 * the proxy's address, and a per-IP cap on it is a cap on the whole site; so
 * the cap is skipped for a loopback peer (a proxy on this host). Any other
 * peer is capped by its own address — whether a request is "forwarded" can't
 * be told from headers the client writes. A proxy on another host needs
 * `security.trusted_proxies`. Global caps always apply.
 */
export function perClientLimitIp(request: Request | null, peerIp: string | null): string | null {
  if (!peerIp) return null;
  peerIp = normalizePeerIp(peerIp);
  if (!getTrustedProxies()) {
    if (LOOPBACK_CIDRS.some((c) => ipInCidr(peerIp!, c))) return null;
    return rateLimitKeyForIp(peerIp);
  }
  // An IPv6 client is capped by its /64, as the rate limiter keys it: one
  // subscriber holds the whole /64, and per-address caps let it fill the
  // global connection cap alone.
  return rateLimitKeyForIp(request ? trustedClientIp(request, peerIp) : peerIp);
}

/**
 * The bucket key for a client address. IPv6 is keyed by its /64: one
 * subscriber typically holds a whole /64, so per-address buckets gave a
 * single client 2^64 fresh budgets. IPv4-mapped addresses count as IPv4.
 */
export function rateLimitKeyForIp(ip: string): string {
  if (!isIPv6(ip)) return ip;
  const groups = expandIPv6Groups(ip);
  if (!groups) return ip;
  if (groups.slice(0, 5).every((g) => /^0+$/.test(g)) && groups[5] === "ffff") return embeddedIPv4(ip) ?? ip;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

function expandIPv6Groups(ip: string): string[] | null {
  const bare = ip.split("%")[0]!.toLowerCase();
  // An embedded dotted IPv4 tail counts as two groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  const norm = v4 ? bare.slice(0, -v4[1]!.length) + "0:0" : bare;
  const [head = "", tail = ""] = norm.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  if (norm.includes("::")) {
    const fill = 8 - h.length - t.length;
    if (fill < 0) return null;
    return [...h, ...Array(fill).fill("0"), ...t];
  }
  return h.length === 8 ? h : null;
}


export function trustedClientIp(request: Request, peerIp: string | null): string {
  if (!peerIp) return "unknown";
  peerIp = normalizePeerIp(peerIp);
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

/** The socket peer recorded for `request` by the server, or null. */
export function rememberedPeer(request: Request): string | null {
  return requestPeers.get(request) ?? null;
}

export function rememberPeer(request: Request, ip: string | null): void {
  requestPeers.set(request, ip === null ? null : normalizePeerIp(ip));
}

/**
 * The socket peer of `request`: the one recorded for it, otherwise Bun's
 * `server.requestIP()`. A request a read worker hands to the main thread
 * (core/worker-listeners.ts) arrives over loopback with its client's peer
 * recorded, so readers of the peer go through here, not `requestIP()`.
 */
export function peerAddress(request: Request, server: unknown): string | null {
  if (requestPeers.has(request)) return requestPeers.get(request) ?? null;
  try {
    return (server as { requestIP?: (r: Request) => { address: string } | null } | null)?.requestIP?.(request)?.address ?? null;
  } catch { return null; }
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

/**
 * The address a sign-in lockout counts failures for, or null to count by
 * account only. Same rule as the per-client connection caps: behind a
 * reverse proxy on this host with no trusted proxies configured, every
 * client is the proxy's loopback address, and one per-IP counter for all
 * of them let anyone lock every account out by failing sign-ins.
 */
export function lockoutIp(request: Request): string | null {
  const peer = requestPeers.get(request);
  return peer === undefined || peer === null ? null : perClientLimitIp(request, peer);
}

/** HMAC-SHA256 for recovery-code O(1) lookup. Returns hex. */
export async function hmacRecoveryCode(code: string, jwtSecret: string): Promise<string> {
  return hmacSha256Hex(jwtSecret, code.trim().toUpperCase());
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
 * The token in the Authorization header, without `Bearer ` and without the
 * `vbat_` prefix API tokens carry. Header only (no cookie): see
 * extractBearer for the cookie-aware form.
 */
export function headerBearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const raw = h.replace(/^Bearer(?:\s+|$)/i, "").trim();
  if (!raw) return null;
  return raw.startsWith("vbat_") ? raw.slice(5) : raw;
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
  // A non-empty header decides, even with no token in it (`Bearer `).
  if (request.headers.get("authorization")) return headerBearer(request);
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  if (!isSameOriginRequest(request)) return null;
  for (const part of cookieHeader.split(";")) {
    const at = part.indexOf("=");
    const k = (at < 0 ? part : part.slice(0, at)).trim();
    if (k !== "vaultbase_admin_token" && k !== "vaultbase_user_token") continue;
    const v = at < 0 ? "" : part.slice(at + 1).trim();
    // A malformed escape (`%zz`) is no token, not an error answered with 500.
    try { return v ? decodeURIComponent(v) : null; } catch { return null; }
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
