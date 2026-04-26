# PocketBase Parity Checklist

Track what's implemented vs missing compared to PocketBase.
`[x]` = done · `[ ]` = missing · `[-]` = partial

---

## Auth

- [x] Email + password auth (register / login)
- [x] Admin account (single superadmin)
- [x] JWT tokens (admin `aud:"admin"`, user `aud:"user"`)
- [x] Token expiry (7 days)
- [ ] Multiple admins
- [ ] OAuth2 providers (Google, GitHub, Facebook, etc.)
- [ ] Email verification flow
- [ ] Password reset via email (SMTP)
- [ ] OTP / magic link auth
- [ ] MFA / TOTP (2FA)
- [ ] Anonymous auth
- [ ] Token refresh endpoint (`POST /api/auth/refresh`)
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
- [ ] email (validates format)
- [ ] url (validates format)
- [ ] editor (rich text / HTML)
- [ ] password (hashed, never returned in API)
- [ ] geoPoint (lat/lng)
- [ ] Multi-file per field (currently one file per field)

---

## Field Validation (server-side)

- [ ] Min / max length on text fields
- [ ] Min / max value on number fields
- [ ] Regex pattern validation on text
- [ ] Unique constraint per field
- [ ] Max file size enforced server-side
- [ ] MIME type whitelist enforced server-side
- [ ] Relation cascade behavior (cascade / set null / restrict)

---

## API Rules

- [-] 4 hardcoded patterns (`null`, `""`, `@request.auth.id != ""`, `@request.auth.id = id`)
- [ ] Full expression language (`@request.auth.id`, nested `@collection.x.y`, AND/OR, comparisons, `length()`, etc.)

---

## Records API

- [x] List with pagination (`?page=&perPage=`)
- [x] Create, read, update, delete
- [x] Basic filter (`?filter=`)
- [-] Sort — query param accepted but not wired in RecordService
- [ ] Full filter expression parser (not just equality)
- [ ] Multi-field sort (`?sort=-created,title`)
- [ ] Relation expand (`?expand=author`)
- [ ] Nested expand (`?expand=author.profile`)
- [ ] Field projection (`?fields=id,title`)
- [ ] Skip total count (`?skipTotal=1`)
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
- [ ] API preview panel (test endpoints from admin UI)
- [ ] Backup & restore (download DB snapshot)
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
- [x] Rate limiting — not implemented
- [ ] Backup & restore
- [ ] Rate limiting (configurable per route)
- [ ] Custom routes / middleware hooks
- [ ] Server-side JS hooks on record events (`onCreate`, `onUpdate`, `onDelete`)
- [ ] Cron-style scheduled jobs
- [ ] Multiple admin support
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
