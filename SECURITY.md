# Vaultbase Security Model

## Trust boundaries

Vaultbase has three principal classes:

1. **Anonymous / unauthenticated** — public records only (`view_rule = null`).
2. **User** (auth-collection JWT) — gated by per-collection rule expressions.
3. **Admin** (`vaultbase_admin` row) — bypasses all rule checks; can author hooks, custom routes, scheduled jobs, queue workers, view collections. Admins are trusted with code execution on the host process.

Treat the admin role as **operator-equivalent**. Compromise of any admin account is equivalent to root on the box.

## Admin-authored code execution surfaces

Each of these compiles admin-supplied JS via `new AsyncFunction("ctx", code)` and runs it in the same process as the API server:

- **Hooks** — `vaultbase/src/core/hooks.ts` — fired on record create/update/delete.
- **Custom routes** — `vaultbase/src/core/routes.ts` — mounted under `/api/custom/<path>`.
- **Cron jobs** — `vaultbase/src/core/jobs.ts` — scheduled execution.
- **Queue workers** — `vaultbase/src/core/queues.ts` — pulled from the `vaultbase_jobs_log` queue.
- **View collections** — `vaultbase/src/core/collections.ts::createUserView` — admin-supplied SQL backs a `CREATE VIEW`. The `validateViewQuery` guard rejects DDL/DML keywords and obvious abuse, but a determined admin can still read sensitive tables in their `SELECT`.

Each compiled function gets a `helpers` object including `helpers.fetch` (untrusted-network egress) and `helpers.query` (passes through the rule engine). For hardened deployments, run vaultbase under a network namespace / firewall that blocks egress to internal IP ranges and to cloud metadata services (`169.254.169.254`).

## Token lifecycle

JWTs are HS256 signed with `VAULTBASE_JWT_SECRET` (or a generated `<dataDir>/.secret` fallback at mode 0600). Every token now carries:

- `iss = "vaultbase"` (verified)
- `aud` ∈ {`admin`, `user`, `file`}
- `jti` (UUID) — checked against `vaultbase_token_revocations` on every verify
- `iat`, `exp`

Verification path is centralized in `core/sec.ts::verifyAuthToken` and rechecks:
- `jti` not in revocation list
- principal row still exists (admin/user)
- `password_reset_at <= iat` (admin)

`POST /api/auth/logout` revokes the bearer token's `jti`. Token rotation uses a sliding-refresh window via `POST /api/auth/refresh`.

To force-logout every admin (after suspected compromise), update `password_reset_at` to `unixepoch()` for that admin row; tokens issued before that timestamp will fail verification on next request.

## Storage hardening

Local filesystem mode validates uploaded filenames as `^[uuid]\.[ext]{1,12}$` and resolves every path inside `vaultbase_data/uploads`. Path-traversal attempts are rejected at the storage layer (`core/storage.ts::safeLocalPath`).

Files served via `GET /api/files/:filename` always evaluate the parent record's `view_rule` regardless of whether the field is `protected`. Image MIME types render inline; everything else gets `Content-Disposition: attachment` plus `X-Content-Type-Options: nosniff` to neutralize stored-XSS via uploaded HTML/SVG.

## CORS and origin gating

`/realtime` (WebSocket) and `GET /api/realtime` (SSE) reject upgrades whose `Origin` is not in the `security.allowed_origins` setting (comma-separated). Empty setting = same-origin only.

Cross-origin API consumers should set `security.allowed_origins` and supply a CORS plugin in front of Elysia (out of scope here).

## Rate-limiting and proxy trust

Per-IP token-bucket rate limiting honors `X-Forwarded-For` only when the immediate peer is in the `VAULTBASE_TRUSTED_PROXIES` env (CIDR-equivalent, comma-separated). Otherwise the socket peer IP is used. **Set this env when running behind Cloudflare, AWS ALB, nginx, etc.** — leaving it unset means a hostile client cannot spoof XFF, but any proxy-derived IP also won't be honored.

## Setup hardening

`POST /api/admin/setup` accepts the `X-Setup-Key` header when `VAULTBASE_SETUP_KEY` is set. Use this on first boot to close the race where an attacker reaches `/setup` before the operator on a public IP. Print the key from the operator's terminal (e.g., `openssl rand -hex 32`) and pass it on the request.

The setup endpoint also enforces a 12-character minimum password and atomically refuses if a concurrent setup landed first.

## Dependencies of note

- `imagescript` and `@jsquash/{webp,avif}` decode untrusted user image input. Upstream advisories should be monitored. Consider running thumbnail generation in a child process so a decoder OOM does not kill the API.
- `quill` 2.0.x and `monaco-editor` 0.55.x ship custom decoration / hover APIs that have historical XSS risk; audit any custom integrations before exposing rich-text/code editing to non-admin users.
- `@types/bun` is pinned to a SemVer range, not `latest`.

## Hardening checklist for production

- Set `VAULTBASE_JWT_SECRET` (don't rely on `.secret` fallback).
- Set `VAULTBASE_SETUP_KEY` on first boot. Unset after creating the seed admin.
- Set `VAULTBASE_TRUSTED_PROXIES` to your front-door peer IPs.
- Set `security.allowed_origins` for the admin SPA / user app origins.
- Set `VAULTBASE_ENCRYPTION_KEY` (AES-GCM, 32 bytes base64) if any field type is `encrypted`.
- Configure `oauth2.<provider>.allowed_redirect_uris` for every enabled IdP.
- Front the binary with TLS termination that sets HSTS; the static landing/docs CF Pages projects already set `Strict-Transport-Security`.
- Restrict `vaultbase_data/` filesystem permissions to the running user (`chmod 700`).
- Rotate the JWT secret after any suspected compromise: stop the server, delete `.secret` (or change the env), restart. All sessions end.
