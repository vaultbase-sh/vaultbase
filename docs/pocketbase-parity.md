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
- [ ] OAuth2 providers (Google, GitHub, Facebook, etc.)
- [ ] Email verification flow
- [ ] Password reset via email (SMTP)
- [ ] OTP / magic link auth
- [ ] MFA / TOTP (2FA)
- [ ] Anonymous auth
- [x] Token refresh endpoint (`POST /api/auth/refresh`)
- [ ] Admin impersonation of users

---

## Collection Types

- [x] `base` collections
- [-] `auth` collections (register/login work, but implicit fields not enforced)
- [ ] `view` collections (read-only, defined by SQL query)

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
- [ ] editor (rich text / HTML)
- [ ] password (hashed, never returned in API)
- [ ] geoPoint (lat/lng)
- [ ] Multi-file per field (currently one file per field)

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
- [ ] Relation target existence check
- [ ] Relation cascade behavior (cascade / set null / restrict)

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
- [ ] Nested expand (`?expand=author.profile`)
- [x] Field projection (`?fields=id,title`)
- [x] Skip total count (`?skipTotal=1`)
- [ ] Batch API (create/update/delete multiple in one request)

---

## Files

- [x] Local filesystem storage
- [x] Upload (`POST /api/files/...`)
- [x] Serve (`GET /api/files/:filename`)
- [x] Delete (`DELETE /api/files/...`)
- [ ] S3-compatible storage backend
- [ ] Image thumbnails (`?thumb=100x100`)
- [ ] Temporary file access tokens (protected URLs)
- [ ] Multiple files per single field

---

## Realtime

- [x] WebSocket endpoint (`/realtime`)
- [x] Subscribe / unsubscribe to collections
- [x] Broadcast on create / update / delete
- [ ] Subscribe to specific record (`posts/abc123`)
- [ ] Subscribe to `*` (all collections)
- [ ] Auth token passed with subscription
- [ ] SSE fallback (PB uses SSE; we use WS)

---

## Request Logging

- [x] Log every request to `vaultbase_logs` table
- [x] `GET /api/admin/logs` (paginated, filterable)
- [x] Admin toggle in Logs UI
- [x] Live auto-refresh in UI
- [ ] Rule evaluation detail per log entry
- [ ] Auth context per log entry (who made the request)

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
- [ ] Import / export CSV
- [ ] DB indexes management
- [ ] Email template editor
- [ ] SMTP config + test button
- [ ] Migration file generation

---

## System / Extensibility

- [x] Single binary distribution (`bun build --compile`)
- [x] SQLite via libSQL
- [x] Env var configuration
- [x] JWT secret auto-generated + persisted
- [ ] Rate limiting — not implemented
- [ ] Rate limiting (configurable per route)
- [ ] Custom routes / middleware hooks
- [ ] Server-side JS hooks on record events (`onCreate`, `onUpdate`, `onDelete`)
- [ ] Cron-style scheduled jobs
- [x] Multiple admin support
- [ ] Email sending (SMTP)
- [ ] Encrypted fields

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
