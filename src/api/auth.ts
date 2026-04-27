import { and, eq } from "drizzle-orm";
import Elysia, { t } from "elysia";
import * as jose from "jose";
import { getDb } from "../db/client.ts";
import { admin, authTokens, oauthLinks, users } from "../db/schema.ts";
import { getCollection } from "../core/collections.ts";
import {
  getAppUrl,
  getTemplate,
  isSmtpConfigured,
  renderTemplate,
  sendEmail,
} from "../core/email.ts";
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchProviderProfile,
  isProviderEnabled,
  listEnabledProviders,
  PROVIDERS,
} from "../core/oauth2.ts";
import {
  buildOtpauthUrl,
  generateSecret,
  verifyCode as verifyTotpCode,
} from "../core/totp.ts";
import { isAuthFeatureEnabled } from "../core/auth-features.ts";

function getSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

const TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
const OTP_TTL_SECONDS = 10 * 60;   // 10 minutes
const MFA_TICKET_TTL_SECONDS = 5 * 60; // 5 minutes — enough to type a code

function newToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 6-digit numeric OTP, zero-padded. Avoids leading-zero ambiguity. */
function newOtpCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0]! % 1_000_000).toString().padStart(6, "0");
}

function buildLink(appUrl: string, kind: "verify" | "reset" | "otp", collection: string, token: string): string {
  const base = appUrl.replace(/\/+$/, "");
  const path = kind === "verify" ? "/auth/verify" : kind === "reset" ? "/auth/reset" : "/auth/otp";
  return `${base}${path}?token=${token}&collection=${encodeURIComponent(collection)}`;
}

async function issueAndSend(
  kind: "verify" | "reset",
  user: { id: string; email: string },
  collectionId: string,
  collectionName: string
): Promise<void> {
  const token = newToken();
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  await getDb().insert(authTokens).values({
    id: token,
    user_id: user.id,
    collection_id: collectionId,
    purpose: kind === "verify" ? "email_verify" : "password_reset",
    expires_at: expiresAt,
  });
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
}

/**
 * Issue a single OTP record carrying both a long token (for the magic link)
 * and a 6-digit code (for typing). Either is sufficient to authenticate.
 */
async function issueOtpAndSend(
  user: { id: string; email: string },
  collectionId: string,
  collectionName: string
): Promise<void> {
  const token = newToken();
  const code = newOtpCode();
  const expiresAt = Math.floor(Date.now() / 1000) + OTP_TTL_SECONDS;
  await getDb().insert(authTokens).values({
    id: token,
    user_id: user.id,
    collection_id: collectionId,
    purpose: "otp",
    code,
    expires_at: expiresAt,
  });
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
}

export function makeAuthPlugin(jwtSecret: string) {
  return new Elysia({ name: "auth" })
    .post(
      "/api/admin/setup",
      async ({ body, set }) => {
        const db = getDb();
        const existing = await db.select().from(admin).limit(1);
        if (existing.length > 0) {
          set.status = 400;
          return { error: "Admin already set up", code: 400 };
        }
        const hash = await Bun.password.hash(body.password);
        const id = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
        await db.insert(admin).values({ id, email: body.email, password_hash: hash, created_at: now });
        return { data: { id, email: body.email } };
      },
      { body: t.Object({ email: t.String(), password: t.String() }) }
    )
    .post(
      "/api/admin/auth/login",
      async ({ body, set }) => {
        const db = getDb();
        const rows = await db.select().from(admin).where(eq(admin.email, body.email)).limit(1);
        const a = rows[0];
        if (!a) { set.status = 401; return { error: "Invalid credentials", code: 401 }; }
        const valid = await Bun.password.verify(body.password, a.password_hash);
        if (!valid) { set.status = 401; return { error: "Invalid credentials", code: 401 }; }
        const token = await new jose.SignJWT({ id: a.id, email: a.email })
          .setProtectedHeader({ alg: "HS256" })
          .setAudience("admin")
          .setExpirationTime("7d")
          .sign(getSecret(jwtSecret));
        return { data: { token, admin: { id: a.id, email: a.email } } };
      },
      { body: t.Object({ email: t.String(), password: t.String() }) }
    )
    .get("/api/admin/auth/me", async ({ request, set }) => {
      const token = request.headers.get("authorization")?.replace("Bearer ", "");
      if (!token) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      try {
        const { payload } = await jose.jwtVerify(token, getSecret(jwtSecret), { audience: "admin" });
        return { data: payload };
      } catch {
        set.status = 401;
        return { error: "Unauthorized", code: 401 };
      }
    })
    .post(
      "/api/auth/:collection/register",
      async ({ params, body, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        const db = getDb();
        const existing = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
        if (existing.length > 0) { set.status = 400; return { error: "Email already registered", code: 400 }; }
        const hash = await Bun.password.hash(body.password);
        const id = crypto.randomUUID();
        const now = Math.floor(Date.now() / 1000);
        const { email, password, ...extra } = body;
        await db.insert(users).values({
          id,
          collection_id: col.id,
          email,
          password_hash: hash,
          data: JSON.stringify(extra),
          created_at: now,
          updated_at: now,
        });
        if (isSmtpConfigured()) {
          // Best-effort: don't block registration if SMTP send fails.
          issueAndSend("verify", { id, email }, col.id, col.name).catch((e) => {
            console.error("[auth] verification email failed for", email, "—", e instanceof Error ? e.message : e);
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
      "/api/auth/:collection/login",
      async ({ params, body, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        const db = getDb();
        const rows = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
        const u = rows[0];
        if (!u) { set.status = 401; return { error: "Invalid credentials", code: 401 }; }
        const valid = await Bun.password.verify(body.password, u.password_hash);
        if (!valid) { set.status = 401; return { error: "Invalid credentials", code: 401 }; }

        // MFA enabled? Issue a short-lived ticket; finishing the login requires a TOTP code.
        if (u.totp_enabled === 1) {
          const ticket = newToken();
          const now = Math.floor(Date.now() / 1000);
          await db.insert(authTokens).values({
            id: ticket,
            user_id: u.id,
            collection_id: col.id,
            purpose: "mfa_ticket",
            expires_at: now + MFA_TICKET_TTL_SECONDS,
          });
          return { data: { mfa_required: true, mfa_token: ticket } };
        }

        const token = await new jose.SignJWT({ id: u.id, email: u.email, collection: params.collection })
          .setProtectedHeader({ alg: "HS256" })
          .setAudience("user")
          .setExpirationTime("7d")
          .sign(getSecret(jwtSecret));
        return { data: { token, record: { id: u.id, email: u.email } } };
      },
      { body: t.Object({ email: t.String(), password: t.String() }) }
    )
    // Step-2 of MFA login: trade the mfa_token + a valid TOTP code for a full JWT.
    .post(
      "/api/auth/:collection/login/mfa",
      async ({ params, body, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        const db = getDb();
        const rows = await db.select().from(authTokens).where(eq(authTokens.id, body.mfa_token)).limit(1);
        const tok = rows[0];
        const now = Math.floor(Date.now() / 1000);
        if (!tok || tok.purpose !== "mfa_ticket" || tok.collection_id !== col.id || tok.used_at || tok.expires_at < now) {
          set.status = 400;
          return { error: "Invalid or expired MFA ticket", code: 400 };
        }
        const userRows = await db.select().from(users).where(eq(users.id, tok.user_id)).limit(1);
        const u = userRows[0];
        if (!u || !u.totp_secret) {
          set.status = 400;
          return { error: "MFA not configured for this account", code: 400 };
        }
        if (!verifyTotpCode(u.totp_secret, body.code)) {
          set.status = 401;
          return { error: "Invalid code", code: 401 };
        }
        await db.update(authTokens).set({ used_at: now }).where(eq(authTokens.id, tok.id));
        const token = await new jose.SignJWT({ id: u.id, email: u.email, collection: col.name })
          .setProtectedHeader({ alg: "HS256" })
          .setAudience("user")
          .setExpirationTime("7d")
          .sign(getSecret(jwtSecret));
        return { data: { token, record: { id: u.id, email: u.email } } };
      },
      { body: t.Object({ mfa_token: t.String(), code: t.String() }) }
    )
    .get("/api/auth/me", async ({ request, set }) => {
      const token = request.headers.get("authorization")?.replace("Bearer ", "");
      if (!token) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      try {
        const { payload } = await jose.jwtVerify(token, getSecret(jwtSecret), { audience: "user" });
        return { data: payload };
      } catch {
        set.status = 401;
        return { error: "Unauthorized", code: 401 };
      }
    })
    // ── Email verification ──────────────────────────────────────────────────
    // Authenticated user requests a fresh verification email for their address.
    .post("/api/auth/:collection/request-verify", async ({ params, request, set }) => {
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
      const token = request.headers.get("authorization")?.replace("Bearer ", "");
      if (!token) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      let userId: string;
      try {
        const { payload } = await jose.jwtVerify(token, getSecret(jwtSecret), { audience: "user" });
        userId = String(payload.id ?? "");
        if (!userId) throw new Error("missing id");
      } catch {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      const db = getDb();
      const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      const u = rows[0];
      if (!u || u.collection_id !== col.id) { set.status = 404; return { error: "User not found", code: 404 }; }
      if (u.email_verified) return { data: { sent: false, alreadyVerified: true } };
      if (!isSmtpConfigured()) { set.status = 422; return { error: "SMTP not configured", code: 422 }; }
      try {
        await issueAndSend("verify", { id: u.id, email: u.email }, col.id, col.name);
        return { data: { sent: true } };
      } catch (e) {
        set.status = 500;
        return { error: e instanceof Error ? e.message : String(e), code: 500 };
      }
    })
    // Anyone with a valid token can confirm their email.
    .post(
      "/api/auth/:collection/verify-email",
      async ({ params, body, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        const db = getDb();
        const rows = await db.select().from(authTokens).where(eq(authTokens.id, body.token)).limit(1);
        const tok = rows[0];
        const now = Math.floor(Date.now() / 1000);
        if (!tok || tok.purpose !== "email_verify" || tok.collection_id !== col.id || tok.used_at || tok.expires_at < now) {
          set.status = 400; return { error: "Invalid or expired token", code: 400 };
        }
        await db.update(users).set({ email_verified: 1, updated_at: now }).where(eq(users.id, tok.user_id));
        await db.update(authTokens).set({ used_at: now }).where(eq(authTokens.id, tok.id));
        return { data: { verified: true } };
      },
      { body: t.Object({ token: t.String() }) }
    )
    // ── Password reset ──────────────────────────────────────────────────────
    // Always returns 200 to avoid leaking which emails are registered.
    .post(
      "/api/auth/:collection/request-password-reset",
      async ({ params, body, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        if (!isSmtpConfigured()) { set.status = 422; return { error: "SMTP not configured", code: 422 }; }
        const db = getDb();
        const rows = await db
          .select()
          .from(users)
          .where(and(eq(users.email, body.email), eq(users.collection_id, col.id)))
          .limit(1);
        const u = rows[0];
        if (u) {
          try {
            await issueAndSend("reset", { id: u.id, email: u.email }, col.id, col.name);
          } catch (e) {
            console.error("[auth] password reset email failed:", e instanceof Error ? e.message : e);
          }
        }
        return { data: { sent: true } };
      },
      { body: t.Object({ email: t.String() }) }
    )
    .post(
      "/api/auth/:collection/confirm-password-reset",
      async ({ params, body, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        if (typeof body.password !== "string" || body.password.length < 8) {
          set.status = 422; return { error: "Password must be at least 8 characters", code: 422 };
        }
        const db = getDb();
        const rows = await db.select().from(authTokens).where(eq(authTokens.id, body.token)).limit(1);
        const tok = rows[0];
        const now = Math.floor(Date.now() / 1000);
        if (!tok || tok.purpose !== "password_reset" || tok.collection_id !== col.id || tok.used_at || tok.expires_at < now) {
          set.status = 400; return { error: "Invalid or expired token", code: 400 };
        }
        const hash = await Bun.password.hash(body.password);
        await db.update(users).set({ password_hash: hash, updated_at: now }).where(eq(users.id, tok.user_id));
        await db.update(authTokens).set({ used_at: now }).where(eq(authTokens.id, tok.id));
        return { data: { reset: true } };
      },
      { body: t.Object({ token: t.String(), password: t.String() }) }
    )
    // ── OTP / magic link ────────────────────────────────────────────────────
    // Always returns 200 (no enumeration). Issues both a long token (link) and
    // a 6-digit code; either can be used to authenticate.
    .post(
      "/api/auth/:collection/otp/request",
      async ({ params, body, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        if (!isAuthFeatureEnabled("otp")) { set.status = 422; return { error: "OTP login is disabled", code: 422 }; }
        if (!isSmtpConfigured()) { set.status = 422; return { error: "SMTP not configured", code: 422 }; }
        const db = getDb();
        const rows = await db
          .select()
          .from(users)
          .where(and(eq(users.email, body.email), eq(users.collection_id, col.id)))
          .limit(1);
        const u = rows[0];
        if (u && u.is_anonymous !== 1) {
          try {
            await issueOtpAndSend({ id: u.id, email: u.email }, col.id, col.name);
          } catch (e) {
            console.error("[auth] otp email failed:", e instanceof Error ? e.message : e);
          }
        }
        return { data: { sent: true } };
      },
      { body: t.Object({ email: t.String() }) }
    )
    // Auth via OTP — accepts either the long token OR the short code.
    .post(
      "/api/auth/:collection/otp/auth",
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
          const rows = await db.select().from(authTokens).where(eq(authTokens.id, body.token)).limit(1);
          tok = rows[0];
        } else {
          // Code lookups need the email too — codes alone are 6 digits and
          // cross-user collisions during the 10-minute window are realistic.
          if (!body.email) { set.status = 422; return { error: "code requires email", code: 422 }; }
          const userRows = await db
            .select()
            .from(users)
            .where(and(eq(users.email, body.email), eq(users.collection_id, col.id)))
            .limit(1);
          if (userRows.length === 0) { set.status = 400; return { error: "Invalid or expired code", code: 400 }; }
          const tokenRows = await db
            .select()
            .from(authTokens)
            .where(and(
              eq(authTokens.user_id, userRows[0]!.id),
              eq(authTokens.purpose, "otp"),
              eq(authTokens.code, body.code!)
            ))
            .limit(1);
          tok = tokenRows[0];
        }
        if (!tok || tok.purpose !== "otp" || tok.collection_id !== col.id || tok.used_at || tok.expires_at < now) {
          set.status = 400; return { error: "Invalid or expired code", code: 400 };
        }
        const userRows = await db.select().from(users).where(eq(users.id, tok.user_id)).limit(1);
        const u = userRows[0];
        if (!u) { set.status = 400; return { error: "User not found", code: 400 }; }

        await db.update(authTokens).set({ used_at: now }).where(eq(authTokens.id, tok.id));
        // OTP-issued sessions imply the email is verified (the IdP — us — confirmed it).
        if (!u.email_verified) {
          await db.update(users).set({ email_verified: 1, updated_at: now }).where(eq(users.id, u.id));
        }
        // OTP MFA gate would defeat the purpose of magic-link sign-in (no password).
        // We still respect TOTP if the user enabled it: issue an mfa ticket instead.
        if (u.totp_enabled === 1) {
          const ticket = newToken();
          await db.insert(authTokens).values({
            id: ticket,
            user_id: u.id,
            collection_id: col.id,
            purpose: "mfa_ticket",
            expires_at: now + MFA_TICKET_TTL_SECONDS,
          });
          return { data: { mfa_required: true, mfa_token: ticket } };
        }
        const jwt = await new jose.SignJWT({ id: u.id, email: u.email, collection: col.name })
          .setProtectedHeader({ alg: "HS256" })
          .setAudience("user")
          .setExpirationTime("7d")
          .sign(getSecret(jwtSecret));
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
    .post("/api/auth/:collection/totp/setup", async ({ params, request, set }) => {
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
      if (!isAuthFeatureEnabled("mfa")) { set.status = 422; return { error: "MFA is disabled", code: 422 }; }
      const token = request.headers.get("authorization")?.replace("Bearer ", "");
      if (!token) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      let userId: string;
      try {
        const { payload } = await jose.jwtVerify(token, getSecret(jwtSecret), { audience: "user" });
        userId = String(payload.id ?? "");
        if (!userId) throw new Error("missing id");
      } catch {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      const db = getDb();
      const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      const u = rows[0];
      if (!u || u.collection_id !== col.id) { set.status = 404; return { error: "User not found", code: 404 }; }
      const secret = generateSecret();
      // Stash the pending secret on the user; gets activated on /confirm.
      await db.update(users).set({ totp_secret: secret, updated_at: Math.floor(Date.now() / 1000) }).where(eq(users.id, u.id));
      const otpauthUrl = buildOtpauthUrl({
        secret,
        accountName: u.email,
        issuer: getAppUrl() || "Vaultbase",
      });
      return { data: { secret, otpauth_url: otpauthUrl } };
    })
    // Step 2: confirm by submitting a code from the authenticator app — flips totp_enabled.
    .post(
      "/api/auth/:collection/totp/confirm",
      async ({ params, request, body, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        if (!isAuthFeatureEnabled("mfa")) { set.status = 422; return { error: "MFA is disabled", code: 422 }; }
        const token = request.headers.get("authorization")?.replace("Bearer ", "");
        if (!token) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
        let userId: string;
        try {
          const { payload } = await jose.jwtVerify(token, getSecret(jwtSecret), { audience: "user" });
          userId = String(payload.id ?? "");
          if (!userId) throw new Error("missing id");
        } catch {
          set.status = 401; return { error: "Unauthorized", code: 401 };
        }
        const db = getDb();
        const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        const u = rows[0];
        if (!u || u.collection_id !== col.id) { set.status = 404; return { error: "User not found", code: 404 }; }
        if (!u.totp_secret) { set.status = 400; return { error: "Run /totp/setup first", code: 400 }; }
        if (!verifyTotpCode(u.totp_secret, body.code)) {
          set.status = 401; return { error: "Invalid code", code: 401 };
        }
        await db.update(users).set({ totp_enabled: 1, updated_at: Math.floor(Date.now() / 1000) }).where(eq(users.id, u.id));
        return { data: { enabled: true } };
      },
      { body: t.Object({ code: t.String() }) }
    )
    // Disable MFA. Requires the current code to prevent hijacked sessions from disabling it.
    .post(
      "/api/auth/:collection/totp/disable",
      async ({ params, request, body, set }) => {
        const col = await getCollection(params.collection);
        if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
        if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
        const token = request.headers.get("authorization")?.replace("Bearer ", "");
        if (!token) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
        let userId: string;
        try {
          const { payload } = await jose.jwtVerify(token, getSecret(jwtSecret), { audience: "user" });
          userId = String(payload.id ?? "");
          if (!userId) throw new Error("missing id");
        } catch {
          set.status = 401; return { error: "Unauthorized", code: 401 };
        }
        const db = getDb();
        const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
        const u = rows[0];
        if (!u || u.collection_id !== col.id) { set.status = 404; return { error: "User not found", code: 404 }; }
        if (!u.totp_secret) { set.status = 400; return { error: "MFA not configured", code: 400 }; }
        if (!verifyTotpCode(u.totp_secret, body.code)) {
          set.status = 401; return { error: "Invalid code", code: 401 };
        }
        await db.update(users).set({ totp_enabled: 0, totp_secret: null, updated_at: Math.floor(Date.now() / 1000) }).where(eq(users.id, u.id));
        return { data: { enabled: false } };
      },
      { body: t.Object({ code: t.String() }) }
    )
    // ── Anonymous ──────────────────────────────────────────────────────────
    // Mints a guest user with a synthetic email. The returned JWT is a regular
    // user token — caller can later "promote" by setting email + password via PATCH.
    .post("/api/auth/:collection/anonymous", async ({ params, set }) => {
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
      if (!isAuthFeatureEnabled("anonymous")) { set.status = 422; return { error: "Anonymous auth is disabled", code: 422 }; }
      const id = crypto.randomUUID();
      const email = `anon_${id.replace(/-/g, "").slice(0, 16)}@anonymous.invalid`;
      const randomPw = crypto.randomUUID() + crypto.randomUUID();
      const hash = await Bun.password.hash(randomPw);
      const now = Math.floor(Date.now() / 1000);
      await getDb().insert(users).values({
        id,
        collection_id: col.id,
        email,
        password_hash: hash,
        is_anonymous: 1,
        data: "{}",
        created_at: now,
        updated_at: now,
      });
      const jwt = await new jose.SignJWT({ id, email, collection: col.name, anonymous: true })
        .setProtectedHeader({ alg: "HS256" })
        .setAudience("user")
        .setExpirationTime("30d") // anonymous sessions live longer for guest carts etc
        .sign(getSecret(jwtSecret));
      return { data: { token: jwt, record: { id, email, anonymous: true } } };
    })
    // ── Admin impersonation ────────────────────────────────────────────────
    // Admin mints a short-lived user JWT for support purposes. JWT carries
    // `impersonated_by` so audit logs can attribute actions to the admin.
    .post("/api/admin/impersonate/:collection/:userId", async ({ params, request, set }) => {
      const adminToken = request.headers.get("authorization")?.replace("Bearer ", "");
      if (!adminToken) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      let adminId: string;
      try {
        const { payload } = await jose.jwtVerify(adminToken, getSecret(jwtSecret), { audience: "admin" });
        adminId = String(payload.id ?? "");
      } catch {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      if (!isAuthFeatureEnabled("impersonation")) { set.status = 422; return { error: "Impersonation is disabled", code: 422 }; }
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
      const db = getDb();
      const rows = await db
        .select()
        .from(users)
        .where(and(eq(users.id, params.userId), eq(users.collection_id, col.id)))
        .limit(1);
      const u = rows[0];
      if (!u) { set.status = 404; return { error: "User not found", code: 404 }; }
      const jwt = await new jose.SignJWT({
          id: u.id,
          email: u.email,
          collection: col.name,
          impersonated_by: adminId,
        })
        .setProtectedHeader({ alg: "HS256" })
        .setAudience("user")
        .setExpirationTime("1h") // short by design
        .sign(getSecret(jwtSecret));
      return { data: { token: jwt, record: { id: u.id, email: u.email }, impersonated_by: adminId } };
    })
    // ── OAuth2 ──────────────────────────────────────────────────────────────
    // List enabled providers for this collection (gated by collection.type='auth').
    .get("/api/auth/:collection/oauth2/providers", async ({ params, set }) => {
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
      return { data: listEnabledProviders() };
    })
    // Returns the provider's authorize URL with the caller-supplied redirect/state.
    .get("/api/auth/:collection/oauth2/authorize", async ({ params, query, set }) => {
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
      if (!query.provider || !query.redirectUri) {
        set.status = 422; return { error: "provider and redirectUri are required", code: 422 };
      }
      if (!isProviderEnabled(query.provider)) {
        set.status = 422; return { error: `Provider '${query.provider}' is not enabled`, code: 422 };
      }
      try {
        const url = buildAuthorizeUrl({
          provider: query.provider,
          redirectUri: query.redirectUri,
          state: query.state ?? "",
        });
        return { data: { authorize_url: url } };
      } catch (e) {
        set.status = 422;
        return { error: e instanceof Error ? e.message : String(e), code: 422 };
      }
    }, {
      query: t.Object({
        provider: t.String(),
        redirectUri: t.String(),
        state: t.Optional(t.String()),
      }),
    })
    // Exchange authorization code for a vaultbase JWT.
    // Linking strategy:
    //  1. Existing oauth_link row for (provider, provider_user_id) → log in linked user
    //  2. Otherwise, if profile.emailVerified and email matches an existing user in
    //     this collection → create link, log in
    //  3. Otherwise, create a fresh user (random unguessable password) + link
    .post("/api/auth/:collection/oauth2/exchange", async ({ params, body, set }) => {
      const col = await getCollection(params.collection);
      if (!col) { set.status = 404; return { error: "Collection not found", code: 404 }; }
      if (col.type !== "auth") { set.status = 422; return { error: `'${col.name}' is not an auth collection`, code: 422 }; }
      if (!PROVIDERS[body.provider]) {
        set.status = 422; return { error: `Unknown provider '${body.provider}'`, code: 422 };
      }
      if (!isProviderEnabled(body.provider)) {
        set.status = 422; return { error: `Provider '${body.provider}' is not enabled`, code: 422 };
      }

      let profile;
      try {
        const tok = await exchangeCodeForToken({
          provider: body.provider,
          code: body.code,
          redirectUri: body.redirectUri,
        });
        profile = await fetchProviderProfile(body.provider, tok.access_token);
      } catch (e) {
        set.status = 400;
        return { error: e instanceof Error ? e.message : String(e), code: 400 };
      }
      if (!profile.id || !profile.email) {
        set.status = 400;
        return { error: "Provider returned an incomplete profile (missing id or email)", code: 400 };
      }

      const db = getDb();
      const now = Math.floor(Date.now() / 1000);

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

      // 2. Email-match (only if provider verified the email)
      if (!userId && profile.emailVerified) {
        const existing = await db
          .select()
          .from(users)
          .where(and(eq(users.email, profile.email), eq(users.collection_id, col.id)))
          .limit(1);
        if (existing.length > 0) {
          userId = existing[0]!.id;
          await db.insert(oauthLinks).values({
            id: crypto.randomUUID(),
            user_id: userId,
            collection_id: col.id,
            provider: body.provider,
            provider_user_id: profile.id,
            provider_email: profile.email,
          });
          // Mark verified since we trust the IdP's verification.
          if (!existing[0]!.email_verified) {
            await db.update(users).set({ email_verified: 1, updated_at: now }).where(eq(users.id, userId));
          }
        }
      }

      // 3. Create new user
      if (!userId) {
        // Random hash that no one can guess — user can use password reset to set one if they want password login too.
        const randomPw = crypto.randomUUID() + crypto.randomUUID();
        const hash = await Bun.password.hash(randomPw);
        userId = crypto.randomUUID();
        await db.insert(users).values({
          id: userId,
          collection_id: col.id,
          email: profile.email,
          password_hash: hash,
          email_verified: profile.emailVerified ? 1 : 0,
          data: JSON.stringify(profile.name ? { name: profile.name } : {}),
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
      }

      const token = await new jose.SignJWT({ id: userId, email: profile.email, collection: col.name })
        .setProtectedHeader({ alg: "HS256" })
        .setAudience("user")
        .setExpirationTime("7d")
        .sign(getSecret(jwtSecret));
      return { data: { token, record: { id: userId, email: profile.email } } };
    }, {
      body: t.Object({
        provider: t.String(),
        code: t.String(),
        redirectUri: t.String(),
      }),
    })
    // Token refresh — works for both user and admin tokens
    .post("/api/auth/refresh", async ({ request, set }) => {
      const token = request.headers.get("authorization")?.replace("Bearer ", "");
      if (!token) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      const sec = getSecret(jwtSecret);
      try {
        const { payload } = await jose.jwtVerify(token, sec);
        const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
        if (aud !== "user" && aud !== "admin") { set.status = 401; return { error: "Unauthorized", code: 401 }; }
        // Re-sign with same claims, fresh expiry
        const { exp: _exp, iat: _iat, nbf: _nbf, ...claims } = payload;
        const newToken = await new jose.SignJWT(claims as jose.JWTPayload)
          .setProtectedHeader({ alg: "HS256" })
          .setAudience(aud)
          .setExpirationTime("7d")
          .sign(sec);
        return { data: { token: newToken } };
      } catch {
        set.status = 401;
        return { error: "Token expired or invalid", code: 401 };
      }
    });
}
