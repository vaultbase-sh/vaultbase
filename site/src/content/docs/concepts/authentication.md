---
title: Authentication
description: Email/password, OAuth2, OTP / magic link, MFA / TOTP, anonymous, and admin impersonation — what's available and how it fits together.
---

Vaultbase ships seven auth flows. All of them issue user JWTs (audience
`"user"`) signed with `VAULTBASE_JWT_SECRET`. Endpoints live under
`/api/auth/<collection>/...` and require the collection to have
`type: "auth"`.

## Feature flags

Every flow except plain email/password is gated by a settings flag — toggle
them on **Settings → Auth features** in the admin. Defaults are conservative:

| Feature | Default | Rationale |
|---|---|---|
| OTP / magic link | off | broadens attack surface; opt-in |
| MFA / TOTP | on | no harm if unused |
| Anonymous sign-in | off | guests should be explicit |
| Admin impersonation | on | admin-only by definition |

A disabled feature returns `422` with a clear message.

## Email + password

```http
POST /api/auth/<col>/register
{ "email": "alice@x.com", "password": "secret123" }

POST /api/auth/<col>/login
{ "email": "alice@x.com", "password": "secret123" }
```

`/login` returns either:

```json
{ "data": { "token": "...", "record": { "id": "...", "email": "..." } } }
```

or, when MFA is enabled on this account:

```json
{ "data": { "mfa_required": true, "mfa_token": "..." } }
```

Finish by `POST /api/auth/<col>/login/mfa` with `{ mfa_token, code }`.

## Email verification & password reset

Both reuse the SMTP setup (Settings → SMTP). On registration, if SMTP is
configured, a verification email is sent best-effort.

```http
POST /api/auth/<col>/request-verify        (auth required)
POST /api/auth/<col>/verify-email          { token }

POST /api/auth/<col>/request-password-reset  { email }   ← always 200
POST /api/auth/<col>/confirm-password-reset  { token, password }
```

Templates are editable at **Settings → Email templates**. Variables:
`{{email}}`, `{{token}}`, `{{link}}`, `{{appUrl}}`, `{{collection}}`.

## OAuth2 (13 providers)

Built-in: Google, GitHub, GitLab, Facebook, Microsoft, Discord, Twitch,
Spotify, LinkedIn, Slack, Bitbucket, Notion, Patreon.

Configure each at **Settings → OAuth2** with a client ID + secret. The flow
is caller-driven (your app handles the popup + state):

```http
GET  /api/auth/<col>/oauth2/providers
GET  /api/auth/<col>/oauth2/authorize?provider=google&redirectUri=...&state=...
POST /api/auth/<col>/oauth2/exchange  { provider, code, redirectUri }
```

Account-link strategy on `exchange`:

1. Existing `oauth_links` row for `(provider, provider_user_id)` → log in
   linked user.
2. If profile says `emailVerified` and email matches an existing user in this
   collection → create link, log in.
3. Else create a fresh user (random unguessable hash) + link.

The email-verified gate prevents takeover via unverified emails at the IdP.

## OTP / magic link

A single record carries both a 32-byte URL token and a 6-digit code; either
can authenticate.

```http
POST /api/auth/<col>/otp/request   { email }                    ← always 200
POST /api/auth/<col>/otp/auth      { token } | { email, code }
```

Emails use the `otp` template (Settings → Email templates). 10-minute expiry.
SMTP must be configured.

## MFA / TOTP

RFC 6238 (HMAC-SHA1, 30-second step, 6-digit codes) with ±1 step drift
tolerance.

```http
POST /api/auth/<col>/totp/setup     (auth)  → { secret, otpauth_url }
POST /api/auth/<col>/totp/confirm   { code }
POST /api/auth/<col>/totp/disable   { code }
```

Once `totp_enabled = 1`, `/login` returns `{ mfa_required, mfa_token }`
instead of a full token, and finishing requires `POST .../login/mfa`.

Render the `otpauth_url` as a QR code in your app — any authenticator
(Google Authenticator, 1Password, Authy, Bitwarden) can scan it.

## Anonymous sessions

Mints a guest user with a synthetic email (`anon_<id>@anonymous.invalid`),
unguessable hash, and a 30-day JWT carrying `anonymous: true`. Useful for
guest carts, onboarding flows, or rate-limited public APIs.

```http
POST /api/auth/<col>/anonymous
```

## Admin impersonation

Admin mints a 1-hour user JWT for any user — for support purposes. The JWT
carries `impersonated_by: <admin_id>` for audit.

```http
POST /api/admin/impersonate/<col>/<userId>     (admin auth required)
```

Admin UI exposes this as an **Impersonate** button in the auth-user drawer
that copies the token to clipboard.

## Token shape

User tokens are signed JWTs:

```ts
{
  iat: 1730000000,
  exp: 1730604800,            // +7d (30d for anonymous, 1h for impersonation)
  aud: "user",                // "admin" for admin tokens
  id: "<user_id>",
  email: "alice@x.com",
  collection: "users",
  // optional:
  anonymous?: true,
  impersonated_by?: "<admin_id>"
}
```

Pass on every request as `Authorization: Bearer <jwt>`. Refresh via
`POST /api/auth/refresh` (works for user + admin tokens).
