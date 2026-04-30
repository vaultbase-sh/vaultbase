# Vaultbase Roadmap

Implementation status of every feature.
`[x]` = done · `[ ]` = planned · `[-]` = partial

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
- [x] Anonymous auth — `POST /api/auth/:collection/anonymous` mints a guest user with synthetic email + configurable-window JWT (default 30d, settings key `auth.anonymous.window_seconds`)
- [x] **Configurable JWT lifetimes per token kind** — `tokenWindowSeconds(kind)` reads `auth.<kind>.window_seconds` (kinds: `admin`, `user`, `anonymous`, `impersonate`, `refresh`, `file`). Min 60s, max 365d, malformed values fall back to per-kind default. Settings PATCH validates before write. Settings → Auth features → "Session lifetimes" panel exposes each window with quick presets (1h / 1d / 7d / 30d / 90d). Existing tokens keep their original expiry; only new mints honor the change. 21 tests in `auth-tokens.test.ts`.
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
- [x] S3-compatible storage backend (Bun's native `Bun.S3Client` — works for AWS S3, Cloudflare R2, MinIO; configured under Settings → File storage with one-click R2 + S3 presets, round-trip test button, optional public-URL serving for CDN-fronted buckets)
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
- [x] SSE fallback — `GET /api/realtime` opens a `text/event-stream` connection, mints a `clientId`, and emits an initial `event: connect` frame carrying it. `POST /api/realtime { clientId, topics?, token? }` sets/replaces subscriptions (PocketBase-compatible aliases: `subscriptions` and `collections`). `DELETE /api/realtime/:clientId` tears down. SSE adapter implements the same `WSLike` interface the WS path uses, so `view_rule` filtering, wildcard `*` topics, and per-record routing work identically. 30s heartbeat keeps long-lived streams alive through proxies. 6 tests in `sse.test.ts`.

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

- [x] Login / setup pages — fresh installs auto-redirect to `/_/setup` until the seed admin is created; once an admin exists the setup route is sealed off (any visit bounces to `/_/login` or the dashboard). Driven by a read-only `GET /api/admin/setup/status` probe at app boot, replacing the prior POST-probe pattern that wrote to logs and cost a rate-limit token. 4 tests in `setup-status.test.ts`.
- [x] Collections list + create / delete
- [x] Schema editor (fields + API rules) — V1 tabbed layout (Fields / API Rules / Indexes); structured fields table with row-level required & unique flag indicators, sticky right-side Field options panel that opens on selection (and dismisses via X); API Rules tab uses preset chips (Public / Auth only / Admin only / Custom) with per-op accordion + monospace summary; Indexes tab is hidden for view collections
- [x] **Brand & design system v1.0** — accent shifted to Blue 500 (#3b82f6) across admin + docs site (was #1055C9), 14 type-mapped data colors centralized as CSS custom properties (`--type-text`, `--type-number`, …), hexagonal vault SVG mark replaces the placeholder admin sidebar / Login / Setup logos and the docs favicon, type-chip palette realigned to brand-spec hues (date now pink, number green, bool amber, etc.), Starlight accent ramp (`--sl-color-accent-low/high`) re-anchored to Blue 900 → Blue 400
- [x] **Admin redesign v1.0 — primitives + shell wiring** — pixel-aligned token block in `globals.css` (surfaces 0e0f12 / 131418 / 181a1f / 1d2026 / 14161b / 0a0b0e, four-tier text, motion fast/standard/slow with cubic-bézier easings, e1/e2/e3 shadows, 4-point spacing scale). New utility classes per the redesign reference: `.page-h` (body-level page header, 26px H1, -0.015em tracking), `.crumbs` (mono breadcrumb chain with `/` separators), `.seg` (segmented control), `.fpill` (filter expression pill — chip-first, expression on demand), `.tab .ct` (mono count chip with subtle border, accent on active), `.kbd-key` (depressed-key visual), `.empty-state` (icon-box + heading + body + CTA row), `.stat-tile` (label · value · delta · spark), `.cal` (4-tone callouts), `.mock` (design-reference frame). `<Topbar>` accepts a `crumbs` prop; new `<PageHeader>` component for the body H1 pattern. Sidebar version chip wears a 1px subtle border. Collections empty state ships the new icon-box variant with a docs CTA. Schema editor topbar now uses breadcrumbs (`Collections / posts / schema`).
- [x] **Admin redesign v1.0 — pages + composites** — DataTable PrimeReact overrides realigned (sticky thead, mono caps, denser 36px rows, accent-soft selection with inset border on first cell, hover-revealed `.row-actions`). Records bulk-select bar swapped from danger-tinted callout to neutral panel-bottom strip with accent count + Export/Clear/Delete buttons + total counter. Dashboard rewritten as health-first: 4 stat tiles (collections / queued / succeeded / dead-letter), top-of-page warning callout when dead jobs exist, "Recent dead jobs" + "Per-queue backlog" side-by-side panels, top collections grid; routed at `/_/` (replacing the prior collections redirect) and surfaced in the sidebar. Toast queue replaced with custom bg-panel-2 cards (icon · body · ×N aggregation · dismiss · severity-tinted border, e2 shadow, 320px min-width); identical messages within a 3s window fold into a single card with a counter. Settings left rail re-anchored to spec (200px sticky, accent-soft active state with 2px left border, fast easing). Auth (Login + Setup) cards retuned to spec geometry (380px, 32px padding, r-lg, e3 shadow, single-radial gradient backdrop). 404 page added — unmatched routes inside `/_/*` render a real not-found state instead of bouncing. Command palette (⌘K) shipped: portal-rendered overlay, fuzzy match across nav + collections, ↑↓/⏎/esc keyboard handling, mounted via `useCommandPalette()` in the `AppShell`.
- [x] **Admin redesign v1.0 — second sweep** — Logs page topbar swapped to crumbs; status column rendered as `.badge` (success/info/warning/danger). API preview gained Copy curl + Copy fetch() actions in the topbar; response status now renders as a badge. `.table` legacy class realigned to brand spec (sticky thead, mono caps headers, 36px rows, 1px subtle hairlines, accent-soft selection w/ inset accent border on first cell, hover-revealed `.row-actions`). PrimeReact `Dialog` + `Sidebar` (drawer) chrome retuned: bg-panel surface, 1px subtle/default hairlines, sticky bottom-anchored footers, e3 shadow on Dialog, drawer mask softened to 0.55. `CodeEditor` gained optional chrome — `fileName` prop renders a tab strip; `statusStrip` prop renders a footer with cursor `Ln/Col`, language pill, and `ok` / `N error · M warning` count derived from Monaco markers. Superusers page topbar uses crumbs and ships the icon-box empty state.
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
- [x] **In-process job queue + workers (Phase 1 of the Redis brainstorm)** — `vaultbase_workers` defines compiled JS (`AsyncFunction(ctx, code)`) bound to a queue name, with concurrency, retry_max, retry_backoff (`exponential`/`fixed`), retry_delay_ms; `enqueue(queue, payload, { delay, uniqueKey, retries, backoff, retryDelayMs })` exposed via `helpers.enqueue` (lazy-imported to break the queues→hooks→queues cycle); 500ms scheduler poll picks one worker per queue per tick and uses optimistic DB-UPDATE-based claim (`status=queued → running` with returning) to avoid double-processing; failures bump `attempt` and re-queue with backoff until `retry_max`, then `status="dead"`; cron jobs gain a `mode` column — `inline` (default) runs in-process, `worker:<queue>` enqueues onto the named queue; admin endpoints under `/api/admin/{workers,queues}` (CRUD + jobs-log list/retry/discard + per-queue stats); admin UI adds Workers + Jobs log tabs to the Hooks page (Monaco worker IntelliSense via `WorkerContext` decl); `vaultbase_jobs_log` is the audit trail. 13 tests in `queues.test.ts`.
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

## Stack highlights

- [x] TypeScript throughout (server + admin)
- [x] WebSocket realtime
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

- [x] **OAuth2 PKCE** — `?use_pkce=1` on `/authorize` (server-managed: verifier stored in `vaultbase_auth_tokens` keyed by `state`, 10-min TTL, single-use) OR caller passes own `code_challenge`/`code_verifier`. SHA-256 S256 via `crypto.subtle`. RFC 7636 test vector covered.
- [x] **More OAuth2 providers** — Apple Sign In (ES256-signed JWT `client_secret` via `jose.importPKCS8`, 14-min cache; id_token decoded for `sub`/`email_verified`; `response_mode=form_post`), Twitter / X (auto-engages PKCE via `requiresPkce: true` flag), generic OIDC (runtime-configurable URLs from settings: `oauth2.oidc.{authorization_url,token_url,userinfo_url,scopes,display_name}`, single instance per deploy).
- [x] **OAuth2 unlink endpoint** — `DELETE /api/auth/:collection/oauth2/:provider/unlink` (user-bound, only own links). 409 with "would leave you locked out" if user has no password and no other OAuth links.
- [x] **OAuth2 account-merge UX** — `/oauth2/exchange` no longer auto-links on email match. It returns `{ merge_required: true, merge_token, email, provider }` instead. The caller must confirm with `POST /oauth2/merge-confirm` (with the user's password OR a valid user JWT) to complete the link. Single-use 15-min tokens stored in `vaultbase_auth_tokens` (purpose `oauth2_merge`); idempotent if the link already exists. 7 tests in `oauth2-merge.test.ts`.
- [x] **MFA recovery codes** — `vaultbase_mfa_recovery_codes` table (10 single-use 8-char codes, bcrypt-hashed). Endpoints: `POST /totp/recovery/regenerate`, `GET /totp/recovery/status`. `POST /login/mfa` accepts `recovery_code` as alt to `code`. `/totp/disable` wipes all codes.
- [x] **Anonymous user promotion** — `POST /api/auth/:collection/promote` upgrades anonymous user to real account (sets email + password, clears `is_anonymous`, returns fresh non-anon JWT). 409 on dup email; rejects non-anonymous tokens.
- [x] **Impersonation audit log** — `AuthLogContext.impersonated_by` propagated from JWT in `extractAuth`; `LogEntry.auth_impersonated_by` written to JSONL.
- [x] **Auth-collection register-flow validation** — `/register` now calls `validateRecord(col, body, "create")` against implicit + user fields (so custom `min`/`max` on email, etc. enforced).
- [x] **Per-user token issuance for files** — `POST /api/files/.../token` honors `view_rule`: admins always allowed, users allowed iff `evaluateRule(view_rule, auth, record)` passes. Public (`null`) open to unauth; `""` denies non-admin.

### Files

- [x] **WebP / AVIF thumbnails** — `detectFormat` recognizes WebP (`RIFF…WEBP`) + AVIF (`ftypavif`). `generateThumbnail` lazy-imports `@jsquash/webp` + `@jsquash/avif` (WASM, Bun-compatible), decodes → shares the same `fitImage`/`fitDimensions` math as imagescript paths → re-encodes in the source format. New `thumbMime(format)` helper sniffs served bytes so the response `Content-Type` always matches what's on disk. URL contract unchanged. WASM cold-init: WebP ~17ms, AVIF ~23ms.
- [x] **Thumb fit modes** — `?thumb=WxH&fit=contain|cover|crop` (default `contain`) plus shorthand `WxH_mode`. `cover`/`crop` aliased; both center-crop source to target aspect first then resize. Cache key includes mode (legacy `<file>__WxH` paths still hit for `contain`).
- [x] **Animated GIF thumbnails** — `GIF.decode` → resize each frame using the same fit math → preserve `duration` / `disposalMode` / `loopCount` → `GIF.encode(95)`. Single-frame GIFs downgrade to PNG (matches legacy behavior, cheaper). Decoder/encoder failure falls back to first-frame-as-PNG with an inline comment.
- [x] **Auto-token in admin UI file previews** — `FileFieldPreview` component lazily mints per-filename tokens for `protected: true` fields. Module-level cache by `(filename, expires_at)` with in-flight dedup; refreshes ~60s before expiry. Both records-table cell and edit-drawer use it.
- [x] **Streaming CSV export** — `GET /api/admin/export/:collection` returns a `Response` wrapping a `ReadableStream<Uint8Array>`. `start()` enqueues the header row + kicks off the first page; `pull()` pre-launches the next page before flushing the current batch so paging overlaps with network. `cancel()` flips a cancelled flag (re-checked around every await) so client disconnects stop the page loop. Output is byte-identical to the legacy buffered impl — existing CSV tests pass unchanged. Shared formatting via extracted helpers `exportColumnsForFields`, `exportHeaderRow`, `formatRowsForCsv`. Import endpoint untouched. 4 tests in `csv-stream.test.ts`.

### Realtime

- [x] **Per-record auth filtering at broadcast time** — `broadcast(coll, event, opts?)` accepts `{ viewRule, record }`. Each subscriber's `WSAuth` is checked: admins always pass; `null` rule → public; `""` → admin only; expression rules evaluated per-subscriber via `evaluateRule`. Records core threads the rule + record through create / update / delete / cascade callsites. Delete events pass the just-deleted snapshot so the rule still has fields. 8 new tests in `realtime-rules.test.ts`.

### Logging

- [x] **Hook-emitted rule details** — `helpers.recordRule({ rule, collection?, expression?, outcome, reason })` attaches custom policy decisions to the active request log. Threaded via `AsyncLocalStorage<Request>` (`runWithHookRequest`) — the records HTTP layer wraps create/update/delete in the ALS scope so hook callsites pick up the active Request without records-core touching it. Cron jobs, custom routes invoking records-core, and post-cascade hooks get `undefined` and `recordRule` is a silent no-op. Mirrored into Monaco IntelliSense (`HookHelpers` declaration in `admin/src/components/CodeEditor.tsx`). 5 tests in `hook-rule-logs.test.ts`.
- [x] **Batch endpoint rule enforcement + logging** — every batch op now runs the same `create_rule` / `view_rule` / `update_rule` / `delete_rule` / `list_rule` checks the records HTTP layer does (extracted into `src/api/_rules.ts`). Deny → 403 with the failing rule name, transaction rolls back. Logged via the existing rule-eval mechanism. Test coverage: `src/__tests__/batch-rules.test.ts` (6 tests).
- [x] **Log-search UI for rule outcomes** — Logs page gets a `Rule outcome` dropdown (All / Any / Allow / Deny / Filter). Backend `GET /api/admin/logs?ruleOutcome=…` filters entries by `rules[].outcome` (`any` matches any-rule-evaluated; explicit values match the named outcome). 5 tests in `logs-rule-filter.test.ts`.

### Migrations

- [x] **Snapshot diff viewer** — `POST /api/admin/migrations/diff` returns `{added, modified, unchanged, removed}` with admin-friendly change strings (`"fields: 1 added, 2 removed"`, `"list_rule changed"`, `"type changed (base → auth)"`). Admin Migrations tab shows a preview panel (PrimeReact `Tag` chips, expandable `<details>` for each modified collection) before Apply; Apply button gated until diff loads.
- [x] **CLI flag for snapshot apply at startup** — `./vaultbase --apply-snapshot=path.json [--snapshot-mode=additive|sync]` (equals + space forms). Apply logic extracted into `src/core/migrations.ts::applySnapshot()` returning `{ created, updated, unchanged, skipped, errors }`; idempotent. Existing `POST /api/admin/migrations/apply` refactored onto the same function (response shape preserved). Bad path / invalid JSON / unknown mode / shape error / per-collection error → stderr + exit code 1, server never starts. 10 tests in `cli-snapshot.test.ts`.

### Cross-cutting

- [x] **`view` collection field-type inference beyond `text`** — `inferViewFields(query)` runs `LIMIT 1` and classifies per column: JS bool → `bool`; number 0/1 with `is_*`/`has_*`/`*_enabled` → `bool`; 10-digit int with `*_at` → `date`; ISO date or unix timestamp string → `date`; `{...}`/`[...]` or JS object → `json`; email regex → `email`; `^https?://` → `url`; else `text`. All-null / no rows → `text` fallback. Wired into `createCollection` (view branch), `updateCollection` (re-infer on query change), and `POST /api/admin/collections/preview-view`. `fieldsFromViewColumns` preserved for other callers. 12 tests in `view-type-inference.test.ts`.
- [x] **`view` collection preview-rows button** — `POST /api/admin/collections/preview-view-rows { view_query, limit? }` runs the query inside a `SELECT * FROM (…) LIMIT N` wrapper (clamped 1–100, default 5) and returns `{ columns, rows }`. Schema editor for view collections has a "Preview 5 rows" button beside "Validate"; results render inline as a compact table with null/JSON-aware cell formatting and a close button. 5 tests in `view-preview-rows.test.ts`.
