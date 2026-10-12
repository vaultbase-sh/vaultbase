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

export function getLockoutPolicy(): LockoutPolicy {
  const max = Number.parseInt(getSetting("auth.lockout.max_attempts", "0"), 10) || 0;
  const dur = Math.max(60, Number.parseInt(getSetting("auth.lockout.duration_seconds", "900"), 10) || 900);
  return { enabled: max > 0, max_attempts: max, duration_seconds: dur };
}

/** Insert one failure row keyed by `email:<addr>` and `ip:<ip>` (when known). */
export async function recordLoginFailure(opts: { email: string; ip: string | null }): Promise<void> {
  const policy = getLockoutPolicy();
  if (!policy.enabled) return;
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const rows: Array<{ id: string; key: string; at: number }> = [];
  if (opts.email) rows.push({ id: crypto.randomUUID(), key: `email:${opts.email.toLowerCase()}`, at: now });
  if (opts.ip)    rows.push({ id: crypto.randomUUID(), key: `ip:${opts.ip}`, at: now });
  if (rows.length === 0) return;
  await db.insert(loginFailures).values(rows).catch(() => { /* swallow */ });
}

export async function clearLoginFailures(opts: { email?: string; ip?: string | null }): Promise<void> {
  const db = getDb();
  if (opts.email) await db.delete(loginFailures).where(eq(loginFailures.key, `email:${opts.email.toLowerCase()}`));
  if (opts.ip)    await db.delete(loginFailures).where(eq(loginFailures.key, `ip:${opts.ip}`));
}

/** True when the principal is in lockout window. */
export async function isLockedOut(opts: { email: string; ip: string | null }): Promise<boolean> {
  const policy = getLockoutPolicy();
  if (!policy.enabled) return false;
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - policy.duration_seconds;
  for (const k of [`email:${opts.email.toLowerCase()}`, opts.ip ? `ip:${opts.ip}` : null]) {
    if (!k) continue;
    const rows = await db.select().from(loginFailures).where(and(eq(loginFailures.key, k), gte(loginFailures.at, cutoff)));
    if (rows.length >= policy.max_attempts) return true;
  }
  return false;
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
