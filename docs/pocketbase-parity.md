# PocketBase Parity Checklist

Track what's implemented vs missing compared to PocketBase.
`[x]` = done · `[ ]` = missing · `[-]` = partial

---

## Auth

- [x] Email + password auth (register / login)
- [x] Admin account (single superadmin)
- [x] JWT tokens (admin `aud:"admin"`, user `aud:"user"`)
- [x] Token expiry (7 days)
- [x] Multiple admins (list / create / update / delete from Settings)
- [x] OAuth2 providers — Google + GitHub built in; configured in admin Settings → OAuth2; endpoints under `/api/auth/:collection/oauth2/{providers,authorize,exchange}`; account-link table (`vaultbase_oauth_links`); link-or-email-match-or-create-new flow with email-verified gate to prevent IdP-trust account takeover
- [x] Email verification flow (auto-sent on register; `/api/auth/:collection/request-verify`, `/verify-email`)
- [x] Password reset via email (`/api/auth/:collection/request-password-reset`, `/confirm-password-reset`; no email enumeration)
- [x] OTP / magic link auth — `POST /api/auth/:collection/otp/{request,auth}`; single record carries both a 32-byte token (link) and a 6-digit code; SMTP-required; no enumeration on request
- [x] MFA / TOTP (2FA) — RFC 6238 SHA1/30s, QR via `otpauth://`; `POST /api/auth/:collection/totp/{setup,confirm,disable}`; existing `/login` returns `mfa_required + mfa_token` when enabled, completed via `POST /login/mfa`
- [x] Anonymous auth — `POST /api/auth/:collection/anonymous` mints a guest user with synthetic email + 30d JWT (anonymous claim)
- [x] Token refresh endpoint (`POST /api/auth/refresh`)
- [x] Admin impersonation of users — `POST /api/admin/impersonate/:collection/:userId` mints a 1h user JWT carrying `impersonated_by: <admin_id>` for audit; admin UI exposes it as a row action in the user drawer

---

## Collection Types

- [x] `base` collections
- [x] `auth` collections — distinct `type` column; reserved field names (`email`, `password`, `verified`, `tokenKey`, `password_hash`, `email_verified`) blocked at create/update; `/api/auth/:collection/*` endpoints reject `type='base'` collections
- [x] `view` collections (read-only, backed by SQLite VIEW; column inference from SELECT; writes return 405; defaults list/view rules to admin-only)

---

## Field Types

- [x] text
- [x] number
- [x] bool
- [x] file
- [x] relation
- [x] select
- [x] autodate
- [x] email (validates format)
- [x] url (validates format)
- [x] editor (rich text / HTML)
- [x] password (bcrypt-hashed via Bun.password; never returned in API)
- [x] geoPoint (lat/lng object, validated ranges)
- [x] Multi-file per field (file field option `multiple`; JSON array of filenames)

---

## Field Validation (server-side)

- [x] Min / max length on text fields
- [x] Min / max value on number fields
- [x] Regex pattern validation on text
- [x] Unique constraint per field
- [x] Required field check
- [x] Email format validation
- [x] URL format validation
- [x] Select value whitelist (single + multiple)
- [x] 422 response with per-field error details
- [x] Max file size enforced server-side
- [x] MIME type whitelist enforced server-side (supports `image/*` patterns)
- [x] Relation target existence check (422 if referenced record missing)
- [x] Relation cascade behavior — `cascade` / `setNull` (default) / `restrict` (409); cascade chains across collections

---

## API Rules

- [x] Full expression language (=, !=, >, >=, <, <=, ~, &&, ||, parentheses, JSON fields, bool/null coercion)
- [x] `@request.auth.id`, `@request.auth.email`, `@request.auth.type` in rules
- [x] List rule applied as SQL filter (admins bypass)
- [x] view/create/update/delete rules evaluated against record + auth
- [x] Admins bypass all expression rules

---

## Records API

- [x] List with pagination (`?page=&perPage=`)
- [x] Create, read, update, delete
- [x] Filter expression parser (=, !=, >, >=, <, <=, ~, &&, ||, parens)
- [x] Sort — single and multi-field (`?sort=-created,title`)
- [x] Relation expand (`?expand=author`)
- [x] Nested expand (`?expand=author.profile`)
- [x] Field projection (`?fields=id,title`)
- [x] Skip total count (`?skipTotal=1`)
- [x] Batch API (`POST /api/batch` — atomic transaction, max 100 ops)

---

## Files

- [x] Local filesystem storage
- [x] Upload (`POST /api/files/...`)
- [x] Serve (`GET /api/files/:filename`)
- [x] Delete (`DELETE /api/files/...`)
- [ ] S3-compatible storage backend
- [x] Image thumbnails (`?thumb=WIDTHxHEIGHT`) — pure-JS via `imagescript` (PNG/JPEG/GIF), aspect-preserving resize, on-disk cache at `<uploadDir>/.thumbs/`, falls back to original for non-images, cache invalidated on file delete
- [x] Temporary file access tokens — `protected: true` on a file field gates `GET /api/files/:filename` behind a `?token=<jwt>` (audience `"file"`, 1h expiry). Issued via `POST /api/files/:collection/:recordId/:field/:filename/token` (admin-only). Schema editor exposes a Protected toggle on file fields.
- [x] Multiple files per single field

---

## Realtime

- [x] WebSocket endpoint (`/realtime`)
- [x] Subscribe / unsubscribe to collections
- [x] Broadcast on create / update / delete
- [x] Subscribe to specific record (`posts/abc123`) — broadcast fans out to `<collection>`, `<collection>/<id>`, and `*` topics; deduped per-ws
- [x] Subscribe to `*` (all collections) — wildcard topic
- [x] Auth token passed with subscription — `?token=<jwt>` on the WS upgrade URL OR `{type:"auth", token}` message; auth context stored per-ws via WeakMap (available for future per-record filtering)
- [ ] SSE fallback (PB uses SSE; we use WS)

---

## Request Logging

- [x] Log every request to `vaultbase_logs` table
- [x] `GET /api/admin/logs` (paginated, filterable)
- [x] Admin toggle in Logs UI
- [x] Live auto-refresh in UI
- [x] Rule evaluation detail per log entry — every records-API request records which rule slot was evaluated (`list_rule` / `view_rule` / `create_rule` / `update_rule` / `delete_rule`), the expression text, outcome (`allow` / `deny` / `filter`), and a reason (`public` / `admin only` / `admin bypass` / `rule passed` / `rule failed` / `applied as SQL filter`); admin Logs UI shows a per-row badge plus expandable detail in the drawer
- [x] Auth context per log entry (who made the request)

---

## Admin UI

- [x] Login / setup pages
- [x] Collections list + create / delete
- [x] Schema editor (fields + API rules)
- [x] Records list + create / edit / delete
- [x] Filter bar (press Enter)
- [x] Logs page (live, filterable)
- [x] Settings page
- [x] PrimeReact DataTable, Dialog, Sidebar, Dropdown, InputSwitch, Toast
- [x] API preview panel (test endpoints from admin UI — presets per collection, body editor, copy response)
- [x] Backup & restore (download / upload SQLite snapshot)
- [x] Import / export CSV — base collections only; admin UI Export/Import buttons; backend at `GET /api/admin/export/:collection` and `POST /api/admin/import/:collection`; JSON-encodes object/array fields; import returns per-row error summary
- [x] DB indexes management
- [x] Email template editor (Settings → Email templates: app URL, verify + reset subject/body with `{{var}}` interpolation)
- [x] SMTP config + test button
- [x] Migration file generation — admin Settings → Migrations downloads a JSON snapshot of every collection (name · type · fields · rules · view query). Apply on a fresh install via Upload & apply (`additive` = create-missing-only safe default; `sync` = also update existing). Backed by `GET /api/admin/migrations/snapshot` and `POST /api/admin/migrations/apply`. Never deletes collections.

---

## System / Extensibility

- [x] Single binary distribution (`bun build --compile`)
- [x] SQLite via `bun:sqlite` (no native deps)
- [x] Env var configuration
- [x] JWT secret auto-generated + persisted
- [x] Rate limiting (per-IP token bucket, configurable per rule via Settings)
- [x] Rate limiting (configurable per route via `<path>[:<action>]` rules)
- [x] Custom routes (admin-defined HTTP handlers under `/api/custom/<path>`)
- [x] Server-side JS hooks on record events (before/after × create/update/delete; Monaco editor with typed `ctx`)
- [x] Cron-style scheduled jobs (UTC; 30s tick; run-now button; last_status/last_error)
- [x] Multiple admin support
- [x] Email sending (SMTP via nodemailer; helpers.email() works)
- [x] Encrypted fields (AES-GCM via VAULTBASE_ENCRYPTION_KEY; text/email/url/json)

---

## SDK / Client

- [x] REST API (standard, works with any HTTP client)
- [x] Elysia Eden Treaty (type-safe, TypeScript only)
- [ ] Official JS SDK (auto-cancellation, realtime helpers, offline queue)
- [ ] Official Dart SDK
- [ ] Official C# SDK

---

## Vaultbase-only (not in PocketBase)

- [x] TypeScript throughout (PB is Go)
- [x] WebSocket realtime (PB uses SSE)
- [x] Bun runtime
- [x] Drizzle ORM (schema-driven, type-safe queries)
- [x] PrimeReact admin UI

## My Notes

- [x] There should be a full setup process for when a user downloads and first run the application, it should be a wizard helper to get it setup and run.
- [x] Enforce protected URLs, when an admin logs in, they can't go back to the sign-in page, also, when a user is logged out, they can't enter the dashboard.
- [x] Logs page should have full search and filters
- [x] fully typed/autocomplete rules for list, view, create, delete, and others. when a user tries to write a rule, the auto complete should show suggesstions, or direct the user to the correct syntax and available options.
- [x] searchbar in the type field when adding a new field when creating a customer
- [x] write logs in a file, also do not delete logs, per day log rotation (date based), structured json logs, jsonline, jsonpath search
- [x] make the primary color #1055C9 like for buttons, selects and other things, the background of the main body is #1F1F1F and the side bar is #232323

---

## Follow-ups (deliberately scoped out of earlier sessions)

Items that are working today but were narrowed in scope for shipping speed. Tracked here so we can pick them up later instead of rediscovering.

### Auth

- [ ] **OAuth2 PKCE** — currently caller-managed `state` only. PKCE (`code_verifier` / `code_challenge`) would harden the flow for native/SPA apps that can't keep a client secret.
- [ ] **More OAuth2 providers** — Apple (needs JWT-signed `client_secret`), Twitter (needs elevated access for email), generic OIDC (needs runtime URL config), Reddit/Strava (no reliable email). Each new "standard" provider is ~30 lines.
- [ ] **OAuth2 unlink endpoint** — admins can drop rows from `vaultbase_oauth_links` directly; a self-service `DELETE /api/auth/:collection/oauth2/:provider/unlink` would be cleaner.
- [ ] **OAuth2 account-merge UX** — when a user signs up via password and later via OAuth with the same verified email, we auto-link. An explicit consent step would be safer.
- [ ] **MFA recovery codes** — single-use backup codes table; common ask after enabling TOTP.
- [ ] **Anonymous user promotion** — `POST /api/auth/:collection/promote` to convert an anonymous account to a real one (set email + password). Today this is doable via the admin users PATCH only.
- [ ] **Impersonation audit log** — JWT carries `impersonated_by` but `extractAuth` in `api/logs.ts` doesn't surface it onto the log entry. Tweak `AuthLogContext` to include it.
- [ ] **Auth-collection register-flow validation** — implicit fields' custom options (e.g. `min` length on `email`) are stored but the `/register` endpoint doesn't run `validateRecord` against them. Wire it through.
- [ ] **Per-user token issuance for files** — `POST /api/files/.../token` is admin-only. Honor the record's `view_rule` so a user with view access can mint their own.

### Files

- [ ] **WebP / AVIF thumbnails** — `imagescript` doesn't support them. Could add `@jsquash/webp` later if needed.
- [ ] **Thumb fit modes** — current impl is "fit-within preserving aspect". Adding `?thumb=200x200&fit=cover|contain|crop` is a small follow-up.
- [ ] **Animated GIF thumbnails** — animated GIFs are decoded as a static frame and emitted as PNG. True animated thumbnails would need frame-by-frame handling.
- [ ] **Auto-token in admin UI file previews** — protected images don't render in the records table. Needs a `mint → render` round-trip per cell.
- [ ] **Streaming CSV export** — current impl pages through and concatenates in memory (fine up to ~100k rows). Bigger collections need a streaming response writer.

### Realtime

- [ ] **Per-record auth filtering at broadcast time** — auth is captured per-WS via WeakMap but isn't consulted when fanning out events. Doing this right needs the collection's `view_rule` evaluated against the receiving user before sending.

### Logging

- [ ] **Hook-emitted rule details** — hooks bypass `evaluateRule`, so policy decisions inside `helpers.find` etc. don't surface. Could add an opt-in `helpers.recordRule(...)`.
- [ ] **Batch endpoint rule enforcement + logging** — batch ops call `createRecord`/`updateRecord`/`deleteRecord` directly, bypassing the API rule check. Pre-existing security gap, not just a logging one.
- [ ] **Log-search UI for rule outcomes** — works today via the JSONPath search box (e.g. `$[?(@.rules && @.rules[?(@.outcome=='deny')])]`). A dedicated filter dropdown would be nicer.

### Migrations

- [ ] **Snapshot diff viewer** — show what an apply will change before clicking Apply. Computable by re-using `isCollectionInSync` per pair.
- [ ] **CLI flag for snapshot apply at startup** — e.g. `vaultbase --apply-snapshot=schema.json` for stateless deploys.

### Cross-cutting

- [ ] **`view` collection field-type inference beyond `text`** — SQLite views don't carry typed column metadata for expressions, so all inferred fields default to `text`. Admins can override per-field types after creation.
- [ ] **`view` collection preview-rows button** — would need a tiny admin endpoint that runs the query with `LIMIT 5`.
