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

## OAuth2 providers

Built-in: Google, GitHub, GitLab, Facebook, Microsoft, Discord, Twitch,
Spotify, LinkedIn, Slack, Bitbucket, Notion, Patreon, Apple, Twitter / X,
plus a generic OIDC connector (Auth0, Keycloak, Okta, anything OIDC).

Configure each at **Settings → OAuth2**. The flow is caller-driven (your
app handles the popup + state):

```http
GET    /api/auth/<col>/oauth2/providers
GET    /api/auth/<col>/oauth2/authorize?provider=google&redirectUri=...&state=...
POST   /api/auth/<col>/oauth2/exchange  { provider, code, redirectUri }
DELETE /api/auth/<col>/oauth2/<provider>/unlink                ← user JWT
```

Account-link strategy on `exchange`:

1. Existing `oauth_links` row for `(provider, provider_user_id)` → log in
   linked user.
2. If profile says `emailVerified` and email matches an existing user in this
   collection → create link, log in.
3. Else create a fresh user (random unguessable hash) + link.

The email-verified gate prevents takeover via unverified emails at the IdP.

PKCE is supported in two modes (server-managed via `?use_pkce=1`, or
client-managed by passing your own `code_challenge` + `code_verifier`).
Twitter / X auto-engages PKCE — no opt-in required there.

**Unlink** is user-bound — only removes the caller's own link. If the user
has no password and no other OAuth links, unlinking is rejected with `409`
to avoid lockout.

See [OAuth2 API](/api/oauth2/) for PKCE flows, the unlink endpoint, and
provider-specific setup (Apple, X, generic OIDC).

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

### Recovery codes

When TOTP is enrolled, Vaultbase issues **10 single-use 8-character recovery
codes**. They're bcrypt-hashed in `vaultbase_mfa_recovery_codes`; only the
plaintext returned at generation time can authenticate.

```http
POST /api/auth/<col>/totp/recovery/regenerate    ← user JWT
   → { "data": { "codes": ["a1b2c3d4", "e5f6g7h8", ...] } }   // 10 codes, plaintext, ONCE

GET  /api/auth/<col>/totp/recovery/status        ← user JWT
   → { "data": { "total": 10, "remaining": 7 } }
```

`POST .../login/mfa` accepts either `code` (current TOTP) **or**
`recovery_code` — the latter is consumed (single-use) and decrements the
remaining count.

```http
POST /api/auth/<col>/login/mfa
{ "mfa_token": "...", "recovery_code": "a1b2c3d4" }
```

`POST /totp/disable` wipes all stored recovery codes alongside the secret —
re-enrolling generates a fresh batch.

:::tip
Save these somewhere safe — we only show them once. Regenerating invalidates
the previous batch.
:::

## Anonymous sessions

Mints a guest user with a synthetic email (`anon_<id>@anonymous.invalid`),
unguessable hash, and a configurable-window JWT carrying `anonymous: true`.
Useful for guest carts, onboarding flows, or rate-limited public APIs.

```http
POST /api/auth/<col>/anonymous
```

The window defaults to **30 days**. Tune it from **Settings → Auth features
→ Session lifetimes**, or via the settings key:

```bash
# Cut anonymous sessions to 24 hours
curl -X PATCH /api/admin/settings \
  -H "Authorization: Bearer $ADMIN" \
  -d '{"auth.anonymous.window_seconds": "86400"}'
```

Bounds: minimum 60 seconds, maximum 365 days. Invalid values fall back to
the default. Changing the window only affects **newly issued** tokens —
existing ones keep their original expiry.

### Promote an anonymous user to a real account

When a guest decides to sign up, `POST /promote` upgrades the existing record
in place — preserving its id, related records, and any data already keyed
to it. Sets `email` + `password`, clears `is_anonymous`, and returns a
fresh non-anonymous JWT.

```http
POST /api/auth/<col>/promote     ← anonymous user JWT
{ "email": "alice@x.com", "password": "secret123" }
   → { "data": { "token": "<jwt>", "record": { "id": "...", "email": "alice@x.com", "anonymous": false } } }
```

| Code | Cause |
|---|---|
| `401` | Missing JWT |
| `403` | Caller is not anonymous (already a real account) |
| `409` | Email is already taken in this collection |
| `422` | Validation failed (invalid email, weak password) |

```bash
curl -X POST \
  -H "Authorization: Bearer $ANON_JWT" \
  -H "Content-Type: application/json" \
  -d '{"email":"alice@x.com","password":"secret123"}' \
  https://api.example.com/api/auth/users/promote
```

## Register validation

`/register` doesn't just check email + password — it runs the full
`validateRecord` pipeline against the auth collection's implicit fields
plus any user-defined fields. So `min`/`max`/`pattern` constraints on
custom fields (or even on email) are enforced consistently with `/records`.

For example, if `users.email` carries `min: 5, max: 64`, both
`/register` and `PATCH /api/records/users/:id` reject `a@b.c`:

```bash
curl -X POST -H "Content-Type: application/json" \
  -d '{"email":"a@b.c","password":"secret123"}' \
  https://api.example.com/api/auth/users/register
# 422 { "error": "validation failed", "details": { "email": "must be at least 5 characters" } }
```

Extra body keys land in the record's `data` blob, validated against
whatever schema you've defined.

## Admin impersonation

Admin mints a 1-hour user JWT for any user — for support purposes:

```http
POST /api/admin/impersonate/<col>/<userId>     (admin auth required)
   → { "data": { "token": "<jwt>", "impersonated_by": "<admin_id>" } }
```

The minted user JWT carries `impersonated_by: <admin_id>` for audit. Every
request made with this token is tagged with `auth_impersonated_by` in the
log entry, so you can later reconstruct who was acting on the user's behalf
(see [Logging](/concepts/logging/#impersonation-audit)).

Admin UI exposes this as an **Impersonate** button in the auth-user drawer
that copies the token to clipboard.

## Token shape

User tokens are signed JWTs:

```ts
{
  iat: 1730000000,
  exp: 1730604800,            // configurable per kind — see Session lifetimes
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

## Session lifetimes

Every JWT kind has its own configurable expiry window, settable from
**Settings → Auth features → Session lifetimes** or directly via settings
keys:

| Kind          | Setting key                           | Default |
| ------------- | ------------------------------------- | ------- |
| `user`        | `auth.user.window_seconds`            | 7d      |
| `admin`       | `auth.admin.window_seconds`           | 7d      |
| `anonymous`   | `auth.anonymous.window_seconds`       | 30d     |
| `impersonate` | `auth.impersonate.window_seconds`     | 1h      |
| `refresh`     | `auth.refresh.window_seconds`         | 7d      |
| `file`        | `auth.file.window_seconds`            | 1h      |

**Bounds:** 60 seconds minimum, 365 days maximum. Malformed or out-of-range
values fall back to the per-kind default — auth never breaks because of a
bad setting.

**Refresh ratchet:** `POST /api/auth/refresh` re-mints with the *current*
configured window, so a session "ratchets forward" each refresh.

**Existing sessions are unaffected** when you change a window — new mints
only. To revoke active sessions immediately, rotate
`<dataDir>/.secret` and restart (logs everyone out at once).
