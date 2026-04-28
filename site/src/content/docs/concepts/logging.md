---
title: Logging & rate limits
description: JSONL request logs (with rule-eval audit), JSONPath search, and per-route rate-limit rules.
---

Vaultbase writes every request to a daily JSONL file and runs configurable
rate limits before any handler executes. Both surface in the admin UI under
**Logs** and **Settings → Rate limits**.

## Request logs

One JSONL file per UTC day at `<dataDir>/logs/YYYY-MM-DD.jsonl`. Append-only,
never deleted (rotate with your usual log infra if needed).

### What's in each entry

```json
{
  "ts": 1730000123,
  "method": "GET",
  "path": "/api/posts",
  "status": 200,
  "duration_ms": 4,
  "ip": "203.0.113.7",
  "user_agent": "curl/8.5.0",
  "auth": { "id": "u1", "type": "user", "email": "alice@x.com" },
  "auth_impersonated_by": "<admin_id>",   // present iff JWT carries impersonated_by
  "rules": [
    {
      "rule": "list_rule",
      "collection": "posts",
      "expr": "@request.auth.id != \"\"",
      "outcome": "allow",
      "reason": "rule passed"
    }
  ],
  "error": null
}
```

`rules[]` is the per-rule audit trail — invaluable for debugging "why did
this 403?". For each rule that ran, you get:

- **rule** — `list_rule` / `view_rule` / `create_rule` / `update_rule` / `delete_rule`
- **collection** — collection name
- **expr** — the rule expression text (or `(public)` / `(admin only)`)
- **outcome** — `allow`, `deny`, or `filter` (list rule applied as SQL filter)
- **reason** — `public`, `admin only`, `admin bypass`, `rule passed`, `rule failed`, `applied as SQL filter`

## Impersonation audit

When an admin uses [`POST /api/admin/impersonate/:col/:userId`](/concepts/authentication/#admin-impersonation),
the minted user JWT carries an `impersonated_by` claim. Every request made
with that token gets `auth_impersonated_by: <admin_id>` on its log entry.

Find every impersonated request via JSONPath in the **Logs** page or the
admin API:

```
$[?(@.auth_impersonated_by)]
```

Or `jq` the file directly:

```bash
jq -c 'select(.auth_impersonated_by)' data/logs/2026-04-27.jsonl
```

## Browsing logs in the admin

**Logs** page in the sidebar:

- Date picker — pick any past day, server reads the matching JSONL file.
- **Search** — JSONPath expression evaluated against each entry. Examples:
  - `$.path` — show every entry's path
  - `$.status` — every status code
  - `$.rules[*].outcome` — every rule outcome
  - `$.auth.email` — emails of authenticated callers
- **Filter** — narrow by method, status range, path prefix, auth type.
- **Rule outcome** dropdown — narrow to entries whose `rules[]` evaluations
  match a given outcome:
  - **All** — no filter (default).
  - **Any rule eval** — only entries that ran any rule (records-API requests).
  - **Allow** — at least one rule passed.
  - **Deny** — at least one rule denied (403 responses live here).
  - **Filter** — `list_rule` was applied as a SQL filter.

  Backend equivalent: `GET /api/admin/logs?ruleOutcome=deny`.

Since each entry is a self-contained JSON object, you can also `jq` the file
directly outside the admin:

```bash
jq -r 'select(.status >= 400) | "\(.status) \(.method) \(.path)"' \
  data/logs/2026-04-27.jsonl
```

## Programmatic access

```http
GET /api/admin/logs?date=2026-04-27&q=$.path&limit=200    ← admin auth
   → { "data": [ {entry}, ... ], "total": 42 }
```

| Param | Notes |
|---|---|
| `date` | UTC date `YYYY-MM-DD`. Default: today. |
| `q` | Optional JSONPath. Returns rows where the path resolves to a non-empty value, with the resolved snippet attached. |
| `limit` | Default 100, max 1000. |
| `offset` | Pagination cursor. |

## Hook logs

`ctx.helpers.log(...)` writes a `HOOK` row into the same logs file. So
`afterCreate` hooks, cron jobs, and custom routes all surface alongside HTTP
traffic.

```ts
ctx.helpers.log("Sending welcome email to", ctx.record.email);
```

```json
{ "ts": ..., "kind": "hook", "collection": "users", "event": "afterCreate",
  "args": ["Sending welcome email to", "alice@x.com"] }
```

## Rate limits

Token-bucket per IP, configurable per route. Master switch + ruleset both
live in `vaultbase_settings` (see [Settings keys](/reference/settings/)).

### Default rules

```json
[
  { "label": "*:auth",   "max": 10,  "windowMs": 3000,  "audience": "all" },
  { "label": "*:create", "max": 60,  "windowMs": 5000,  "audience": "all" },
  { "label": "/api/*",   "max": 300, "windowMs": 10000, "audience": "all" }
]
```

Rules evaluate top-to-bottom; the **first matching rule** applies. Order
specific → general (auth-only routes before catch-alls).

### Label syntax

`<path>[:<action>]` where:

| Component | Values |
|---|---|
| `path` | exact (`/api/posts`), prefix (`/api/*`), or wildcard (`*`) |
| `action` (optional) | `auth`, `create`, `list`, `view`, `update`, `delete` |
| `audience` | `all`, `guest` (no token), `auth` (any token) |

Examples:

```json
[
  { "label": "/api/auth/*:auth",     "max": 5,   "windowMs": 60000, "audience": "all" },
  { "label": "/api/auth/*:create",   "max": 5,   "windowMs": 60000, "audience": "guest" },
  { "label": "/api/posts:create",    "max": 30,  "windowMs": 60000, "audience": "auth" },
  { "label": "/api/posts",           "max": 600, "windowMs": 60000, "audience": "all" },
  { "label": "*",                    "max": 1000,"windowMs": 60000, "audience": "all" }
]
```

### When a limit triggers

Response is `429 Too Many Requests` with a `Retry-After` header (seconds).

```json
{ "error": "rate limit exceeded", "code": 429, "details": { "retryAfter": 4 } }
```

The bucket is keyed on the client IP (read from `X-Forwarded-For` if set —
configure your reverse proxy to send it).

### Disabling rate limits

```http
PATCH /api/admin/settings  { "rate_limit.enabled": "0" }
```

Useful for development or when you've put a dedicated rate-limit layer in
front (Cloudflare WAF, nginx `limit_req`).

### Per-rule audit

Each request log entry includes which rate-limit rule matched (if any). Pair
that with `q=$.rate_limit` in the Logs page to see which routes are hot.

## Tuning

- Make the **first** rule the most specific (e.g. `/api/auth/*:auth`).
- Keep a generous catch-all `*` for general API health.
- For public endpoints with no auth, scope by `audience: "guest"` so signed-in
  users aren't punished for guest spam.
- Token-bucket is per-process — Vaultbase is one binary, no clustering.
  Front a fleet with a real RL layer if you need cross-node coordination.
