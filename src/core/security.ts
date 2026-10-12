/**
 * Backend for the **Settings → Security** tab.
 *
 *   - Active admin sessions (vaultbase_admin_sessions): record on issue,
 *     listed via UI, revoked one-by-one or all-at-once.
 *   - Brute-force lockout (vaultbase_login_failures): records failed
 *     login attempts keyed by email + ip; checks reject within window.
 *   - Trusted proxies: setting overrides VAULTBASE_TRUSTED_PROXIES env.
 *   - Secrets fingerprints: SHA-256 first 8 hex chars of JWT/AES keys.
 *   - Security headers preview: render what the server sends.
 */
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { adminSessions, admin as adminTable, loginFailures, tokenRevocations } from "../db/schema.ts";
import { getSetting } from "../api/settings.ts";

// ── Trusted proxies ─────────────────────────────────────────────────────────

/**
 * Setting overrides env. Empty / blank → returns whatever env says.
 * Format on both sides: comma-separated CIDRs or single IPs.
 */
export function getTrustedProxiesRaw(): string {
  const setting = (getSetting("security.trusted_proxies", "") || "").trim();
  if (setting) return setting;
  return (process.env["VAULTBASE_TRUSTED_PROXIES"] ?? "").trim();
}

// ── Admin sessions ──────────────────────────────────────────────────────────

interface RecordSessionOpts {
  jti: string;
  admin_id: string;
  admin_email: string;
  issued_at: number;
  expires_at: number;
  request: Request;
}

export async function recordAdminSession(opts: RecordSessionOpts): Promise<void> {
  const db = getDb();
  const ua = opts.request.headers.get("user-agent") ?? null;
  const ip = clientIpFromRequest(opts.request);
  await db.insert(adminSessions).values({
    jti: opts.jti,
    admin_id: opts.admin_id,
    admin_email: opts.admin_email,
    issued_at: opts.issued_at,
    expires_at: opts.expires_at,
    ip,
    user_agent: ua ? ua.slice(0, 240) : null,
  }).onConflictDoNothing();
}

export interface AdminSessionRow {
  jti: string;
  admin_id: string;
  admin_email: string;
  issued_at: number;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
  revoked: boolean;
}

export async function listAdminSessions(opts: { activeOnly?: boolean } = {}): Promise<AdminSessionRow[]> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const rows = opts.activeOnly
    ? await db.select().from(adminSessions).where(gte(adminSessions.expires_at, now)).orderBy(desc(adminSessions.issued_at))
    : await db.select().from(adminSessions).orderBy(desc(adminSessions.issued_at));

  // Cross-reference revocation list once.
  const revs = await db.select({ jti: tokenRevocations.jti }).from(tokenRevocations);
  const revoked = new Set(revs.map((r) => r.jti));

  return rows.map((r) => ({
    jti: r.jti,
    admin_id: r.admin_id,
    admin_email: r.admin_email,
    issued_at: r.issued_at,
    expires_at: r.expires_at,
    ip: r.ip,
    user_agent: r.user_agent,
    revoked: revoked.has(r.jti),
  }));
}

export async function revokeAdminSession(jti: string): Promise<void> {
  const db = getDb();
  const rows = await db.select().from(adminSessions).where(eq(adminSessions.jti, jti)).limit(1);
  const r = rows[0];
  if (!r) return;
  await db.insert(tokenRevocations).values({
    jti,
    expires_at: r.expires_at,
    revoked_at: Math.floor(Date.now() / 1000),
  }).onConflictDoNothing();
}

/**
 * Bumps `password_reset_at` to now on every admin row. `verifyAuthToken`
 * already rejects tokens whose `iat` is older than `password_reset_at`, so
 * this kills every existing admin JWT in one shot — no per-jti DB write.
 */
export async function forceLogoutAllAdmins(): Promise<{ count: number }> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const rows = await db.update(adminTable).set({ password_reset_at: now }).returning({ id: adminTable.id });
  return { count: rows.length };
}

/** GC sessions whose `expires_at` is in the past. Called from a periodic tick. */
export async function pruneExpiredAdminSessions(): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  await db.delete(adminSessions).where(lt(adminSessions.expires_at, now));
}

// ── Brute-force lockout ─────────────────────────────────────────────────────

export interface LockoutPolicy {
  enabled: boolean;
  /** Failed attempts before the principal is locked out. 0 = off. */
  max_attempts: number;
  /** Seconds the lockout window holds. Default 900s (15 min). */
  duration_seconds: number;
}

/** Default failed sign-ins per account (and per IP) before a lockout. */
export const DEFAULT_LOCKOUT_MAX_ATTEMPTS = 10;

export function getLockoutPolicy(): LockoutPolicy {
  const raw = Number.parseInt(getSetting("auth.lockout.max_attempts", String(DEFAULT_LOCKOUT_MAX_ATTEMPTS)), 10);
  const max = Number.isFinite(raw) && raw > 0 ? raw : 0;
  const dur = Math.max(60, Number.parseInt(getSetting("auth.lockout.duration_seconds", "900"), 10) || 900);
  return { enabled: max > 0, max_attempts: max, duration_seconds: dur };
}

/**
 * An IP may fail this many times the per-account limit before it is locked.
 * One address often fronts many people (an office, a carrier NAT), so the IP
 * key is a backstop against spraying many accounts, not a per-person limit.
 */
const IP_LOCKOUT_MULTIPLIER = 5;

/**
 * Lockout keys for a sign-in. `scope` separates principals that share an
 * address: admins use `email:<addr>`, auth-collection users
 * `user:<collection-id>:<addr>`, so failing against one never locks the other.
 * The IP key is scoped the same way, so users behind a shared address can't
 * lock the admin sign-in out.
 */
function lockoutKeys(opts: { scope?: string; email: string; ip: string | null }): { account: string; ip: string | null } {
  const scope = opts.scope ?? "email";
  return {
    account: `${scope}:${opts.email.trim().toLowerCase()}`,
    ip: opts.ip ? `ip:${scope === "email" ? "" : `${scope}:`}${opts.ip}` : null,
  };
}

/** A charged sign-in attempt, from `reserveLoginAttempt`. */
export interface LoginAttempt {
  account: string;
  ipReservation: string | null;
}

/**
 * Charge one sign-in attempt against the account (and IP) before the password
 * is checked. Returns null while either key is locked out. The charge stays
 * as the recorded failure unless the sign-in succeeds and the caller passes
 * the attempt to `loginSucceeded`. Charging first means parallel attempts
 * can't all read the same count, the way a check-then-record lockout lets
 * them. With the lockout off, an inert attempt is returned.
 */
export async function reserveLoginAttempt(opts: { scope?: string; email: string; ip: string | null }): Promise<LoginAttempt | null> {
  const keys = lockoutKeys(opts);
  const policy = getLockoutPolicy();
  if (!policy.enabled) return { account: keys.account, ipReservation: null };
  const held = await reserveAttempt(keys.account, policy.max_attempts, policy.duration_seconds);
  if (!held) return null;
  let ipReservation: string | null = null;
  if (keys.ip) {
    ipReservation = await reserveAttempt(keys.ip, policy.max_attempts * IP_LOCKOUT_MULTIPLIER, policy.duration_seconds);
    if (!ipReservation) {
      await releaseAttempt(held);
      return null;
    }
  }
  return { account: keys.account, ipReservation };
}

/**
 * The attempt succeeded: forget the account's failures and withdraw this
 * attempt's charge on the IP. Earlier IP failures are kept — otherwise an
 * attacker spraying many accounts from one address could reset the IP budget
 * by signing in to an account of their own now and then.
 */
export async function loginSucceeded(attempt: LoginAttempt): Promise<void> {
  await clearAttemptFailures(attempt.account);
  if (attempt.ipReservation) await releaseAttempt(attempt.ipReservation);
}

// ── Per-account attempt budgets ─────────────────────────────────────────────
//
// Second factors and one-time codes are short (6 digits), so they need a hard
// failure budget per account that holds no matter how many fresh codes or
// tickets the caller mints. Unlike the login lockout above, these always apply.

/** Record one failed attempt against `key` (e.g. `otp:<collection>:<user>`). */
export async function recordAttemptFailure(key: string): Promise<void> {
  await getDb().insert(loginFailures)
    .values({ id: crypto.randomUUID(), key, at: Math.floor(Date.now() / 1000) })
    .catch(() => { /* swallow */ });
}

/** Failed attempts recorded against `key` within the last `windowSeconds`. */
export async function recentAttemptFailures(key: string, windowSeconds: number): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - windowSeconds;
  const rows = await getDb().select({ id: loginFailures.id }).from(loginFailures)
    .where(and(eq(loginFailures.key, key), gte(loginFailures.at, cutoff)));
  return rows.length;
}

/**
 * Charge one attempt against `key` *before* the secret is checked. Returns the
 * reservation id, or null when the budget is spent (the charge is withdrawn).
 *
 * Checking the count first and recording the failure afterwards let parallel
 * guesses all read the same count and all get through. Recording first means
 * each request counts every reservation made before it, so at most `max`
 * attempts are ever in flight or failed inside the window. On success the
 * caller hands the id to `releaseAttempt`; on failure the row stays as the
 * recorded failure.
 */
export async function reserveAttempt(key: string, max: number, windowSeconds: number): Promise<string | null> {
  const id = crypto.randomUUID();
  await getDb().insert(loginFailures).values({ id, key, at: Math.floor(Date.now() / 1000) });
  if (await recentAttemptFailures(key, windowSeconds) > max) {
    await releaseAttempt(id);
    return null;
  }
  return id;
}

/** Withdraw a reservation from `reserveAttempt` (the attempt succeeded). */
export async function releaseAttempt(id: string): Promise<void> {
  await getDb().delete(loginFailures).where(eq(loginFailures.id, id));
}

export async function clearAttemptFailures(key: string): Promise<void> {
  await getDb().delete(loginFailures).where(eq(loginFailures.key, key));
}

/** GC failures older than the longest lockout window. */
export async function pruneOldLoginFailures(): Promise<void> {
  const policy = getLockoutPolicy();
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - Math.max(86400, policy.duration_seconds * 2);
  await db.delete(loginFailures).where(lt(loginFailures.at, cutoff));
}

// ── IP extraction (mirrors ratelimit / audit-log defensive defaults) ────────

function clientIpFromRequest(request: Request): string | null {
  const trustedRaw = getTrustedProxiesRaw();
  if (!trustedRaw) return null;
  const xff = request.headers.get("x-forwarded-for");
  if (!xff) return null;
  return (xff.split(",")[0] ?? "").trim() || null;
}

// ── Fingerprints ────────────────────────────────────────────────────────────

export async function shortFingerprint(input: string): Promise<string> {
  if (!input) return "—";
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16); // 8 bytes / 16 hex chars — collision-resistant for fingerprinting purposes
}
