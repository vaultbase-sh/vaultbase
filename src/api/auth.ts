import { and, desc, eq, gte, isNull, lt, ne, sql } from "drizzle-orm";
import { clearSetupKey, requiredSetupKey } from "../core/setup-key.ts";
import Elysia, { t } from "elysia";
import * as jose from "jose";
import { getDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { admin, authTokens, mfaRecoveryCodes, mfaRecoveryLookup, oauthLinks, tokenRevocations } from "../db/schema.ts";
import { getCollection, parseFields, userTableName } from "../core/collections.ts";
import { AUTH_USER_COLUMNS, findUserByEmail, findUserById, insertUser, updateUserById } from "../core/users-table.ts";
import { runBeforeHook, makeHookHelpers } from "../core/hooks.ts";
import { emit } from "../core/events.ts";
import "../core/event-listeners.ts";
import type { Collection } from "../db/schema.ts";
import { canSeeAs, getRecord } from "../core/records.ts";
import { validateRecord, ValidationError } from "../core/validate.ts";
import { sessionMaxSeconds, tokenWindowSeconds } from "../core/auth-tokens.ts";
import {
  dummyPasswordHash,
  HASH_OPTS,
  hmacRecoveryCode,
  ISSUER,
  clientIp,
  redactEmail,
  requestIsHttps,
  revokeToken,
  signAuthToken,
  verifyAuthToken,
  accessFor,
  dataPrincipal,
} from "../core/sec.ts";
import { buildRequestContext, checkRule } from "./_rules.ts";
import { getAllSettings } from "./settings.ts";
import {
  getAppUrl,
  getTemplate,
  isSmtpConfigured,
  renderTemplate,
  sendEmail,
} from "../core/email.ts";
import {
  buildAuthorizeUrl,
  codeChallengeFromVerifier,
  exchangeCodeForToken,
  fetchProviderProfileFromExchange,
  generateCodeVerifier,
  idTokenNonce,
  isProviderEnabled,
  listEnabledProviders,
  providerRequiresPkce,
  providerUsesNonce,
  PROVIDERS,
} from "../core/oauth2.ts";
import {
  buildOtpauthUrl,
  generateSecret,
  matchingStep as matchingTotpStep,
} from "../core/totp.ts";
import { isAuthFeatureEnabled } from "../core/auth-features.ts";
import { validatePassword } from "../core/password-policy.ts";
import {
  recordAdminSession,
  reserveLoginAttempt,
  loginSucceeded,
  reserveAttempt,
  releaseAttempt,
} from "../core/security.ts";
import { adminGuard } from "./_admin.ts";

/**
 * Whether auth cookies get `Secure`: the request came over HTTPS (directly
 * or via a trusted proxy's X-Forwarded-Proto), or the app is configured on
 * an https URL. Taken from request.url alone, it was never set behind a
 * TLS-terminating proxy.
 */
function cookieSecure(request: Request): boolean {
  return requestIsHttps(request) || getAppUrl().startsWith("https://");
}

/** Client IP for lockout keying, by the trusted-proxy rule (see sec.ts clientIp). */
function clientIpForLockout(request: Request): string | null {
  return clientIp(request);
}

/**
 * The signed-in user of `collection` behind the bearer token, through the
 * central verifier (revocation, principal recheck). A token from another
 * auth collection doesn't count.
 */
async function userSession(request: Request, jwtSecret: string, collection: string) {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const ctx = await verifyAuthToken(token, jwtSecret, { audience: "user" });
  return ctx && ctx.collection === collection ? ctx : null;
}

function getSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

const TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_TTL_SECONDS = 10 * 60;   // 10 minutes
const MFA_TICKET_TTL_SECONDS = 5 * 60; // 5 minutes — enough to type a code
const PKCE_TTL_SECONDS = 10 * 60; // 10 minutes — enough to complete the IdP redirect

async function hashPassword(plaintext: string): Promise<string> {
  return await Bun.password.hash(plaintext, HASH_OPTS);
}

const MAX_OTP_ATTEMPTS = 5;
/**
 * Failed OTP / MFA codes allowed per account inside `ATTEMPT_WINDOW_SECONDS`,
 * across every code or ticket issued in that time. A fresh code or ticket
 * resets the per-token count but never this one.
 */
const MAX_ACCOUNT_CODE_FAILURES = 10;
const ATTEMPT_WINDOW_SECONDS = 15 * 60;

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Spend one attempt on a one-time token *before* the code is compared.
 * Returns false when the token is used or its `MAX_OTP_ATTEMPTS` are gone.
 * The check and the increment are one UPDATE, so parallel guesses can't all
 * read the same count: at most `MAX_OTP_ATTEMPTS` comparisons ever run.
 */
async function spendTokenAttempt(id: string): Promise<boolean> {
  const rows = await getDb().update(authTokens)
    .set({ attempts: sql`${authTokens.attempts} + 1` })
    .where(and(eq(authTokens.id, id), isNull(authTokens.used_at), lt(authTokens.attempts, MAX_OTP_ATTEMPTS)))
    .returning({ id: authTokens.id });
  return rows.length > 0;
}

/**
 * Check a TOTP code and spend it: each time step can be used once per user,
 * so a code seen over someone's shoulder (or replayed from a log) is dead as
 * soon as its owner has used it. The spent step is a row keyed by
 * collection, user and step, so two racing requests can't both claim it.
 */
async function verifyTotpOnce(collectionId: string, userId: string, secret: string, code: string): Promise<"ok" | "invalid" | "replayed"> {
  const step = matchingTotpStep(secret, code);
  if (step === null) return "invalid";
  const now = Math.floor(Date.now() / 1000);
  // Steps are per secret: re-enrolling inside the same 30 s window must not
  // look like a replay of the old secret's code.
  const secretTag = new Bun.CryptoHasher("sha256").update(secret).digest("hex").slice(0, 16);
  const rows = await getDb().insert(authTokens).values({
    id: `totp_step:${collectionId}:${userId}:${secretTag}:${step}`,
    user_id: userId,
    collection_id: collectionId,
    purpose: "totp_step",
    used_at: now,
    // Past the ±1 step drift window the code can't match anyway.
    expires_at: now + 120,
  }).onConflictDoNothing().returning({ id: authTokens.id });
  return rows.length > 0 ? "ok" : "replayed";
}

/**
 * Mark a one-time token used. Returns false when another request got there
 * first, so a token can't be spent twice by racing it.
 */
async function consumeToken(id: string, now: number): Promise<boolean> {
  const rows = await getDb().update(authTokens)
    .set({ used_at: now })
    .where(and(eq(authTokens.id, id), isNull(authTokens.used_at)))
    .returning({ id: authTokens.id });
  return rows.length > 0;
}

function isRedirectUriAllowed(provider: string, uri: string): boolean {
  let target: URL;
  try { target = new URL(uri); } catch { return false; }
  const settings = getAllSettings();
  const raw = settings[`oauth2.${provider}.allowed_redirect_uris`] ?? settings["oauth2.allowed_redirect_uris"] ?? "";
  if (!raw) {
    // Not configured: only this app's own origin (app.url). Allowing any URI
    // here left the decision to whatever the provider has registered, which
    // is often broader than intended (wildcards, localhost, staging).
    const app = getAppUrl();
    try { return !!app && new URL(app).origin === target.origin; } catch { return false; }
  }
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (list.includes("*")) return true;
  return list.some((p) => {
    if (p === uri) return true;
    if (!p.endsWith("*")) return false;
    // A trailing `*` extends the path only. Compared as raw prefixes,
    // `https://app.com*` also matched `https://app.com.evil.tld/…`.
    try {
      const prefix = new URL(p.slice(0, -1));
      if (prefix.protocol === "http:" || prefix.protocol === "https:") {
        return prefix.origin === target.origin && target.pathname.startsWith(prefix.pathname);
      }
      // App schemes (`com.myapp://oauth*`) have no origin to compare — every
      // non-web URL's is "null" — so match the same scheme and a raw prefix.
      return target.protocol === prefix.protocol && uri.startsWith(p.slice(0, -1));
    } catch {
      return false;
    }
  });
}

function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * One-time tokens (email links, MFA tickets, merge tokens, PKCE state) are
 * stored as a SHA-256 hash, never as the token itself, so a copy of the
 * database — a backup, a read-only SQL session — can't be turned into a
 * password reset or a sign-in. The raw token only exists in the email or
 * response that carries it.
 */
function storedTokenId(raw: string): string {
  return "h:" + new Bun.CryptoHasher("sha256").update(raw).digest("hex");
}

/** Look up a one-time token by the raw value a caller presents. */
async function findOneTimeToken(raw: string) {
  return await getDb().select().from(authTokens).where(eq(authTokens.id, storedTokenId(raw))).limit(1);
}

/**
 * What is stored for an OTP's 6-digit code: an HMAC keyed with the server
 * secret, which lives outside the database. A plain hash of a 6-digit code
 * falls to a million guesses offline, and the code plus the user's email
 * (also in the database) is a sign-in.
 */
async function otpCodeDigest(code: string, jwtSecret: string): Promise<string> {
  return "hmac:" + (await hmacRecoveryCode(`otp:${code}`, jwtSecret));
}

/**
 * Generate a single 8-character alphanumeric recovery code formatted as
 * `XXXX-XXXX`. Uses an unambiguous alphabet (no 0/O, 1/I) to make codes
 * easier to read off paper.
 */
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newRecoveryCode(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += RECOVERY_ALPHABET[buf[i]! % RECOVERY_ALPHABET.length];
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}`;
}

async function generateRecoveryCodesFor(
  userId: string,
  collectionId: string,
  jwtSecret: string
): Promise<string[]> {
  const db = getDb();
  // Wipe any existing codes — regenerate is "replace all".
  const old = await db
    .select()
    .from(mfaRecoveryCodes)
    .where(and(eq(mfaRecoveryCodes.user_id, userId), eq(mfaRecoveryCodes.collection_id, collectionId)));
  for (const row of old) {
    try { await db.delete(mfaRecoveryLookup).where(eq(mfaRecoveryLookup.recovery_id, row.id)); } catch { /* noop */ }
  }
  await db
    .delete(mfaRecoveryCodes)
    .where(and(eq(mfaRecoveryCodes.user_id, userId), eq(mfaRecoveryCodes.collection_id, collectionId)));
  const plain: string[] = [];
  for (let i = 0; i < 10; i++) plain.push(newRecoveryCode());
  const now = Math.floor(Date.now() / 1000);
  for (const code of plain) {
    const id = crypto.randomUUID();
    const hash = await hashPassword(code);
    const hmac = await hmacRecoveryCode(code, jwtSecret);
    await db.insert(mfaRecoveryCodes).values({
      id,
      user_id: userId,
      collection_id: collectionId,
      code_hash: hash,
      created_at: now,
    });
    await db.insert(mfaRecoveryLookup).values({ hmac, recovery_id: id });
  }
  return plain;
}

/**
 * Run `validateRecord` against a collection's user-defined fields *and*
 * any implicit fields (auth's email/verified). The default `validateRecord`
 * skips implicit entries on the assumption their storage lives elsewhere;
 * for register we still want admin-set custom options (min length, pattern)
 * to apply to the incoming email/verified payload.
 */
/**
 * Whether the auth collection's create rule lets this caller open an account
 * (register, anonymous sign-in, OAuth2 sign-up, anonymous → real promotion).
 * Same semantics as a records-API create: `null` public, `""` admin only,
 * otherwise the rule against the sign-up fields as `@request.body`. These
 * paths used to skip the rule, so "Admin only" sign-up was open to anyone
 * and a rule like `@request.body.role:isset = false` never ran. The password
 * is not exposed to the rule.
 */
async function signupAllowed(
  request: Request,
  jwtSecret: string,
  col: { name: string; create_rule: string | null },
  fields: Record<string, unknown>,
): Promise<boolean> {
  if (col.create_rule === null) return true;
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  const auth = token ? dataPrincipal(await verifyAuthToken(token, jwtSecret), accessFor(request)) : null;
  const { password: _pw, ...ruleBody } = fields;
  return checkRule(
    request, "create_rule", col.name, col.create_rule, auth,
    ruleBody, buildRequestContext(request, ruleBody, null),
  );
}

async function validateAuthRegister(
  col: { id: string; name: string; type: string; fields: string; created_at: number; updated_at: number; view_query: string | null; list_rule: string | null; view_rule: string | null; create_rule: string | null; update_rule: string | null; delete_rule: string | null; },
  data: Record<string, unknown>
): Promise<void> {
  // Email uniqueness is left to the caller's own lookup: as a validation error
  // it would answer "email must be unique" and tell anyone which addresses
  // have accounts.
  const fields = parseFields(col.fields).map((f) => ({
    ...f,
    implicit: false,
    ...(f.implicit && f.name === "email" ? { options: { ...f.options, unique: false } } : {}),
  }));
  // Build a synthetic collection with implicit flags stripped so the validator
  // checks options on email/verified just like any other field.
  const synthetic = { ...col, fields: JSON.stringify(fields) };
  // Relations set at sign-up point at records an anonymous caller can see,
  // the same check the records API applies to non-admin writes.
  await validateRecord(synthetic as unknown as Parameters<typeof validateRecord>[0], data, "create", undefined, canSeeAs(null));
  // validateRecord's "email" branch only checks regex, not min/max length —
  // enforce admin-set length constraints here so register matches the rest of
  // the API surface (text-typed fields already get min/max from validateRecord).
  const lenErrors: Record<string, string> = {};
  for (const f of fields) {
    if (f.type !== "email") continue;
    const v = data[f.name];
    if (typeof v !== "string" || v === "") continue;
    if (f.options?.min !== undefined && v.length < f.options.min) {
      lenErrors[f.name] = `${f.name} must be at least ${f.options.min} characters`;
    } else if (f.options?.max !== undefined && v.length > f.options.max) {
      lenErrors[f.name] = `${f.name} must be at most ${f.options.max} characters`;
    }
  }
  if (Object.keys(lenErrors).length > 0) throw new ValidationError(lenErrors);
}

/** 6-digit numeric OTP, zero-padded. Avoids leading-zero ambiguity. */
function newOtpCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0]! % 1_000_000).toString().padStart(6, "0");
}

const LINK_PATHS = {
  verify: "/auth/verify",
  reset: "/auth/reset",
  otp: "/auth/otp",
  email_change: "/auth/confirm-email-change",
  invite: "/auth/invite",
} as const;

function buildLink(appUrl: string, kind: keyof typeof LINK_PATHS, collection: string, token: string): string {
  const base = appUrl.replace(/\/+$/, "");
  const path = LINK_PATHS[kind];
  return `${base}${path}?token=${token}&collection=${encodeURIComponent(collection)}`;
}

/** One email per kind per user per minute. */
const EMAIL_COOLDOWN_SECONDS = 60;

/**
 * Whether the just-inserted token `id` may be emailed, or falls inside the
 * per-user cooldown. Anyone can type a victim's address into the reset or OTP
 * form, so without this their inbox is only as safe as the per-IP rate limit.
 *
 * The token row is inserted first and then ranked by rowid among the user's
 * tokens of the same purpose from the last minute: it may send only if none
 * was issued before it. Ranking by insertion order means a burst of parallel
 * requests sends exactly one email instead of racing a check-then-insert.
 *
 * There is deliberately no hourly cap on top: anyone can make these requests,
 * so a cap would let a stranger use up the owner's quota and lock them out of
 * OTP sign-in and password reset. The cooldown bounds a flood to one email a
 * minute while the owner is never kept waiting longer than that.
 */
function emailAllowed(id: string, userId: string, collectionId: string, purpose: string): boolean {
  const since = Math.floor(Date.now() / 1000) - EMAIL_COOLDOWN_SECONDS;
  const row = db.sync.get(
    `SELECT COUNT(*) AS n FROM vaultbase_auth_tokens
      WHERE user_id = ? AND collection_id = ? AND purpose = ? AND created_at >= ?
        AND rowid < (SELECT rowid FROM vaultbase_auth_tokens WHERE id = ?)`,
    [userId, collectionId, purpose, since, id],
  ) as { n: number };
  return row.n === 0;
}

/** Returns false when the email was held back by the per-user cooldown. */
async function issueAndSend(
  kind: "verify" | "reset",
  user: { id: string; email: string },
  collectionId: string,
  collectionName: string
): Promise<boolean> {
  const token = newToken();
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const purpose = kind === "verify" ? "email_verify" : "password_reset";
  const stored = storedTokenId(token);
  await getDb().insert(authTokens).values({
    id: stored,
    user_id: user.id,
    collection_id: collectionId,
    purpose,
    expires_at: expiresAt,
  });
  if (!emailAllowed(stored, user.id, collectionId, purpose)) {
    await getDb().delete(authTokens).where(eq(authTokens.id, stored));
    return false;
  }
  const tpl = getTemplate(kind);
  const appUrl = getAppUrl();
  const vars = {
    email: user.email,
    token,
    link: buildLink(appUrl, kind, collectionName, token),
    appUrl,
    collection: collectionName,
  };
  await sendEmail({
    to: user.email,
    subject: renderTemplate(tpl.subject, vars),
    text: renderTemplate(tpl.body, vars),
  });
  return true;
}

/** Send a link email for a token already stored in vaultbase_auth_tokens. */
async function sendTemplated(
  kind: "email_change" | "invite",
  to: string,
  token: string,
  collectionName: string,
): Promise<void> {
  const tpl = getTemplate(kind);
  const appUrl = getAppUrl();
  const vars = { email: to, token, link: buildLink(appUrl, kind, collectionName, token), appUrl, collection: collectionName };
  await sendEmail({ to, subject: renderTemplate(tpl.subject, vars), text: renderTemplate(tpl.body, vars) });
}

/**
 * Issue a single OTP record carrying both a long token (for the magic link)
 * and a 6-digit code (for typing). Either is sufficient to authenticate.
 */
async function issueOtpAndSend(
  user: { id: string; email: string },
  collectionId: string,
  collectionName: string,
  jwtSecret: string,
): Promise<boolean> {
  const token = newToken();
  const code = newOtpCode();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + OTP_TTL_SECONDS;
  const stored = storedTokenId(token);
  await getDb().insert(authTokens).values({
    id: stored,
    user_id: user.id,
    collection_id: collectionId,
    purpose: "otp",
    code: await otpCodeDigest(code, jwtSecret),
    expires_at: expiresAt,
  });
  // Held back by the cooldown: drop the row before it voids the live code,
  // so a flood of requests can't keep killing the code the user was sent.
  if (!emailAllowed(stored, user.id, collectionId, "otp")) {
    await getDb().delete(authTokens).where(eq(authTokens.id, stored));
    return false;
  }
  // One live code per user: the new one voids the rest, so each code only
  // ever has its own attempt budget to spend. Voiding after the insert means
  // two racing requests can't both leave a code live.
  await getDb().update(authTokens).set({ used_at: now }).where(and(
    eq(authTokens.user_id, user.id),
    eq(authTokens.collection_id, collectionId),
    eq(authTokens.purpose, "otp"),
    isNull(authTokens.used_at),
    ne(authTokens.id, stored),
  ));
  const tpl = getTemplate("otp");
  const appUrl = getAppUrl();
  const vars = {
    email: user.email,
    token,
    code,
    link: buildLink(appUrl, "otp", collectionName, token),
    appUrl,
    collection: collectionName,
  };
  await sendEmail({
    to: user.email,
    subject: renderTemplate(tpl.subject, vars),
    text: renderTemplate(tpl.body, vars),
  });
  return true;
}

/** How long refreshing an already-refreshed token returns the same replacement. */
const REFRESH_REPEAT_SECONDS = 30;

/**
 * `/auth/refresh` for a token whose refresh already happened in the last
 * `REFRESH_REPEAT_SECONDS`: re-mint the identical replacement (same jti, iat
 * and claims, so the same bytes) and hand it back, as long as that
 * replacement itself still verifies — a logout, revocation or password reset
 * since then still wins. Two tabs refreshing one token at once both end up
 * holding the same session, rather than the loser's 401 signing everyone out.
 * Whoever holds the old token in that window could already have refreshed it
 * first, so this grants nothing new.
 */
async function repeatRefresh(token: string, jwtSecret: string): Promise<string | null> {
  try {
    const { payload } = await jose.jwtVerify(token, new TextEncoder().encode(jwtSecret), { issuer: ISSUER });
    if (typeof payload.jti !== "string") return null;
    const row = (await getDb().select().from(authTokens)
      .where(eq(authTokens.id, `refresh_rotation:${payload.jti}`)).limit(1))[0];
    if (!row || row.purpose !== "refresh_rotation" || row.expires_at < Math.floor(Date.now() / 1000) || !row.payload) return null;
    const r = JSON.parse(row.payload) as { claims: jose.JWTPayload; audience: "user" | "admin"; ttl: number; jti: string; iat: number };
    const { token: again } = await signAuthToken({
      payload: r.claims, audience: r.audience, expiresInSeconds: r.ttl, jwtSecret,
      reissue: { jti: r.jti, iat: r.iat },
    });
    return (await verifyAuthToken(again, jwtSecret)) ? again : null;
  } catch {
    return null;
  }
}

/** Revoke the token that replaced `token` in the last refresh window, if any. */
async function endRefreshedReplacement(token: string, jwtSecret: string): Promise<void> {
  try {
    const { payload } = await jose.jwtVerify(token, new TextEncoder().encode(jwtSecret), { issuer: ISSUER });
    if (typeof payload.jti !== "string") return;
    const id = `refresh_rotation:${payload.jti}`;
    const row = (await getDb().select().from(authTokens).where(eq(authTokens.id, id)).limit(1))[0];
    if (!row?.payload) return;
    const r = JSON.parse(row.payload) as { jti: string; iat: number; ttl: number };
    await revokeToken(r.jti, r.iat + r.ttl);
    await getDb().delete(authTokens).where(eq(authTokens.id, id));
  } catch { /* not ours or malformed: nothing to end */ }
}

/**
 * The account whose email matches `email` ignoring case. Plain lookups are
 * exact, so `ALICE@x` from a provider missed the `alice@x` account and made a
 * second account for the same mailbox.
 */
function findUserByEmailAnyCase(col: Parameters<typeof findUserById>[0], email: string) {
  const exact = findUserByEmail(col, email);
  if (exact) return exact;
  const row = db.sync.get<{ id: string }>(
    `SELECT id FROM "${userTableName(col.name)}" WHERE email = ? COLLATE NOCASE LIMIT 1`,
    [email],
  );
  return row ? findUserById(col, row.id) : null;
}

/** Issue an MFA ticket for step 2 of a sign-in (`/login/mfa`). */
async function mfaTicketFor(collectionId: string, userId: string, pending?: { link: PendingLink }): Promise<{ mfa_required: true; mfa_token: string }> {
  const ticket = newToken();
  await getDb().insert(authTokens).values({
    id: storedTokenId(ticket),
    user_id: userId,
    collection_id: collectionId,
    purpose: "mfa_ticket",
    // Work to finish once the second factor is in (a provider link waiting
    // on merge-confirm), so nothing changes on the password alone.
    ...(pending ? { payload: JSON.stringify(pending) } : {}),
    expires_at: Math.floor(Date.now() / 1000) + MFA_TICKET_TTL_SECONDS,
  });
  return { mfa_required: true, mfa_token: ticket };
}

interface PendingLink { provider: string; provider_user_id: string; email: string }

/** Link a provider identity to `userId` (idempotent) and mark the email verified. */
async function applyProviderLink(colId: string, col: Parameters<typeof findUserById>[0], userId: string, link: PendingLink): Promise<void> {
  const db = getDb();
  const existing = await db.select().from(oauthLinks).where(and(
    eq(oauthLinks.user_id, userId), eq(oauthLinks.provider, link.provider), eq(oauthLinks.provider_user_id, link.provider_user_id),
  )).limit(1);
  if (existing.length === 0) {
    await db.insert(oauthLinks).values({
      id: crypto.randomUUID(), user_id: userId, collection_id: colId,
      provider: link.provider, provider_user_id: link.provider_user_id, provider_email: link.email,
    });
  }
  const u = findUserById(col, userId);
  if (u && !u.email_verified) await updateUserById(col, userId, { email_verified: 1, updated_at: Math.floor(Date.now() / 1000) });
}


/**
 * A user was created by an auth flow: emit it as a record (afterCreate hooks
 * run; realtime and webhooks skip auth-created users) and as a sign-up.
 */
function emitSignup(col: Collection, created: object, method: "password" | "invite" | "anonymous" | "oauth2"): void {
  const record = created as Record<string, unknown>;
  emit("record.created", { collection: col, record, auth: null, source: "auth" });
  emit("auth.signup", { collection: col, record, method });
}

export function makeAuthPlugin(jwtSecret: string) {
  return new Elysia({ name: "auth" })
    .use(adminGuard(jwtSecret))
    .get("/admin/setup/status", async () => {
      const db = getDb();
      const existing = await db.select().from(admin).limit(1);
      // Setup always needs a key now; the flag tells the setup page to ask.
      return { data: { has_admin: existing.length > 0, key_required: existing.length === 0 } };
    })
    .post(
      "/admin/setup",
      async ({ body, request, set }) => {
        {
          const pwErr = await validatePassword(typeof body.password === "string" ? body.password : "");
          if (pwErr) { set.status = 422; return { error: pwErr, code: 422 }; }
        }
        const db = getDb();
        if ((await db.select({ id: admin.id }).from(admin).limit(1)).length > 0) {
          set.status = 400;
          return { error: "Admin already set up", code: 400 };
        }
        // Setup-key gate: `VAULTBASE_SETUP_KEY`, or a key the server
        // generated and printed to its log. Without it, whoever reached a
        // fresh install first became its admin. Sent as `X-Setup-Key`, or
        // as `setup_key` in the body (the browser setup page).
        const expected = requiredSetupKey();
        const provided = request.headers.get("x-setup-key") ?? body.setup_key ?? "";
        if (!provided || !timingSafeEqualStr(provided, expected)) {
          set.status = 401;
          return { error: "Setup key required", code: 401 };
        }
        const id = crypto.randomUUID();
        const hash = await hashPassword(body.password);
        const now = Math.floor(Date.now() / 1000);
        try {
          // Atomic: UNIQUE on email + count check via INSERT-then-validate.
          await db.insert(admin).values({
            id,
            email: body.email,
            password_hash: hash,
            password_reset_at: now,
            created_at: now,
          });
        } catch {
          set.status = 400;
          return { error: "Admin already set up", code: 400 };
        }
        // Confirm we're still the only admin — if a concurrent setup landed,
        // delete our row to keep the install clean and refuse.
        const all = await db.select().from(admin);
        if (all.length > 1) {
          await db.delete(admin).where(eq(admin.id, id));
          set.status = 400;
          return { error: "Admin already set up", code: 400 };
        }
        clearSetupKey();
        return { data: { id, email: body.email } };
      },
      { body: t.Object({ email: t.String(), password: t.String(), setup_key: t.Optional(t.String({ maxLength: 512 })) }) }
    )
    .post(
      "/admin/auth/login",
      async ({ body, request }) => {
        const ip = clientIpForLockout(request);
        // Lockout gate runs *before* password verify so a successful attempt
        // by a different account from the same IP doesn't leak signal.
        const db = getDb();
        const rows = await db.select().from(admin).where(eq(admin.email, body.email)).limit(1);
        const a = rows[0];
        const attempt = await reserveLoginAttempt({ email: body.email, subject: a?.id, ip });
        if (!attempt) {
          return new Response(JSON.stringify({ error: "Too many failed attempts. Try again later.", code: 429 }), {
            status: 429,
            headers: { "content-type": "application/json" },
          });
        }
        const hashToCheck = a?.password_hash ?? dummyPasswordHash();
        const valid = await Bun.password.verify(body.password, hashToCheck).catch(() => false);
        if (!a || !valid) {
          return new Response(JSON.stringify({ error: "Invalid credentials", code: 401 }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        await loginSucceeded(attempt);
        const ttl = tokenWindowSeconds("admin");
        const { token, jti, exp, iat } = await signAuthToken({
          payload: { id: a.id, email: a.email },
          audience: "admin",
          expiresInSeconds: ttl,
          jwtSecret,
        });
        await recordAdminSession({
          jti, admin_id: a.id, admin_email: a.email,
          issued_at: iat, expires_at: exp, request,
        });
        const isHttps = cookieSecure(request);
        const secureFlag = isHttps ? " Secure;" : "";
        const cookie = `vaultbase_admin_token=${token}; Path=/; HttpOnly;${secureFlag} SameSite=Lax; Max-Age=${ttl}`;
        return new Response(JSON.stringify({ data: { token, admin: { id: a.id, email: a.email } } }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": cookie,
          },
        });
      },
      { body: t.Object({ email: t.String(), password: t.String() }) }
    )
    .get("/admin/auth/me", ({ admin }) => ({
      data: { id: admin.id, email: admin.email, aud: "admin", exp: admin.exp },
    }), { requireAdmin: true })
    // Admin recovery: clear a user's TOTP secret + recovery codes. Records
    // flow `PATCH` strips auth-system columns, so this dedicated endpoint
    // exists for the "user lost their authenticator" admin operation.
    .post("/admin/users/:collection/:id/disable-mfa", async ({ params, set }) => {
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
      const u = findUserById(col, params.id);
      if (!u) { set.status = 404; return { error: "User not found", code: 404 }; }
      const now = Math.floor(Date.now() / 1000);
      await updateUserById(col, params.id, { totp_enabled: 0, totp_secret: null, updated_at: now });
      // Wipe recovery codes — useless without TOTP.
      await getDb()
        .delete(mfaRecoveryCodes)
        .where(and(eq(mfaRecoveryCodes.user_id, params.id), eq(mfaRecoveryCodes.collection_id, col.id)));
      return { data: { disabled: true } };
    }, { requireAdmin: true })
    .post(
      "/auth/:collection/register",
      async ({ params, body, request, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        if (!(await signupAllowed(request, jwtSecret, col, body as Record<string, unknown>))) {
          set.status = 403; return { error: "Forbidden", code: 403 };
        }
        {
          const pwErr = await validatePassword(typeof body.password === "string" ? body.password : "");
          if (pwErr) { set.status = 422; return { error: pwErr, code: 422 }; }
        }
        // Validate first, so a payload that fails validation gets the same 422
        // whether or not the address is taken.
        try {
          await validateAuthRegister(col, body as Record<string, unknown>);
        } catch (e) {
          if (e instanceof ValidationError) {
            set.status = 422;
            return { error: "Validation failed", code: 422, details: e.details };
          }
          throw e;
        }
        // Hash before the lookup, on both branches: argon2 dominates the
        // response time, and skipping it for a taken address made that branch
        // measurably faster.
        const hash = await hashPassword(body.password);
        // v0.11: per-collection email uniqueness via vb_<col> + legacy
        // fallback. Earlier versions enforced GLOBAL email uniqueness across
        // every auth collection — pre-existing rows still work via the
        // helper's fallback to vaultbase_users.
        // Any case: `ALICE@x` must not become a second account beside `alice@x`.
        const existing = findUserByEmailAnyCase(col, body.email);
        // No-enumeration: always return a generic success. If the email is
        // taken, queue a "complete account / reset password" email instead so
        // the legitimate owner can recover, and refuse silently.
        if (existing) {
          if (isSmtpConfigured()) {
            issueAndSend("reset", { id: existing.id, email: existing.email }, col.id, col.name).catch((e) => {
              console.error("[auth] reset email failed for", redactEmail(existing.email), "—", e instanceof Error ? e.message : e);
            });
          }
          // Return the same shape as a fresh-success path so a network observer
          // can't tell the two cases apart. `id` is the existing user's id —
          // not a leak: knowing the id alone gives no access without auth.
          return { data: { id: existing.id, email: body.email } };
        }
        const id = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
        const { email, password, ...extra } = body;
        void password;

        // Hook lifecycle — auth signup gets the same beforeCreate /
        // afterCreate semantics as the records flow. beforeCreate can
        // mutate `extra` (custom fields) or throw to abort.
        const hookData: Record<string, unknown> = { email, ...extra };
        const helpers = makeHookHelpers({ collection: col.name, event: "beforeCreate" });
        try {
          await runBeforeHook(col, "beforeCreate", { record: hookData, existing: null, auth: null, helpers });
        } catch (e) {
          if (e instanceof ValidationError) {
            set.status = 422;
            return { error: "Validation failed", code: 422, details: e.details };
          }
          throw e;
        }
        const finalExtra: Record<string, unknown> = { ...(hookData as Record<string, unknown>) };
        delete finalExtra.email; // already a top-level column

        await insertUser(col, {
          id,
          email,
          password_hash: hash,
          custom: finalExtra,
          legacyDataJson: JSON.stringify(finalExtra),
          created_at: now,
          updated_at: now,
        });

        // Read back as a record (uniform shape with password_hash stripped)
        // and fire afterCreate.
        const created = await getRecord(col.name, id);
        if (created) emitSignup(col, created, "password");
        if (isSmtpConfigured()) {
          issueAndSend("verify", { id, email }, col.id, col.name).catch((e) => {
            console.error("[auth] verification email failed for", redactEmail(email), "—", e instanceof Error ? e.message : e);
          });
        }
        return { data: { id, email } };
      },
      {
        body: t.Object(
          { email: t.String(), password: t.String() },
          { additionalProperties: true }
        ),
      }
    )
    .post(
      "/auth/:collection/login",
      async ({ params, body, request, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        // Per-account lockout, charged before the password is checked. The
        // per-IP rate limit alone doesn't stop a guesser with many addresses.
        // Per-collection email lookup (vb_<col> first, legacy fallback).
        const u = findUserByEmail(col, body.email);
        const lockout = { scope: `user:${col.id}`, email: body.email, subject: u?.id, ip: clientIpForLockout(request) };
        const attempt = await reserveLoginAttempt(lockout);
        if (!attempt) {
          set.status = 429; return { error: "Too many failed attempts. Try again later.", code: 429 };
        }
        // Always verify (against dummy hash on miss) so timing is constant.
        const hashToCheck = u?.password_hash ?? dummyPasswordHash();
        const valid = await Bun.password.verify(body.password, hashToCheck).catch(() => false);
        if (!u || !valid) { set.status = 401; return { error: "Invalid credentials", code: 401 }; }
        await loginSucceeded(attempt);

        const db = getDb();
        if (u.totp_enabled === 1) {
          const ticket = newToken();
          const now = Math.floor(Date.now() / 1000);
          await db.insert(authTokens).values({
            id: storedTokenId(ticket),
            user_id: u.id,
            collection_id: col.id,
            purpose: "mfa_ticket",
            expires_at: now + MFA_TICKET_TTL_SECONDS,
          });
          return { data: { mfa_required: true, mfa_token: ticket } };
        }

        const { token } = await signAuthToken({
          payload: { id: u.id, email: u.email, collection: params.collection },
          audience: "user",
          expiresInSeconds: tokenWindowSeconds("user"),
          jwtSecret,
        });
        return { data: { token, record: { id: u.id, email: u.email } } };
      },
      { body: t.Object({ email: t.String(), password: t.String() }) }
    )
    // Step-2 of MFA login: trade the mfa_token + a valid TOTP code (or a
    // single-use recovery code) for a full JWT. Exactly one of `code` /
    // `recovery_code` must be supplied.
    .post(
      "/auth/:collection/login/mfa",
      async ({ params, body, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        const hasCode = typeof body.code === "string" && body.code.length > 0;
        const hasRecovery = typeof body.recovery_code === "string" && body.recovery_code.length > 0;
        if (hasCode === hasRecovery) {
          set.status = 422;
          return { error: "Provide exactly one of code or recovery_code", code: 422 };
        }
        const db = getDb();
        const rows = await findOneTimeToken(body.mfa_token);
        const tok = rows[0];
        const now = Math.floor(Date.now() / 1000);
        if (!tok || tok.purpose !== "mfa_ticket" || tok.collection_id !== col.id || tok.used_at || tok.expires_at < now) {
          set.status = 400;
          return { error: "Invalid or expired MFA ticket", code: 400 };
        }
        const u = findUserById(col, tok.user_id);
        if (!u || !u.totp_secret) {
          set.status = 400;
          return { error: "MFA not configured for this account", code: 400 };
        }
        // Brute-force gate per account, across every ticket: `/login` mints a
        // fresh ticket for anyone with the password, so a per-ticket count
        // alone would let them walk the code space.
        // Both budgets are charged before the code is compared, so parallel
        // guesses can't all read the same count.
        const attempt = await reserveAttempt(`mfa:${col.id}:${u.id}`, MAX_ACCOUNT_CODE_FAILURES, ATTEMPT_WINDOW_SECONDS);
        if (!attempt) {
          set.status = 429;
          return { error: "Too many failed attempts. Try again later.", code: 429 };
        }
        if (!(await spendTokenAttempt(tok.id))) {
          await releaseAttempt(attempt);
          set.status = 400;
          return { error: "Invalid or expired MFA ticket", code: 400 };
        }
        if (hasCode) {
          const totp = await verifyTotpOnce(col.id, u.id, u.totp_secret, body.code!);
          if (totp !== "ok") {
            // A spent code is the right code sent twice (a double submit),
            // not a guess, so it doesn't eat into the account's budget.
            if (totp === "replayed") await releaseAttempt(attempt);
            set.status = 401;
            return { error: "Invalid code", code: 401 };
          }
        } else {
          // O(1) HMAC lookup; the actual hash is still argon2id (defense in depth).
          const hmac = await hmacRecoveryCode(body.recovery_code!, jwtSecret);
          const lookupRows = await db
            .select()
            .from(mfaRecoveryLookup)
            .where(eq(mfaRecoveryLookup.hmac, hmac))
            .limit(1);
          let matchId: string | null = null;
          if (lookupRows[0]) {
            const codeRow = await db
              .select()
              .from(mfaRecoveryCodes)
              .where(and(
                eq(mfaRecoveryCodes.id, lookupRows[0].recovery_id),
                eq(mfaRecoveryCodes.user_id, u.id),
                eq(mfaRecoveryCodes.collection_id, col.id),
                isNull(mfaRecoveryCodes.used_at),
              ))
              .limit(1);
            if (codeRow[0]) {
              const ok = await Bun.password.verify(body.recovery_code!, codeRow[0].code_hash).catch(() => false);
              if (ok) matchId = codeRow[0].id;
            }
          }
          // Spend the code with a conditional UPDATE so two requests racing
          // the same recovery code can't both get through.
          const spent = matchId
            ? await db.update(mfaRecoveryCodes).set({ used_at: now })
                .where(and(eq(mfaRecoveryCodes.id, matchId), isNull(mfaRecoveryCodes.used_at)))
                .returning({ id: mfaRecoveryCodes.id })
            : [];
          if (spent.length === 0) {
            set.status = 401;
            return { error: "Invalid recovery code", code: 401 };
          }
          await db.delete(mfaRecoveryLookup).where(eq(mfaRecoveryLookup.recovery_id, matchId!));
        }
        await releaseAttempt(attempt);
        if (!(await consumeToken(tok.id, now))) {
          set.status = 400;
          return { error: "Invalid or expired MFA ticket", code: 400 };
        }
        // A merge-confirm waiting on this second factor: link the provider now.
        if (tok.payload) {
          try {
            const pending = JSON.parse(tok.payload) as { link?: PendingLink };
            if (pending.link) await applyProviderLink(col.id, col, u.id, pending.link);
          } catch { /* not a pending-work payload */ }
        }
        const { token } = await signAuthToken({
          payload: { id: u.id, email: u.email, collection: col.name },
          audience: "user",
          expiresInSeconds: tokenWindowSeconds("user"),
          jwtSecret,
        });
        return { data: { token, record: { id: u.id, email: u.email } } };
      },
      { body: t.Object({
          mfa_token: t.String(),
          code: t.Optional(t.String()),
          recovery_code: t.Optional(t.String()),
        }) }
    )
    // Mint 10 fresh recovery codes (replaces all existing). Returns plaintext.
    .post(
      "/auth/:collection/totp/recovery/regenerate",
      async ({ params, request, body, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        if (!isAuthFeatureEnabled("mfa")) { set.status = 422; return { error: "MFA is disabled", code: 422 }; }
        const session = await userSession(request, jwtSecret, col.name);
        if (!session) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
        const userId = session.id;
        const db = getDb();
        const u = findUserById(col, userId);
        if (!u) { set.status = 404; return { error: "User not found", code: 404 }; }
        if (u.totp_enabled !== 1 || !u.totp_secret) { set.status = 422; return { error: "MFA is not enabled", code: 422 }; }
        // A fresh set of recovery codes is a second factor in its own right:
        // a session alone (a stolen token) must not be able to mint one.
        // Same proof and budget as /totp/disable.
        const attempt = await reserveAttempt(`mfa:${col.id}:${u.id}`, MAX_ACCOUNT_CODE_FAILURES, ATTEMPT_WINDOW_SECONDS);
        if (!attempt) { set.status = 429; return { error: "Too many failed attempts. Try again later.", code: 429 }; }
        const totp = typeof body?.code === "string" ? await verifyTotpOnce(col.id, u.id, u.totp_secret, body.code) : "invalid";
        if (totp !== "ok") {
          if (totp === "replayed" || typeof body?.code !== "string") await releaseAttempt(attempt);
          set.status = 401; return { error: "A current authenticator code is required", code: 401 };
        }
        await releaseAttempt(attempt);
        const codes = await generateRecoveryCodesFor(u.id, col.id, jwtSecret);
        return { data: { codes } };
      },
      { body: t.Optional(t.Object({ code: t.Optional(t.String()) })) }
    )
    // Counts of recovery codes (never plaintext). Used by the UI to nag users
    // to regenerate when they're running low.
    .get(
      "/auth/:collection/totp/recovery/status",
      async ({ params, request, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        const session = await userSession(request, jwtSecret, col.name);
        if (!session) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
        const userId = session.id;
        const db = getDb();
        const rows = await db
          .select()
          .from(mfaRecoveryCodes)
          .where(and(eq(mfaRecoveryCodes.user_id, userId), eq(mfaRecoveryCodes.collection_id, col.id)));
        const total = rows.length;
        const remaining = rows.filter((r) => r.used_at === null).length;
        return { data: { total, remaining } };
      }
    )
    .get("/auth/me", async ({ request, set }) => {
      const token = request.headers.get("authorization")?.replace("Bearer ", "");
      if (!token) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      const ctx = await verifyAuthToken(token, jwtSecret, { audience: "user" });
      if (!ctx) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      return { data: { id: ctx.id, email: ctx.email ?? "", aud: "user", exp: ctx.exp } };
    })
    // ── Email verification ──────────────────────────────────────────────────
    // Authenticated user requests a fresh verification email for their address.
    .post("/auth/:collection/request-verify", async ({ params, request, set }) => {
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
      const session = await userSession(request, jwtSecret, col.name);
      if (!session) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      const userId = session.id;
      const db = getDb();
      const u = findUserById(col, userId);
      if (!u) { set.status = 404; return { error: "User not found", code: 404 }; }
      if (u.email_verified) return { data: { sent: false, alreadyVerified: true } };
      if (!isSmtpConfigured()) { set.status = 422; return { error: "SMTP not configured", code: 422 }; }
      try {
        const sent = await issueAndSend("verify", { id: u.id, email: u.email }, col.id, col.name);
        if (!sent) { set.status = 429; return { error: "A verification email was sent recently. Try again later.", code: 429 }; }
        return { data: { sent: true } };
      } catch (e) {
        set.status = 500;
        return { error: e instanceof Error ? e.message : String(e), code: 500 };
      }
    })
    // Anyone with a valid token can confirm their email.
    .post(
      "/auth/:collection/verify-email",
      async ({ params, body, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        const db = getDb();
        const rows = await findOneTimeToken(body.token);
        const tok = rows[0];
        const now = Math.floor(Date.now() / 1000);
        if (!tok || tok.purpose !== "email_verify" || tok.collection_id !== col.id || tok.used_at || tok.expires_at < now) {
          set.status = 400; return { error: "Invalid or expired token", code: 400 };
        }
        await updateUserById(col, tok.user_id, { email_verified: 1, updated_at: now });
        await db.update(authTokens).set({ used_at: now }).where(eq(authTokens.id, tok.id));
        return { data: { verified: true } };
      },
      { body: t.Object({ token: t.String() }) }
    )
    // ── Password reset ──────────────────────────────────────────────────────
    // Always returns 200 to avoid leaking which emails are registered.
    .post(
      "/auth/:collection/request-password-reset",
      async ({ params, body, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        if (!isSmtpConfigured()) { set.status = 422; return { error: "SMTP not configured", code: 422 }; }
        const u = findUserByEmail(col, body.email);
        // Not awaited: waiting for the mail server only when the address has
        // an account would let the response time tell the two apart.
        if (u) {
          issueAndSend("reset", { id: u.id, email: u.email }, col.id, col.name).catch((e) => {
            console.error("[auth] password reset email failed for", redactEmail(u.email), "—", e instanceof Error ? e.message : e);
          });
        }
        return { data: { sent: true } };
      },
      { body: t.Object({ email: t.String() }) }
    )
    .post(
      "/auth/:collection/confirm-password-reset",
      async ({ params, body, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        {
          const pwErr = await validatePassword(typeof body.password === "string" ? body.password : "");
          if (pwErr) { set.status = 422; return { error: pwErr, code: 422 }; }
        }
        const db = getDb();
        const rows = await findOneTimeToken(body.token);
        const tok = rows[0];
        const now = Math.floor(Date.now() / 1000);
        if (!tok || tok.purpose !== "password_reset" || tok.collection_id !== col.id || tok.used_at || tok.expires_at < now) {
          set.status = 400; return { error: "Invalid or expired token", code: 400 };
        }
        const hash = await hashPassword(body.password);
        // password_reset_at ends every session issued before the reset, so a
        // stolen token stops working once the owner resets their password.
        await updateUserById(col, tok.user_id, { password_hash: hash, password_reset_at: now, updated_at: now });
        await db.update(authTokens).set({ used_at: now }).where(eq(authTokens.id, tok.id));
        // A reset is how an owner takes their account back: a provider linked
        // by whoever had it (merge-confirm with a leaked password) would
        // otherwise keep signing them in.
        await db.delete(oauthLinks).where(and(eq(oauthLinks.user_id, tok.user_id), eq(oauthLinks.collection_id, col.id)));
        return { data: { reset: true } };
      },
      { body: t.Object({ token: t.String(), password: t.String() }) }
    )
    // ── Email change ────────────────────────────────────────────────────────
    // The signed-in user asks; a link goes to the NEW address. Confirming
    // needs that link and the current password, so a hijacked session alone
    // can't move the account to an attacker's mailbox.
    .post(
      "/auth/:collection/request-email-change",
      async ({ params, body, request, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        const session = await userSession(request, jwtSecret, col.name);
        if (!session) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
        if (session.anonymous) { set.status = 422; return { error: "Anonymous accounts can't change email; promote the account instead", code: 422 }; }
        if (!isSmtpConfigured()) { set.status = 422; return { error: "SMTP not configured", code: 422 }; }
        const newEmail = body.newEmail.trim();
        if (!EMAIL_RE.test(newEmail)) { set.status = 422; return { error: "Invalid email", code: 422 }; }
        const u = findUserById(col, session.id);
        if (!u) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
        if (newEmail.toLowerCase() === u.email.toLowerCase()) { set.status = 422; return { error: "That is already your email", code: 422 }; }

        const db = getDb();
        const token = newToken();
        const now = Math.floor(Date.now() / 1000);
        const stored = storedTokenId(token);
        await db.insert(authTokens).values({
          id: stored,
          user_id: u.id,
          collection_id: col.id,
          purpose: "email_change",
          payload: newEmail,
          expires_at: now + TOKEN_TTL_SECONDS,
        });
        // The link goes to an address the caller chooses, so the same
        // cooldown applies: a signed-in user can't use this to flood a
        // stranger's inbox. Held back, the earlier link stays valid.
        if (!emailAllowed(stored, u.id, col.id, "email_change")) {
          await db.delete(authTokens).where(eq(authTokens.id, stored));
          set.status = 429; return { error: "An email change was requested recently. Try again in a minute.", code: 429 };
        }
        // A taken address gets the same answer as a free one, and no link:
        // the response mustn't tell a signed-in user who else has an account.
        // Checked after the cooldown so the two can't be told apart by a 429.
        // (Confirming re-checks, in case the address is taken in between.)
        // The row stays (spent) so it still counts towards the cooldown.
        if (findUserByEmailAnyCase(col, newEmail)) {
          await db.update(authTokens).set({ used_at: now }).where(eq(authTokens.id, stored));
          return { data: { sent: true } };
        }
        // One pending change at a time: a new request voids older links.
        await db.update(authTokens).set({ used_at: now }).where(and(
          eq(authTokens.user_id, u.id), eq(authTokens.purpose, "email_change"), isNull(authTokens.used_at), ne(authTokens.id, stored),
        ));
        // Not awaited: a taken address returns without sending, so waiting on
        // the mail server here would make free addresses measurably slower.
        sendTemplated("email_change", newEmail, token, col.name).catch((e) => {
          console.error("[auth] email change link failed for", redactEmail(newEmail), "—", e instanceof Error ? e.message : e);
        });
        return { data: { sent: true } };
      },
      { body: t.Object({ newEmail: t.String() }) }
    )
    .post(
      "/auth/:collection/confirm-email-change",
      async ({ params, body, request, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        const db = getDb();
        const tok = (await findOneTimeToken(body.token))[0];
        const now = Math.floor(Date.now() / 1000);
        if (!tok || tok.purpose !== "email_change" || tok.collection_id !== col.id || tok.used_at || tok.expires_at < now || !tok.payload) {
          set.status = 400; return { error: "Invalid or expired token", code: 400 };
        }
        const u = findUserById(col, tok.user_id);
        if (!u) { set.status = 401; return { error: "Invalid password", code: 401 }; }
        // The password is the only thing a stolen session lacks here, so it
        // gets the same lockout as sign-in.
        const lockout = { scope: `user:${col.id}`, email: u.email, subject: u.id, ip: clientIpForLockout(request) };
        const attempt = await reserveLoginAttempt(lockout);
        if (!attempt) {
          set.status = 429; return { error: "Too many failed attempts. Try again later.", code: 429 };
        }
        const valid = await Bun.password.verify(body.password, u.password_hash).catch(() => false);
        if (!valid) { set.status = 401; return { error: "Invalid password", code: 401 }; }
        await loginSucceeded(attempt);
        const taken = findUserByEmailAnyCase(col, tok.payload);
        if (taken && taken.id !== u.id) { set.status = 422; return { error: "Email already in use", code: 422 }; }
        // The link proves the new address; ending old sessions makes every
        // device sign in again with it.
        await updateUserById(col, u.id, { email: tok.payload, email_verified: 1, password_reset_at: now, updated_at: now });
        await db.update(authTokens).set({ used_at: now }).where(eq(authTokens.id, tok.id));
        return { data: { changed: true, email: tok.payload } };
      },
      { body: t.Object({ token: t.String(), password: t.String() }) }
    )
    // ── Invitations ─────────────────────────────────────────────────────────
    // An admin creates the account without a usable password and emails a
    // link; the invitee sets a password, which also verifies the address.
    .post(
      "/admin/users/:collection/invite",
      async ({ params, body, request, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        if (!isSmtpConfigured()) { set.status = 422; return { error: "SMTP not configured", code: 422 }; }
        const email = body.email.trim();
        if (!EMAIL_RE.test(email)) { set.status = 422; return { error: "Invalid email", code: 422 }; }
        if (findUserByEmailAnyCase(col, email)) { set.status = 409; return { error: "A user with this email already exists", code: 409 }; }

        const data: Record<string, unknown> = { ...(body.data ?? {}) };
        delete data["email"];
        delete data["password"];
        const helpers = makeHookHelpers({ collection: col.name, event: "beforeCreate" });
        const hookData: Record<string, unknown> = { email, ...data };
        try {
          await runBeforeHook(col, "beforeCreate", { record: hookData, existing: null, auth: null, helpers });
        } catch (e) {
          if (e instanceof ValidationError) { set.status = 422; return { error: "Validation failed", code: 422, details: e.details }; }
          throw e;
        }
        const custom: Record<string, unknown> = { ...hookData };
        delete custom["email"];
        const id = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
        // Unknown random password: the account can't sign in until the
        // invitee picks one (or resets it).
        await insertUser(col, {
          id,
          email,
          password_hash: await hashPassword(crypto.randomUUID() + crypto.randomUUID()),
          custom,
          legacyDataJson: JSON.stringify(custom),
          created_at: now,
          updated_at: now,
        });
        const created = await getRecord(col.name, id);
        if (created) emitSignup(col, created, "invite");

        const token = newToken();
        await getDb().insert(authTokens).values({
          id: storedTokenId(token), user_id: id, collection_id: col.id, purpose: "invite", expires_at: now + INVITE_TTL_SECONDS,
        });
        try {
          await sendTemplated("invite", email, token, col.name);
        } catch (e) {
          set.status = 502;
          return { error: `User created but the invitation email failed: ${e instanceof Error ? e.message : String(e)}`, code: 502, details: { id } };
        }
        return { data: { id, email } };
      },
      { requireAdmin: true, body: t.Object({ email: t.String(), data: t.Optional(t.Record(t.String(), t.Any())) }) }
    )
    .post(
      "/auth/:collection/accept-invite",
      async ({ params, body, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        const pwErr = await validatePassword(typeof body.password === "string" ? body.password : "");
        if (pwErr) { set.status = 422; return { error: pwErr, code: 422 }; }
        const db = getDb();
        const tok = (await findOneTimeToken(body.token))[0];
        const now = Math.floor(Date.now() / 1000);
        if (!tok || tok.purpose !== "invite" || tok.collection_id !== col.id || tok.used_at || tok.expires_at < now) {
          set.status = 400; return { error: "Invalid or expired invitation", code: 400 };
        }
        if (!findUserById(col, tok.user_id)) { set.status = 400; return { error: "Invalid or expired invitation", code: 400 }; }
        await updateUserById(col, tok.user_id, {
          password_hash: await hashPassword(body.password), email_verified: 1, password_reset_at: now, updated_at: now,
        });
        await db.update(authTokens).set({ used_at: now }).where(eq(authTokens.id, tok.id));
        return { data: { accepted: true } };
      },
      { body: t.Object({ token: t.String(), password: t.String() }) }
    )
    // ── OTP / magic link ────────────────────────────────────────────────────
    // Always returns 200 (no enumeration). Issues both a long token (link) and
    // a 6-digit code; either can be used to authenticate.
    .post(
      "/auth/:collection/otp/request",
      async ({ params, body, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        if (!isAuthFeatureEnabled("otp")) { set.status = 422; return { error: "OTP login is disabled", code: 422 }; }
        if (!isSmtpConfigured()) { set.status = 422; return { error: "SMTP not configured", code: 422 }; }
        const u = findUserByEmail(col, body.email);
        // Not awaited, for the same reason as password reset: no timing
        // difference between addresses with and without an account.
        if (u && u.is_anonymous !== 1) {
          issueOtpAndSend({ id: u.id, email: u.email }, col.id, col.name, jwtSecret).catch((e) => {
            console.error("[auth] otp email failed for", redactEmail(u.email), "—", e instanceof Error ? e.message : e);
          });
        }
        return { data: { sent: true } };
      },
      { body: t.Object({ email: t.String() }) }
    )
    // Auth via OTP — accepts either the long token OR the short code.
    // Logout — revokes the bearer token's `jti` and clears any auth cookies.
    .post("/auth/logout", async ({ request }) => {
      const { extractBearer, revokeToken } = await import("../core/sec.ts");
      const token = extractBearer(request);
      if (token) {
        const ctx = await verifyAuthToken(token, jwtSecret, { recheckPrincipal: false });
        if (ctx?.jti && ctx.exp) await revokeToken(ctx.jti, ctx.exp);
        // A tab still holding a token that was just refreshed elsewhere is
        // signing out that session: end the replacement too, rather than
        // leaving it live (and fetchable with the old token for 30 s).
        await endRefreshedReplacement(token, jwtSecret);
      }
      const isHttps = cookieSecure(request);
      const secureFlag = isHttps ? " Secure;" : "";
      const headers = new Headers({ "content-type": "application/json" });
      headers.append("set-cookie", `vaultbase_admin_token=; Path=/; HttpOnly;${secureFlag} SameSite=Lax; Max-Age=0`);
      headers.append("set-cookie", `vaultbase_user_token=; Path=/; HttpOnly;${secureFlag} SameSite=Lax; Max-Age=0`);
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers });
    })
    .post(
      "/auth/:collection/otp/auth",
      async ({ params, body, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        if (!isAuthFeatureEnabled("otp")) { set.status = 422; return { error: "OTP login is disabled", code: 422 }; }
        if (!body.token && !body.code) {
          set.status = 422; return { error: "Provide token or code", code: 422 };
        }
        const db = getDb();
        const now = Math.floor(Date.now() / 1000);
        let tok;
        if (body.token) {
          const rows = await findOneTimeToken(body.token);
          tok = rows[0];
        } else {
          // Code lookups need the email too — codes alone are 6 digits and
          // cross-user collisions during the 10-minute window are realistic.
          if (!body.email) { set.status = 422; return { error: "code requires email", code: 422 }; }
          // Failures count per address, across every code sent in the window,
          // and are charged before anything is compared so parallel guesses
          // can't all read the same count. Unknown addresses are charged too,
          // so a 429 doesn't tell whether the account exists.
          const attempt = await reserveAttempt(`otp:${col.id}:${body.email.trim().toLowerCase()}`, MAX_ACCOUNT_CODE_FAILURES, ATTEMPT_WINDOW_SECONDS);
          if (!attempt) {
            set.status = 429; return { error: "Too many failed attempts. Try again later.", code: 429 };
          }
          const userByEmail = findUserByEmail(col, body.email);
          // Look up the user's live code, then compare. Looking up *by* code
          // meant a wrong guess matched nothing and was never counted.
          const tokenRows = userByEmail ? await db
            .select()
            .from(authTokens)
            .where(and(
              eq(authTokens.user_id, userByEmail.id),
              eq(authTokens.collection_id, col.id),
              eq(authTokens.purpose, "otp"),
              isNull(authTokens.used_at),
              gte(authTokens.expires_at, now),
            ))
            .orderBy(desc(authTokens.created_at))
            .limit(1) : [];
          tok = tokenRows[0];
          if (!tok || !(await spendTokenAttempt(tok.id)) || !(tok.code && timingSafeEqualStr(tok.code, await otpCodeDigest(body.code!, jwtSecret)))) {
            set.status = 400; return { error: "Invalid or expired code", code: 400 };
          }
          await releaseAttempt(attempt);
        }
        if (!tok || tok.purpose !== "otp" || tok.collection_id !== col.id || tok.used_at || tok.expires_at < now) {
          set.status = 400; return { error: "Invalid or expired code", code: 400 };
        }
        if ((tok.attempts ?? 0) >= MAX_OTP_ATTEMPTS) {
          await db.update(authTokens).set({ used_at: now }).where(eq(authTokens.id, tok.id));
          set.status = 400; return { error: "Invalid or expired code", code: 400 };
        }
        const u = findUserById(col, tok.user_id);
        if (!u) {
          set.status = 400; return { error: "Invalid or expired code", code: 400 };
        }

        if (!(await consumeToken(tok.id, now))) {
          set.status = 400; return { error: "Invalid or expired code", code: 400 };
        }
        // OTP-issued sessions imply the email is verified (the IdP — us — confirmed it).
        if (!u.email_verified) {
          await updateUserById(col, u.id, { email_verified: 1, updated_at: now });
        }
        // OTP MFA gate would defeat the purpose of magic-link sign-in (no password).
        // We still respect TOTP if the user enabled it: issue an mfa ticket instead.
        if (u.totp_enabled === 1) {
          const ticket = newToken();
          await db.insert(authTokens).values({
            id: storedTokenId(ticket),
            user_id: u.id,
            collection_id: col.id,
            purpose: "mfa_ticket",
            expires_at: now + MFA_TICKET_TTL_SECONDS,
          });
          return { data: { mfa_required: true, mfa_token: ticket } };
        }
        const { token: jwt } = await signAuthToken({
          payload: { id: u.id, email: u.email, collection: col.name },
          audience: "user",
          expiresInSeconds: tokenWindowSeconds("user"),
          jwtSecret,
        });
        return { data: { token: jwt, record: { id: u.id, email: u.email } } };
      },
      { body: t.Object({
          token: t.Optional(t.String()),
          code: t.Optional(t.String()),
          email: t.Optional(t.String()),
        }) }
    )
    // ── TOTP ────────────────────────────────────────────────────────────────
    // Step 1: generate a fresh secret + otpauth URL. Doesn't enable MFA yet.
    .post("/auth/:collection/totp/setup", async ({ params, request, set }) => {
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
      if (!isAuthFeatureEnabled("mfa")) { set.status = 422; return { error: "MFA is disabled", code: 422 }; }
      const session = await userSession(request, jwtSecret, col.name);
      if (!session) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      const userId = session.id;
      const db = getDb();
      const u = findUserById(col, userId);
      if (!u) { set.status = 404; return { error: "User not found", code: 404 }; }
      // Replacing a live secret needs no code here, so a stolen session could
      // swap in one it controls and then pass every MFA check. Disabling first
      // takes the current code.
      if (u.totp_enabled === 1) {
        set.status = 409; return { error: "MFA is already enabled. Disable it with a current code first.", code: 409 };
      }
      const secret = generateSecret();
      // Stash the pending secret on the user; gets activated on /confirm.
      await updateUserById(col, u.id, { totp_secret: secret, updated_at: Math.floor(Date.now() / 1000) });
      const otpauthUrl = buildOtpauthUrl({
        secret,
        accountName: u.email,
        issuer: getAppUrl() || "Vaultbase",
      });
      return { data: { secret, otpauth_url: otpauthUrl } };
    })
    // Step 2: confirm by submitting a code from the authenticator app — flips totp_enabled.
    .post(
      "/auth/:collection/totp/confirm",
      async ({ params, request, body, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        if (!isAuthFeatureEnabled("mfa")) { set.status = 422; return { error: "MFA is disabled", code: 422 }; }
        const session = await userSession(request, jwtSecret, col.name);
        if (!session) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
        const userId = session.id;
        const db = getDb();
        const u = findUserById(col, userId);
        if (!u) { set.status = 404; return { error: "User not found", code: 404 }; }
        if (!u.totp_secret) { set.status = 400; return { error: "Run /totp/setup first", code: 400 }; }
        // Confirming hands out recovery codes, so it must not double as a way
        // round /recovery/regenerate: only a pending enrolment can be
        // confirmed, under the same per-account budget.
        if (u.totp_enabled === 1) { set.status = 409; return { error: "MFA is already enabled", code: 409 }; }
        const attempt = await reserveAttempt(`mfa:${col.id}:${u.id}`, MAX_ACCOUNT_CODE_FAILURES, ATTEMPT_WINDOW_SECONDS);
        if (!attempt) { set.status = 429; return { error: "Too many failed attempts. Try again later.", code: 429 }; }
        const totp = await verifyTotpOnce(col.id, u.id, u.totp_secret, body.code);
        if (totp !== "ok") {
          if (totp === "replayed") await releaseAttempt(attempt);
          set.status = 401; return { error: "Invalid code", code: 401 };
        }
        await releaseAttempt(attempt);
        await updateUserById(col, u.id, { totp_enabled: 1, updated_at: Math.floor(Date.now() / 1000) });
        // Hand out the first set of recovery codes here, where the code that
        // proves the authenticator works was just checked. Regenerating later
        // takes a fresh code.
        const codes = await generateRecoveryCodesFor(u.id, col.id, jwtSecret);
        return { data: { enabled: true, recovery_codes: codes } };
      },
      { body: t.Object({ code: t.String() }) }
    )
    // Disable MFA. Requires the current code to prevent hijacked sessions from disabling it.
    .post(
      "/auth/:collection/totp/disable",
      async ({ params, request, body, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        const session = await userSession(request, jwtSecret, col.name);
        if (!session) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
        const userId = session.id;
        const db = getDb();
        const u = findUserById(col, userId);
        if (!u) { set.status = 404; return { error: "User not found", code: 404 }; }
        if (!u.totp_secret) { set.status = 400; return { error: "MFA not configured", code: 400 }; }
        // Same per-account budget as sign-in: a stolen session must not be
        // able to guess its way past the code that guards this.
        const attempt = await reserveAttempt(`mfa:${col.id}:${u.id}`, MAX_ACCOUNT_CODE_FAILURES, ATTEMPT_WINDOW_SECONDS);
        if (!attempt) {
          set.status = 429; return { error: "Too many failed attempts. Try again later.", code: 429 };
        }
        const totp = await verifyTotpOnce(col.id, u.id, u.totp_secret, body.code);
        if (totp !== "ok") {
          if (totp === "replayed") await releaseAttempt(attempt);
          set.status = 401; return { error: "Invalid code", code: 401 };
        }
        await releaseAttempt(attempt);
        await updateUserById(col, u.id, { totp_enabled: 0, totp_secret: null, updated_at: Math.floor(Date.now() / 1000) });
        // Wipe recovery codes — they're useless without TOTP, and leaving
        // them around would let a re-enabled MFA inherit stale codes.
        await db
          .delete(mfaRecoveryCodes)
          .where(and(eq(mfaRecoveryCodes.user_id, u.id), eq(mfaRecoveryCodes.collection_id, col.id)));
        return { data: { enabled: false } };
      },
      { body: t.Object({ code: t.String() }) }
    )
    // ── Anonymous ──────────────────────────────────────────────────────────
    // Mints a guest user with a synthetic email. The returned JWT is a regular
    // user token — caller can later "promote" by setting email + password via PATCH.
    .post("/auth/:collection/anonymous", async ({ params, request, set }) => {
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
      if (!isAuthFeatureEnabled("anonymous")) { set.status = 422; return { error: "Anonymous auth is disabled", code: 422 }; }
      if (!(await signupAllowed(request, jwtSecret, col, {}))) {
        set.status = 403; return { error: "Forbidden", code: 403 };
      }
      const id = crypto.randomUUID();
      const email = `anon_${id.replace(/-/g, "").slice(0, 16)}@anonymous.invalid`;
      const randomPw = crypto.randomUUID() + crypto.randomUUID();
      const hash = await hashPassword(randomPw);
      const now = Math.floor(Date.now() / 1000);
      await insertUser(col, {
        id,
        email,
        password_hash: hash,
        is_anonymous: 1,
        legacyDataJson: "{}",
        created_at: now,
        updated_at: now,
      });
      // afterCreate hook on anonymous signup — same lifecycle as a real
      // user, so apps that auto-provision related rows (default profile,
      // welcome notification, etc.) keep working.
      const created = await getRecord(col.name, id);
      if (created) emitSignup(col, created, "anonymous");
      const { token: jwt } = await signAuthToken({
        payload: { id, email, collection: col.name, anonymous: true },
        audience: "user",
        expiresInSeconds: tokenWindowSeconds("anonymous"),
        jwtSecret,
      });
      return { data: { token: jwt, record: { id, email, anonymous: true } } };
    })
    // ── Anonymous → real account promotion ─────────────────────────────────
    // Caller must be holding an anonymous user JWT; supplies a real email +
    // password. We hash the password, flip is_anonymous=0, mint a fresh
    // (non-anonymous) JWT. Validates email uniqueness and the collection's
    // schema (so a min-length on `email` still applies).
    .post(
      "/auth/:collection/promote",
      async ({ params, request, body, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        const session = await userSession(request, jwtSecret, col.name);
        if (!session) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
        const userId = session.id;
        const isAnon = session.anonymous === true;
        if (!isAnon) {
          set.status = 422;
          return { error: "Only anonymous accounts can be promoted", code: 422 };
        }
        const db = getDb();
        const u = findUserById(col, userId);
        if (!u) { set.status = 404; return { error: "User not found", code: 404 }; }
        if (u.is_anonymous !== 1) {
          set.status = 422;
          return { error: "Only anonymous accounts can be promoted", code: 422 };
        }
        // Becoming a real account is a sign-up: the guest's custom fields
        // come from this body, so the create rule applies to it.
        if (!(await signupAllowed(request, jwtSecret, col, body as Record<string, unknown>))) {
          set.status = 403; return { error: "Forbidden", code: 403 };
        }
        // Validate against the collection's schema (implicit + user fields).
        try {
          await validateAuthRegister(col, body as Record<string, unknown>);
        } catch (e) {
          if (e instanceof ValidationError) {
            set.status = 422;
            return { error: "Validation failed", code: 422, details: e.details };
          }
          throw e;
        }
        // Password first: checked after the duplicate lookup, a weak password
        // answered 409 or 422 depending only on whether the address was
        // taken, a free probe that creates nothing. (A valid request to a
        // taken address still gets 409: promote has to say why it failed.)
        {
          const pwErr = await validatePassword(typeof body.password === "string" ? body.password : "");
          if (pwErr) { set.status = 422; return { error: pwErr, code: 422 }; }
        }
        // Email uniqueness within the collection (excluding self).
        // Case-insensitive, as register checks: `ALICE@x` beside `alice@x`
        // is the same mailbox under two accounts.
        const dup = findUserByEmailAnyCase(col, body.email);
        if (dup && dup.id !== u.id) {
          set.status = 409; return { error: "Email already in use", code: 409 };
        }
        const hash = await hashPassword(body.password);
        const now = Math.floor(Date.now() / 1000);
        const { email, password, ...extra } = body as Record<string, unknown>;
        void password;
        const update: Record<string, unknown> = {
          email: email as string,
          password_hash: hash,
          is_anonymous: 0,
          updated_at: now,
        };
        // Only the collection's own declared fields may come from the body.
        // updateUserById only checks that a key is a column, and the system
        // columns (`id`, `email_verified`, `totp_*`, `password_reset_at`, …)
        // are columns too.
        const declared = new Set(
          parseFields(col.fields).filter((f) => !f.system && !f.implicit).map((f) => f.name),
        );
        for (const [k, v] of Object.entries(extra)) {
          if (declared.has(k) && !(AUTH_USER_COLUMNS as readonly string[]).includes(k)) update[k] = v;
        }
        // Ending the guest's sessions: the anonymous token (and any copy of
        // it) stops working once the account has a real owner.
        update["password_reset_at"] = now;
        await updateUserById(col, u.id, update);
        if (session.jti && session.exp) await revokeToken(session.jti, session.exp);
        const { token: jwt } = await signAuthToken({
          payload: { id: u.id, email: email as string, collection: col.name },
          audience: "user",
          expiresInSeconds: tokenWindowSeconds("user"),
          jwtSecret,
        });
        return { data: { token: jwt, record: { id: u.id, email: email as string } } };
      },
      {
        body: t.Object(
          { email: t.String(), password: t.String() },
          { additionalProperties: true }
        ),
      }
    )
    // ── Admin impersonation ────────────────────────────────────────────────
    // Admin mints a short-lived user JWT for support purposes. JWT carries
    // `impersonated_by` so audit logs can attribute actions to the admin.
    // The guard uses the central verifier, so a revoked or force-logged-out
    // admin token can't mint user sessions.
    .post("/admin/impersonate/:collection/:userId", async ({ params, admin, set }) => {
      const adminId = admin.id;
      if (!isAuthFeatureEnabled("impersonation")) { set.status = 422; return { error: "Impersonation is disabled", code: 422 }; }
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
      const u = findUserById(col, params.userId);
      if (!u) { set.status = 404; return { error: "User not found", code: 404 }; }
      const { token: jwt } = await signAuthToken({
        payload: { id: u.id, email: u.email, collection: col.name, impersonated_by: adminId },
        audience: "user",
        expiresInSeconds: tokenWindowSeconds("impersonate"),
        jwtSecret,
      });
      return { data: { token: jwt, record: { id: u.id, email: u.email }, impersonated_by: adminId } };
    }, { requireAdmin: true })
    // ── OAuth2 ──────────────────────────────────────────────────────────────
    // List enabled providers for this collection (gated by collection.type='auth').
    .get("/auth/:collection/oauth2/providers", async ({ params, set }) => {
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
      return { data: listEnabledProviders() };
    })
    // Returns the provider's authorize URL with the caller-supplied redirect/state.
    // PKCE (RFC 7636):
    //  - Client provides `code_challenge` → server bakes it into the URL untouched
    //    and never stores anything; the client owns the verifier.
    //  - Client omits `code_challenge` → server generates a verifier, stashes it
    //    with the flow's state row (purpose="oauth2_state"), and
    //    bakes the derived challenge into the URL. Useful for confidential web
    //    flows where the caller can't easily keep the verifier across the redirect.
    .get("/auth/:collection/oauth2/authorize", async ({ params, query, set }) => {
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
      if (!query.provider || !query.redirectUri) {
        set.status = 422; return { error: "provider and redirectUri are required", code: 422 };
      }
      if (!isProviderEnabled(query.provider)) {
        set.status = 422; return { error: `Provider '${query.provider}' is not enabled`, code: 422 };
      }
      if (!isRedirectUriAllowed(query.provider, query.redirectUri)) {
        set.status = 422; return { error: "redirectUri not in allowlist", code: 422 };
      }
      // The state is recorded server-side for every flow, bound to the
      // provider and redirect URI, and /exchange requires it back. Checking
      // it only in the browser (or only for server-side PKCE) let a forged
      // callback complete someone else's sign-in in the victim's browser.
      const state = query.state || newToken();
      // The state travels through URLs, so anyone can obtain a valid one by
      // starting a flow of their own and then plant its callback in a
      // victim's browser (login CSRF). The state secret never leaves the
      // page that called /authorize; /exchange requires it, so only that
      // page can finish the flow.
      const stateSecret = newToken();
      const nonce = providerUsesNonce(query.provider) ? newToken() : undefined;
      let codeChallenge: string | undefined;
      let verifier: string | undefined;
      let serverManagedPkce = false;
      // Twitter (and any future requiresPkce provider) needs PKCE no matter what
      // the caller asked for. Promote use_pkce so we generate + store the verifier.
      const forcePkce = providerRequiresPkce(query.provider);
      if (query.code_challenge) {
        // Client-managed PKCE: trust their challenge, store no verifier.
        codeChallenge = query.code_challenge;
      } else if (query.use_pkce === "1" || query.use_pkce === "true" || forcePkce) {
        // Server-managed PKCE: generate the verifier and keep it with the state.
        verifier = generateCodeVerifier();
        codeChallenge = await codeChallengeFromVerifier(verifier);
        serverManagedPkce = true;
      }
      try {
        await getDb().insert(authTokens).values({
          id: storedTokenId(state),
          user_id: "",       // pre-auth flow, no user yet
          collection_id: col.id,
          purpose: "oauth2_state",
          code: verifier ?? null,
          payload: JSON.stringify({
            provider: query.provider, redirectUri: query.redirectUri, nonce: nonce ?? null,
            secretHash: storedTokenId(stateSecret),
          }),
          expires_at: Math.floor(Date.now() / 1000) + PKCE_TTL_SECONDS,
        });
      } catch {
        set.status = 422;
        return { error: "state must be unique", code: 422 };
      }
      try {
        const url = buildAuthorizeUrl({
          provider: query.provider,
          redirectUri: query.redirectUri,
          state,
          ...(nonce ? { nonce } : {}),
          ...(codeChallenge ? { codeChallenge, codeChallengeMethod: "S256" as const } : {}),
        });
        return {
          data: {
            authorize_url: url,
            state,
            state_secret: stateSecret,
            ...(codeChallenge ? { code_challenge: codeChallenge, code_challenge_method: "S256" } : {}),
            pkce: serverManagedPkce ? "server" : codeChallenge ? "client" : "none",
          },
        };
      } catch (e) {
        set.status = 422;
        return { error: e instanceof Error ? e.message : String(e), code: 422 };
      }
    }, {
      query: t.Object({
        provider: t.String(),
        redirectUri: t.String(),
        state: t.Optional(t.String()),
        code_challenge: t.Optional(t.String()),
        use_pkce: t.Optional(t.String()),
      }),
    })
    // Exchange authorization code for a vaultbase JWT.
    // Linking strategy:
    //  1. Existing oauth_link row for (provider, provider_user_id) → log in linked user
    //  2. Otherwise, if profile.emailVerified and email matches an existing user in
    //     this collection → create link, log in
    //  3. Otherwise, create a fresh user (random unguessable password) + link
    .post("/auth/:collection/oauth2/exchange", async ({ params, body, request, set }) => {
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
      if (!PROVIDERS[body.provider]) {
        set.status = 422; return { error: `Unknown provider '${body.provider}'`, code: 422 };
      }
      if (!isProviderEnabled(body.provider)) {
        set.status = 422; return { error: `Provider '${body.provider}' is not enabled`, code: 422 };
      }
      if (!isRedirectUriAllowed(body.provider, body.redirectUri)) {
        set.status = 422; return { error: "redirectUri not in allowlist", code: 422 };
      }

      // The state from /authorize is required, must belong to this provider
      // and redirect URI, and is spent here (once).
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      if (!body.state || !body.state_secret) { set.status = 400; return { error: "state and state_secret are required", code: 400 }; }
      const stateRow = (await findOneTimeToken(body.state))[0];
      let stored: { provider?: string; redirectUri?: string; nonce?: string | null; secretHash?: string } = {};
      try { stored = JSON.parse(stateRow?.payload ?? "{}"); } catch { /* invalid below */ }
      if (
        !stateRow || stateRow.purpose !== "oauth2_state" || stateRow.collection_id !== col.id ||
        stateRow.used_at || stateRow.expires_at < now ||
        stored.provider !== body.provider || stored.redirectUri !== body.redirectUri ||
        !stored.secretHash || !timingSafeEqualStr(stored.secretHash, storedTokenId(body.state_secret)) ||
        !(await consumeToken(stateRow.id, now))
      ) {
        set.status = 400; return { error: "Invalid or expired state", code: 400 };
      }
      const codeVerifier: string | undefined = body.code_verifier ?? stateRow.code ?? undefined;

      let profile;
      try {
        const tok = await exchangeCodeForToken({
          provider: body.provider,
          code: body.code,
          redirectUri: body.redirectUri,
          ...(codeVerifier ? { codeVerifier } : {}),
        });
        // An id_token must carry the nonce this flow sent, so one minted for
        // another sign-in can't be replayed into this one.
        if (stored.nonce) {
          const got = idTokenNonce(tok.raw);
          if (got !== undefined && got !== stored.nonce) throw new Error("id_token nonce mismatch");
          if (got === undefined && body.provider === "apple") throw new Error("Apple did not return an id_token");
        }
        // Apple: identity comes from the id_token in the exchange response.
        // Everyone else: hit the provider's userinfo endpoint with the access_token.
        profile = await fetchProviderProfileFromExchange(body.provider, tok);
      } catch (e) {
        set.status = 400;
        return { error: e instanceof Error ? e.message : String(e), code: 400 };
      }
      if (!profile.id || !profile.email) {
        set.status = 400;
        return { error: "Provider returned an incomplete profile (missing id or email)", code: 400 };
      }

      // 1. Existing link?
      const linked = await db
        .select()
        .from(oauthLinks)
        .where(and(eq(oauthLinks.provider, body.provider), eq(oauthLinks.provider_user_id, profile.id)))
        .limit(1);
      let userId: string | null = null;
      if (linked.length > 0 && linked[0]!.collection_id === col.id) {
        userId = linked[0]!.user_id;
      }

      // 2. Email-match (only if provider verified the email).
      //    Instead of auto-linking, return a 200 with `merge_required: true`
      //    and a single-use `merge_token`. The caller must call
      //    `/oauth2/merge-confirm` with the user's existing password (or a
      //    valid user token for that user) to consent before we link.
      if (!userId && profile.emailVerified) {
        const existing = findUserByEmailAnyCase(col, profile.email);
        if (existing) {
          const matchedUserId = existing.id;
          const mergeToken = crypto.randomUUID();
          await db.insert(authTokens).values({
            id: storedTokenId(mergeToken),
            user_id: matchedUserId,
            collection_id: col.id,
            purpose: "oauth2_merge",
            code: JSON.stringify({
              provider: body.provider,
              provider_user_id: profile.id,
              email: profile.email,
              name: profile.name ?? null,
            }),
            expires_at: now + 15 * 60,
            used_at: null,
            created_at: now,
          });
          return {
            data: {
              merge_required: true,
              merge_token: mergeToken,
              email: profile.email,
              provider: body.provider,
              message:
                "An account with this email already exists. Confirm with your existing password (or a valid user token) at POST /api/v1/auth/:collection/oauth2/merge-confirm to link this provider.",
            },
          };
        }
      }

      // 3. Create new user — fires afterCreate on the auth collection.
      //    An address the provider didn't verify isn't claimed for the new
      //    account: it gets a placeholder (the provider's address stays on the
      //    link). Otherwise the provider could reserve an address for someone
      //    else's future account, or collide with an existing one.
      const accountEmail = profile.emailVerified && !findUserByEmailAnyCase(col, profile.email)
        ? profile.email
        // Random, so nobody can register the placeholder ahead of the owner.
        : `${body.provider}_${newToken().slice(0, 24)}@oauth.invalid`;
      if (!userId) {
        const signupFields: Record<string, unknown> = profile.name ? { email: accountEmail, name: profile.name } : { email: accountEmail };
        if (!(await signupAllowed(request, jwtSecret, col, signupFields))) {
          set.status = 403; return { error: "Forbidden", code: 403 };
        }
        const randomPw = crypto.randomUUID() + crypto.randomUUID();
        const hash = await hashPassword(randomPw);
        userId = crypto.randomUUID();
        await insertUser(col, {
          id: userId,
          email: accountEmail,
          password_hash: hash,
          email_verified: accountEmail === profile.email ? 1 : 0,
          custom: profile.name ? { name: profile.name } : {},
          legacyDataJson: JSON.stringify(profile.name ? { name: profile.name } : {}),
          created_at: now,
          updated_at: now,
        });
        await db.insert(oauthLinks).values({
          id: crypto.randomUUID(),
          user_id: userId,
          collection_id: col.id,
          provider: body.provider,
          provider_user_id: profile.id,
          provider_email: profile.email,
        });
        // afterCreate hook on OAuth-provisioned new user.
        const created = await getRecord(col.name, userId);
        if (created) emitSignup(col, created, "oauth2");
      }

      // A linked account with TOTP on still needs its second factor: the
      // provider vouches for who the user is at the provider, not for this
      // account's MFA.
      const signedIn = findUserById(col, userId);
      if (signedIn?.totp_enabled === 1) return { data: await mfaTicketFor(col.id, userId) };
      const email = signedIn?.email ?? accountEmail;
      const { token } = await signAuthToken({
        payload: { id: userId, email, collection: col.name },
        audience: "user",
        expiresInSeconds: tokenWindowSeconds("user"),
        jwtSecret,
      });
      return { data: { token, record: { id: userId, email } } };
    }, {
      body: t.Object({
        provider: t.String(),
        code: t.String(),
        redirectUri: t.String(),
        // PKCE: client-supplied verifier wins; otherwise we look up by `state`.
        state: t.Optional(t.String()),
        state_secret: t.Optional(t.String()),
        code_verifier: t.Optional(t.String()),
      }),
    })
    // Confirm a pending OAuth2 → existing-user merge. The exchange step
    // returned `{ merge_required: true, merge_token }` because the IdP-verified
    // email matched an existing account; this endpoint takes that token plus
    // proof-of-ownership (the user's password OR a valid user JWT for that
    // account) and performs the link.
    .post("/auth/:collection/oauth2/merge-confirm", async ({ params, body, request, set }) => {
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);

      const tokRows = await findOneTimeToken(body.merge_token);
      const tok = tokRows[0];
      if (!tok || tok.purpose !== "oauth2_merge" || tok.collection_id !== col.id || tok.used_at || tok.expires_at < now) {
        set.status = 401;
        return { error: "Invalid or expired merge token", code: 401 };
      }

      let stored: { provider: string; provider_user_id: string; email: string; name: string | null };
      try {
        stored = JSON.parse(tok.code ?? "");
      } catch {
        set.status = 500;
        return { error: "Corrupted merge token", code: 500 };
      }

      const user = findUserById(col, tok.user_id);
      if (!user) {
        set.status = 401;
        return { error: "Account no longer exists", code: 401 };
      }

      // Proof of ownership — accept either:
      //   1. password (verify against the existing user's hash), OR
      //   2. an Authorization: Bearer <user-jwt> belonging to this user.
      let proven = false;
      let viaSession = false;
      if (typeof body.password === "string" && body.password !== "") {
        // A password guess here is a sign-in attempt: same lockout.
        const lockout = { scope: `user:${col.id}`, email: user.email, subject: user.id, ip: clientIpForLockout(request) };
        const attempt = await reserveLoginAttempt(lockout);
        if (!attempt) {
          set.status = 429; return { error: "Too many failed attempts. Try again later.", code: 429 };
        }
        proven = await Bun.password.verify(body.password, user.password_hash).catch(() => false);
        if (proven) await loginSucceeded(attempt);
      }
      if (!proven) {
        const headerToken = request.headers.get("authorization")?.replace("Bearer ", "");
        if (headerToken) {
          const ctx = await verifyAuthToken(headerToken, jwtSecret, { audience: "user" });
          if (ctx && ctx.id === user.id && ctx.collection === col.name) { proven = true; viaSession = true; }
        }
      }
      if (!proven) {
        set.status = 401;
        return { error: "Password or user token did not match the existing account", code: 401 };
      }
      // Spend the merge token before linking, so two racing confirms can't
      // both get through.
      if (!(await consumeToken(tok.id, now))) {
        set.status = 401;
        return { error: "Invalid or expired merge token", code: 401 };
      }

      // Already linked? If the same provider+provider_user_id row already
      // exists for this user, treat the call as idempotent and just sign a JWT.
      const link: PendingLink = { provider: stored.provider, provider_user_id: stored.provider_user_id, email: stored.email };
      // Proven by password, this is a sign-in: an account with TOTP on gets
      // an MFA ticket, and the link is made only once that second factor is
      // in — the password alone changes nothing. (A caller proving it with a
      // session already passed MFA to get that session.)
      if (!viaSession && user.totp_enabled === 1) {
        return { data: { ...(await mfaTicketFor(col.id, user.id, { link })), linked_provider: stored.provider } };
      }
      await applyProviderLink(col.id, col, user.id, link);

      const { token } = await signAuthToken({
        payload: { id: user.id, email: user.email, collection: col.name },
        audience: "user",
        expiresInSeconds: tokenWindowSeconds("user"),
        jwtSecret,
      });
      return { data: { token, record: { id: user.id, email: user.email }, linked_provider: stored.provider } };
    }, {
      body: t.Object({
        merge_token: t.String(),
        password: t.Optional(t.String()),
      }),
    })
    // Unlink an OAuth2 provider from the calling user's account.
    // Refuses to leave the user without ANY way to sign in: if the user has no
    // password set (or only a placeholder; we can't tell post-hash) AND this
    // would be their last remaining link, returns 409. Detects the "real" case
    // by checking whether at least one OTHER link exists, OR a password_hash
    // is present (any user has one — anonymous + oauth-only users still hold a
    // random one — so the heuristic falls back to "must have ≥1 other sign-in
    // path", i.e. another link OR a verified email + non-anonymous flag).
    .delete("/auth/:collection/oauth2/:provider/unlink", async ({ params, request, set }) => {
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
      const session = await userSession(request, jwtSecret, col.name);
      if (!session) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      const userId = session.id;
      const db = getDb();
      const u = findUserById(col, userId);
      if (!u) { set.status = 404; return { error: "User not found", code: 404 }; }

      const linkRows = await db
        .select()
        .from(oauthLinks)
        .where(and(
          eq(oauthLinks.user_id, userId),
          eq(oauthLinks.provider, params.provider),
        ))
        .limit(1);
      if (linkRows.length === 0) {
        set.status = 404; return { error: "No link for that provider", code: 404 };
      }

      // Lockout guard: a user with no password and no other oauth link would
      // be unable to sign in again. password_hash is NOT NULL at the schema
      // level, but oauth-only users carry an empty/placeholder hash that we
      // treat as "no password". (We can't actually distinguish a placeholder
      // from a hashed password without extra metadata, so callers who want
      // password+oauth must keep the password column non-empty — which the
      // standard register flow does.)
      const allLinks = await db
        .select()
        .from(oauthLinks)
        .where(eq(oauthLinks.user_id, userId));
      const remainingAfter = allLinks.filter((l) => l.provider !== params.provider).length;
      // An account created from a provider with an unverified email has only
      // a placeholder address and a random password nobody knows: it has no
      // other way in, and can't reset one.
      const hasPassword = u.password_hash !== "" && u.is_anonymous !== 1 && !u.email.endsWith("@oauth.invalid");
      if (!hasPassword && remainingAfter === 0) {
        set.status = 409;
        return { error: "Cannot unlink — would leave you locked out", code: 409 };
      }

      await db.delete(oauthLinks).where(and(
        eq(oauthLinks.user_id, userId),
        eq(oauthLinks.provider, params.provider),
      ));
      return { data: null };
    })
    // Token refresh — re-validates that the principal still exists.
    .post("/auth/refresh", async ({ request, set }) => {
      const token = request.headers.get("authorization")?.replace("Bearer ", "");
      if (!token) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      const ctx = await verifyAuthToken(token, jwtSecret);
      if (!ctx) {
        // A token refreshed moments ago (another tab, a retried request)
        // gets the same replacement back instead of a 401 that would sign
        // every tab out.
        const again = await repeatRefresh(token, jwtSecret);
        if (again) return { data: { token: again } };
        set.status = 401; return { error: "Token expired or invalid", code: 401 };
      }
      // API tokens are not sessions: refreshing one would mint an admin JWT
      // free of the token's scopes.
      if ((ctx.type !== "user" && ctx.type !== "admin") || ctx.viaApiToken) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      // Signature already verified above; read the principal claims back so
      // the new token keeps them. Dropping `collection` made every refreshed
      // user token fail verification.
      const prev = jose.decodeJwt(token);
      // Impersonation sessions are time-boxed by design; refreshing would turn
      // one into an ordinary long-lived user token and drop the audit marker.
      if (typeof prev["impersonated_by"] === "string") {
        set.status = 403;
        return { error: "Impersonation tokens cannot be refreshed", code: 403 };
      }
      const claims: jose.JWTPayload = { id: ctx.id };
      if (ctx.email) claims.email = ctx.email;
      if (typeof prev["collection"] === "string") claims["collection"] = prev["collection"];
      // Anonymous by the account, not just the claim: a guest token refreshed
      // while the account is being promoted must not keep its exemption from
      // the session cap.
      let anonymous = prev["anonymous"] === true;
      if (anonymous) {
        const col = ctx.collection ? await getCollection(ctx.collection) : null;
        const u = col ? findUserById(col, ctx.id) : null;
        if (!u || u.is_anonymous !== 1) anonymous = false;
      }
      if (anonymous) claims["anonymous"] = true;
      const now = Math.floor(Date.now() / 1000);
      let ttl = tokenWindowSeconds(anonymous ? "anonymous" : "refresh");
      // Absolute session lifetime. `auth_time` is the original sign-in and is
      // carried through every refresh (tokens minted at sign-in don't carry it,
      // so their `iat` is the sign-in). Refreshing can extend a session up to
      // the cap but never past it. Anonymous sessions are exempt: a guest has
      // no credential to sign in again with, so capping would orphan the
      // account and its data.
      const authTime = typeof prev["auth_time"] === "number" ? prev["auth_time"] : (ctx.iat ?? now);
      claims["auth_time"] = authTime;
      const cap = sessionMaxSeconds();
      if (cap > 0 && !anonymous) {
        const remaining = authTime + cap - now;
        if (remaining < 60) {
          set.status = 401; return { error: "Session expired. Sign in again.", code: 401 };
        }
        ttl = Math.min(ttl, remaining);
      }
      let reissue: { jti: string; iat: number } | undefined;
      if (ctx.jti) {
        // Remember how to re-mint the replacement for REFRESH_REPEAT_SECONDS
        // (claims only, never the token), and do it before revoking the old
        // token: a refresh that runs into the revocation then always finds
        // the row. Written first, the row also decides a race: every refresh
        // of one token mints the same replacement from it, so two tabs can't
        // end up with two sessions. Token verification is synchronous now,
        // so concurrent refreshes no longer wait on each other by accident.
        const rowId = `refresh_rotation:${ctx.jti}`;
        await getDb().insert(authTokens).values({
          id: rowId,
          user_id: ctx.id,
          collection_id: "",
          purpose: "refresh_rotation",
          payload: JSON.stringify({ claims, audience: ctx.type, ttl, jti: crypto.randomUUID(), iat: now }),
          expires_at: now + REFRESH_REPEAT_SECONDS,
        }).onConflictDoNothing();
        // Revoke the token being replaced, so refreshing doesn't leave two
        // live sessions. The insert is conditional: the loser of a race gets
        // the winner's replacement instead of a 401 that signs every tab out.
        const revoked = await getDb().insert(tokenRevocations)
          .values({ jti: ctx.jti, expires_at: ctx.exp ?? now + ttl, revoked_at: now })
          .onConflictDoNothing()
          .returning({ jti: tokenRevocations.jti });
        if (revoked.length === 0) {
          const again = await repeatRefresh(token, jwtSecret);
          if (again) return { data: { token: again } };
          set.status = 401; return { error: "Token expired or invalid", code: 401 };
        }
        const row = (await getDb().select().from(authTokens).where(eq(authTokens.id, rowId)).limit(1))[0];
        if (row?.payload && row.expires_at >= now) {
          const r = JSON.parse(row.payload) as { jti: string; iat: number };
          reissue = { jti: r.jti, iat: r.iat };
        }
      }
      const { token: newToken, jti, exp, iat } = await signAuthToken({
        payload: claims,
        audience: ctx.type,
        expiresInSeconds: ttl,
        jwtSecret,
        ...(reissue ? { reissue } : {}),
      });
      if (ctx.type === "admin") {
        await recordAdminSession({ jti, admin_id: ctx.id, admin_email: ctx.email ?? "", issued_at: iat, expires_at: exp, request });
      }
      return { data: { token: newToken } };
    });
}
