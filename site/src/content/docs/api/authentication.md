---
title: Authentication API
description: Every endpoint under /api/auth/<collection>/... and the admin auth flow.
---

All endpoints below operate on a collection of `type: "auth"`. Calls against
non-auth collections return `422`.

For the conceptual overview see [Authentication](/concepts/authentication/).

## Admin auth

```http
POST /api/admin/setup
{ "email": "...", "password": "..." }
```

One-time setup — creates the first admin. After that, returns `400`.

```http
POST /api/admin/auth/login
{ "email": "...", "password": "..." }
→ { "data": { "token": "<jwt>", "admin": { "id": "...", "email": "..." } } }

GET  /api/admin/auth/me
→ { "data": <jwt payload> }
```

## User register / login

```http
POST /api/auth/<col>/register
{ "email": "...", "password": "...", ...extra fields go to `data` blob }

POST /api/auth/<col>/login
{ "email": "...", "password": "..." }
```

`/login` returns one of:

```json
{ "data": { "token": "<jwt>", "record": { "id": "...", "email": "..." } } }

{ "data": { "mfa_required": true, "mfa_token": "..." } }
```

```http
POST /api/auth/<col>/login/mfa
{ "mfa_token": "...", "code": "<6 digits>" }
```

```http
GET  /api/auth/me                  ← user JWT
POST /api/auth/refresh             ← user OR admin JWT, re-issues 7d token
```

## Email verification

```http
POST /api/auth/<col>/request-verify          ← auth required, no body
POST /api/auth/<col>/verify-email            { "token": "..." }
```

Verification emails are sent via the `verify` template (Settings → Email
templates). The `token` is the long random hex from the email link.

## Password reset

```http
POST /api/auth/<col>/request-password-reset  { "email": "..." }
   → always 200 (no enumeration), even if email isn't registered
POST /api/auth/<col>/confirm-password-reset  { "token": "...", "password": "..." }
```

`password` must be ≥ 8 characters. `reset` template, 1-hour token TTL.

## OTP / magic link

Gated by **Settings → Auth features → OTP / magic link**.

```http
POST /api/auth/<col>/otp/request   { "email": "..." }     ← always 200
POST /api/auth/<col>/otp/auth      { "token": "..." }
POST /api/auth/<col>/otp/auth      { "email": "...", "code": "<6 digits>" }
```

Either `token` (from the link) or `code` (from the email) authenticates.
10-minute expiry. SMTP must be configured.

## TOTP

Gated by **Settings → Auth features → MFA / TOTP**.

```http
POST /api/auth/<col>/totp/setup            ← user JWT
   → { "data": { "secret": "<base32>", "otpauth_url": "otpauth://..." } }

POST /api/auth/<col>/totp/confirm          { "code": "<6 digits>" }
   → enables MFA on this user

POST /api/auth/<col>/totp/disable          { "code": "<6 digits>" }
   → clears MFA on this user
```

`disable` is intentionally **not** gated by the feature flag — once a user has
MFA enabled, disabling it shouldn't break when an admin turns the feature off
globally. Same for `/login/mfa`.

## OAuth2

```http
GET /api/auth/<col>/oauth2/providers
   → { "data": [ { "name": "google", "displayName": "Google" }, ... ] }

GET /api/auth/<col>/oauth2/authorize
     ?provider=google&redirectUri=https://app.example.com/callback&state=<csrf>
   → { "data": { "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth?..." } }

POST /api/auth/<col>/oauth2/exchange
{ "provider": "google", "code": "...", "redirectUri": "..." }
   → { "data": { "token": "<jwt>", "record": { "id": "...", "email": "..." } } }
```

Configure providers at **Settings → OAuth2** (13 supported out of the box).

## Anonymous

```http
POST /api/auth/<col>/anonymous
   → { "data": { "token": "<jwt>", "record": { "id": "...", "email": "anon_xxx@anonymous.invalid", "anonymous": true } } }
```

30-day JWT carrying `anonymous: true` claim.

## Admin impersonation

```http
POST /api/admin/impersonate/<col>/<userId>     ← admin auth required
   → { "data": { "token": "<jwt>", "record": { ... }, "impersonated_by": "<admin_id>" } }
```

1-hour user JWT carrying `impersonated_by: <admin_id>` for audit.

## Admin user management

```http
GET    /api/admin/users/<col>?page=1&perPage=30
PATCH  /api/admin/users/<col>/<id>   { email?, verified?, mfa_enabled?: false, data? }
DELETE /api/admin/users/<col>/<id>
```

`mfa_enabled: true` is rejected — admins can only disable MFA (account
recovery); enabling requires the user's own enrollment via `/totp/setup` +
`/totp/confirm`.

## Token shape

User JWT (audience `"user"`):

```json
{
  "iat": 1730000000,
  "exp": 1730604800,
  "aud": "user",
  "id": "<user_id>",
  "email": "...",
  "collection": "<col_name>",
  "anonymous": true,                   // optional
  "impersonated_by": "<admin_id>"      // optional
}
```

Admin JWT (audience `"admin"`):

```json
{
  "iat": 1730000000,
  "exp": 1730604800,
  "aud": "admin",
  "id": "<admin_id>",
  "email": "..."
}
```
