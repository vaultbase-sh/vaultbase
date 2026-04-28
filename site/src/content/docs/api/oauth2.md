---
title: OAuth2 API
description: Endpoints for sign-in via Google, GitHub, Apple, X, generic OIDC, and 12 other providers — list, authorize, exchange, unlink.
---

OAuth2 is built into every `auth` collection. Configure providers at
**Settings → OAuth2**; the flow is then caller-driven (your frontend handles
the popup and CSRF state).

For setup steps and the high-level flow see
[Authentication](/concepts/authentication/#oauth2-providers).

## Built-in providers

Google, GitHub, GitLab, Facebook, Microsoft, Discord, Twitch, Spotify,
LinkedIn, Slack, Bitbucket, Notion, Patreon, Apple, Twitter / X, and a
generic OIDC connector (Auth0, Keycloak, Okta, anything OIDC-conformant).

Each requires a **client ID** + **client secret** from the provider's
developer console. Vaultbase wires up the rest — endpoint URLs, scopes,
profile-URL parsing, the email-verified gate.

## List enabled providers

```http
GET /api/auth/<col>/oauth2/providers
   → { "data": [
       { "name": "google", "displayName": "Google" },
       { "name": "github", "displayName": "GitHub" }
     ] }
```

A provider counts as enabled only when:

- `oauth2.<name>.enabled = "1"` AND
- `oauth2.<name>.client_id` is non-empty AND
- `oauth2.<name>.client_secret` is non-empty

Use this on your sign-in page to render only the buttons that are actually
configured server-side.

## Get an authorize URL

```http
GET /api/auth/<col>/oauth2/authorize
    ?provider=google
    &redirectUri=https://app.example.com/auth/callback
    &state=<csrf-token>
   → { "data": { "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth?..." } }
```

| Param | Notes |
|---|---|
| `provider` | One of the providers from `/providers`. |
| `redirectUri` | Must exactly match what's registered with the IdP. |
| `state` | Your CSRF token. The IdP echoes it back; verify on `exchange`. |

The frontend redirects (or pop-ups) to `authorize_url`. After the user
approves, the IdP redirects back to your `redirectUri` with `?code=...&state=...`.

## Exchange code for a token

```http
POST /api/auth/<col>/oauth2/exchange
{ "provider": "google",
  "code": "<from the IdP redirect>",
  "redirectUri": "https://app.example.com/auth/callback" }
   → { "data": { "token": "<jwt>", "record": { "id": "...", "email": "..." } } }
```

The server:

1. Exchanges `code` for an IdP access token.
2. Fetches the user profile (provider-specific endpoint).
3. Looks for an existing `oauth_links` row for `(provider, provider_user_id)`:
   - **Found** → log in the linked user.
4. Else, if profile says `emailVerified = true` and the email matches an
   existing user in this collection:
   - **Returns `{ merge_required: true, merge_token, email, provider }`** —
     the existing user must consent before we link. Call `/merge-confirm`
     (below) to complete.
5. Else, create a new user with a synthetic email + unguessable hash, link it,
   log in.

The email-verified gate plus explicit-consent merge prevents IdP-trust account
takeover.

## Merge-confirm — link an existing account to a new provider

When `/exchange` returns `merge_required: true`, prove ownership of the
existing account and we'll link the provider:

```http
POST /api/auth/<col>/oauth2/merge-confirm
{ "merge_token": "<from /exchange>",
  "password":    "<the existing user's password>" }
   → { "data": { "token": "<jwt>", "record": {...}, "linked_provider": "google" } }
```

Or, if the user is already signed in elsewhere, prove with their JWT instead
of a password:

```http
POST /api/auth/<col>/oauth2/merge-confirm
Authorization: Bearer <user-jwt>
{ "merge_token": "<from /exchange>" }
```

`merge_token` is single-use, valid for 15 minutes, and bound to the
collection it was issued in. Re-using or expiring it returns `401`.

If the link already exists (idempotent retry), the call succeeds and just
returns a fresh JWT.

### Errors

| Code | Cause |
|---|---|
| `400` | Missing or malformed param |
| `422` | Provider not enabled, exchange rejected by IdP, profile fetch failed |
| `502` | IdP returned an unexpected error response |

The response body always includes a `details` field with the IdP's raw
error message when relevant — easier to debug "why did Discord say
`invalid_grant`".

## State / CSRF

Vaultbase doesn't track `state` server-side — it's threaded through the
client-side flow. Generate a random nonce, stash it in `sessionStorage`,
include it on `authorize`, verify on the redirect, then pass `code` to
`exchange`.

```ts
// Sign in with Google
const state = crypto.randomUUID();
sessionStorage.setItem("oauth_state", state);

const { data } = await fetch(
  `/api/auth/users/oauth2/authorize?provider=google&redirectUri=${encodeURIComponent(redirectUri)}&state=${state}`,
).then(r => r.json());

window.location.href = data.authorize_url;
```

```ts
// On the redirect target page:
const params = new URLSearchParams(location.search);
if (params.get("state") !== sessionStorage.getItem("oauth_state")) throw new Error("state mismatch");

const { data } = await fetch("/api/auth/users/oauth2/exchange", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ provider: "google", code: params.get("code"), redirectUri }),
}).then(r => r.json());

localStorage.setItem("token", data.token);
```

## PKCE (Proof Key for Code Exchange)

PKCE protects the auth-code exchange from interception. Vaultbase supports
two modes — pick the one that matches your client architecture.

:::note
**Twitter / X** auto-engages PKCE server-side. Callers don't need to pass
`use_pkce` or generate a verifier — it just works.
:::

### Server-managed (recommended for confidential clients)

Append `&use_pkce=1` to `/authorize`. Vaultbase generates a verifier,
appends `code_challenge` + `code_challenge_method=S256` to the IdP URL, and
stores the verifier in `vaultbase_auth_tokens` keyed by your `state`
(10-minute TTL, single-use). On `/exchange` you pass the same `state` and
the server retrieves the verifier transparently.

```http
GET /api/auth/<col>/oauth2/authorize
    ?provider=google
    &redirectUri=https://app.example.com/auth/callback
    &state=<csrf-token>
    &use_pkce=1
   → { "data": { "authorize_url": "https://accounts.google.com/o/oauth2/v2/auth?...&code_challenge=..." } }

POST /api/auth/<col>/oauth2/exchange
{ "provider": "google",
  "code": "<from redirect>",
  "redirectUri": "https://app.example.com/auth/callback",
  "state": "<same state from authorize>" }
```

### Client-managed (recommended for public / SPA / native clients)

The caller generates the verifier + challenge and passes them through. The
server doesn't see the verifier until `/exchange`.

```ts
// 1. Generate locally
const code_verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
const code_challenge = base64url(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code_verifier))
);

// 2. Authorize
const authUrl = `/api/auth/users/oauth2/authorize?provider=google` +
  `&redirectUri=${encodeURIComponent(redirectUri)}` +
  `&state=${state}&code_challenge=${code_challenge}&code_challenge_method=S256`;

// 3. Exchange — pass your own verifier
await fetch("/api/auth/users/oauth2/exchange", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ provider: "google", code, redirectUri, code_verifier }),
});
```

| Use mode | When |
|---|---|
| `use_pkce=1` (server-managed) | Confidential clients, server-to-server. Less code in the browser. |
| Bring-your-own challenge / verifier | Public clients (SPAs, mobile, desktop) where the client secret can't be trusted. |

## Unlink an OAuth provider

```http
DELETE /api/auth/<col>/oauth2/<provider>/unlink
Authorization: Bearer <user-jwt>
   → { "data": { "unlinked": "google" } }
```

User-bound — only unlinks the caller's own link. Returns `404` if no link
exists for `(user, provider)`.

:::caution
Vaultbase refuses to unlink the **last** auth method on an account. If the
user has no password and no other OAuth links, the call returns `409`:
`"would leave you locked out — set a password or link another provider first"`.
:::

```bash
curl -X DELETE \
  -H "Authorization: Bearer $USER_JWT" \
  https://api.example.com/api/auth/users/oauth2/google/unlink
```

## Provider-specific notes

| Provider | Notes |
|---|---|
| Google | Standard OIDC. `email_verified` from id_token. |
| GitHub | Email may be private — Vaultbase calls `/user/emails` and picks the verified primary. |
| GitLab | Self-hosted GitLab works — set `oauth2.gitlab.endpoint` if not gitlab.com. |
| Microsoft | Tenant-flexible; uses `common` by default. |
| Discord | Email always returned, `verified` flag respected. |
| Slack | Workspace-scoped; emails are reliable. |
| Apple | JWT-signed `client_secret` (ES256, 14-min cache). `response_mode=form_post`. `email_verified` honored from id_token. |
| Twitter / X | PKCE auto-engaged. Email gated behind elevated access — `provider_email` may be `null`. |
| OIDC | Single instance per deploy. Plug in any OIDC-conformant IdP — Auth0, Keycloak, Okta, etc. |

### Apple Sign In setup

Required settings:

| Key | Where to find it |
|---|---|
| `oauth2.apple.client_id` | Services ID (e.g. `com.acme.web`) — Apple Developer → Certificates, Identifiers & Profiles → Identifiers → Services IDs. |
| `oauth2.apple.team_id` | 10-char Team ID — top-right of the Apple Developer portal. |
| `oauth2.apple.key_id` | Key ID — Keys → "+" → Sign in with Apple. |
| `oauth2.apple.private_key` | The `.p8` PEM contents (multi-line). |

Vaultbase mints the JWT-signed `client_secret` per request (ES256), caches
it for 14 minutes, and posts it to Apple's token endpoint. The redirect
arrives via `response_mode=form_post`, so configure the same `redirectUri`
on the Services ID.

### Twitter / X setup

| Key | Where to find it |
|---|---|
| `oauth2.twitter.client_id` | X Developer Portal → Project → User authentication settings → OAuth 2.0 Client ID. |
| `oauth2.twitter.client_secret` | Same screen. Must be a **Confidential** client. |

Set the redirect URL on the Twitter app to match `redirectUri`. PKCE is
automatic — don't pass `use_pkce=1`. Email access requires elevated /
enterprise tier; basic-tier apps will see `provider_email: null`.

### Generic OIDC setup

One generic OIDC connector ships per deploy. Useful for Auth0, Keycloak,
Okta, Authentik, ZITADEL, or any IdP exposing the standard discovery
endpoints.

| Key | Notes |
|---|---|
| `oauth2.oidc.enabled` | `"1"` / `"0"` |
| `oauth2.oidc.client_id` | from your IdP's app/client registration |
| `oauth2.oidc.client_secret` | from your IdP's app/client registration |
| `oauth2.oidc.authorization_url` | e.g. `https://acme.eu.auth0.com/authorize` |
| `oauth2.oidc.token_url` | e.g. `https://acme.eu.auth0.com/oauth/token` |
| `oauth2.oidc.userinfo_url` | e.g. `https://acme.eu.auth0.com/userinfo` |
| `oauth2.oidc.scopes` | space-separated; default `openid profile email` |
| `oauth2.oidc.display_name` | label rendered in the providers list |

## Settings keys

For each provider name in
`google github gitlab facebook microsoft discord twitch spotify linkedin slack bitbucket notion patreon twitter`:

| Key | Notes |
|---|---|
| `oauth2.<name>.enabled` | `"1"` / `"0"` |
| `oauth2.<name>.client_id` | from the IdP console |
| `oauth2.<name>.client_secret` | from the IdP console |

Apple uses an extended set (see above): `client_id`, `team_id`, `key_id`,
`private_key`. The generic `oidc` provider uses the keys listed in the
Generic OIDC section above.

PATCH them via [`/api/admin/settings`](/reference/settings/#reading--writing).
