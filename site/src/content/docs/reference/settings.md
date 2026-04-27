---
title: Settings reference
description: Every settings key Vaultbase reads from the vaultbase_settings table.
---

Runtime configuration lives in the `vaultbase_settings` table — keyed by
string, valued by string. Edited from the admin **Settings** page; values are
cache-invalidated on save.

## Rate limiting

| Key | Type | Default | Notes |
|---|---|---|---|
| `rate_limit.enabled` | `"1"`/`"0"` | `"1"` | Master switch |
| `rate_limit.rules` | JSON array | (defaults below) | See shape below |

`rate_limit.rules` shape:

```json
[
  { "label": "*:auth",   "max": 10,  "windowMs": 3000,  "audience": "all" },
  { "label": "*:create", "max": 60,  "windowMs": 5000,  "audience": "all" },
  { "label": "/api/*",   "max": 300, "windowMs": 10000, "audience": "all" }
]
```

`label` syntax: `<path>[:<action>]`

- `path` — exact (`/api/posts`), prefix (`/api/*`), or wildcard (`*`)
- `action` — `auth`, `create`, `list`, `view`, `update`, `delete`
- `audience` — `all`, `guest` (no token), `auth` (any user/admin token)

## SMTP

| Key | Type | Default |
|---|---|---|
| `smtp.enabled` | `"1"`/`"0"` | `"0"` |
| `smtp.host` | string | — |
| `smtp.port` | string (int) | `"587"` |
| `smtp.secure` | `"1"`/`"0"` | `"0"` |
| `smtp.user` | string | — |
| `smtp.pass` | string | — |
| `smtp.from` | string | — — e.g. `"Acme" <noreply@acme.com>` |

Test via **Settings → SMTP → Send test**. The cache TTL is 30 seconds.

## Email templates

| Key | Type | Default |
|---|---|---|
| `app.url` | string | — — base URL of your frontend; used in `{{link}}` |
| `email.verify.subject` | string | `"Verify your email"` |
| `email.verify.body` | string | (multi-line default) |
| `email.reset.subject` | string | `"Reset your password"` |
| `email.reset.body` | string | (multi-line default) |
| `email.otp.subject` | string | `"Your sign-in code"` |
| `email.otp.body` | string | (multi-line default) |

Variables in templates: `{{email}}`, `{{token}}`, `{{code}}` (otp only),
`{{link}}`, `{{appUrl}}`, `{{collection}}`. Empty values fall back to the
defaults.

## Auth features

| Key | Default | Notes |
|---|---|---|
| `auth.otp.enabled` | `"0"` (off) | Magic link / OTP flow. Requires SMTP. |
| `auth.mfa.enabled` | `"1"` (on) | TOTP enrollment. Disabling blocks new enrollment only — existing users keep working. |
| `auth.anonymous.enabled` | `"0"` (off) | `POST .../anonymous` |
| `auth.impersonation.enabled` | `"1"` (on) | Admin can impersonate users |

Disabled features return `422` with a clear message.

## OAuth2 providers

For each of `google`, `github`, `gitlab`, `facebook`, `microsoft`, `discord`,
`twitch`, `spotify`, `linkedin`, `slack`, `bitbucket`, `notion`, `patreon`:

| Key | Type |
|---|---|
| `oauth2.<name>.enabled` | `"1"`/`"0"` |
| `oauth2.<name>.client_id` | string |
| `oauth2.<name>.client_secret` | string |

A provider counts as "enabled" only when all three are set + `enabled` is `"1"`.

## Reading & writing

```http
GET   /api/admin/settings                     ← admin auth
PATCH /api/admin/settings  { "<key>": "<value>", ... }
```

PATCH is partial — keys not in the body are left untouched. Settings caches
(rate-limit, SMTP) are invalidated on save.

## Programmatic access (server-side)

```ts
import { getAllSettings, getSetting, setSetting } from "vaultbase/api/settings";

const all = getAllSettings();
const port = parseInt(getSetting("smtp.port", "587"));
setSetting("auth.otp.enabled", "1");
```

Useful inside hooks/routes via `ctx.helpers` (which proxies a subset).
