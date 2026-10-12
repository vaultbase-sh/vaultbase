# Changelog

All notable changes to Vaultbase. Newest first. Versions before 1.0 follow
[SemVer](https://semver.org/) loosely: a minor bump (0.x.0) may change behaviour
existing installs notice; read the **Upgrade notes** before upgrading.

Binaries, checksums, signatures and SBOMs for every version are on
[GitHub Releases](https://github.com/vaultbase-sh/vaultbase/releases).

## [Unreleased] — 0.17.0

### Upgrade notes

- **Collection rules now default to admin-only.** A rule left out when creating a
  collection — over the API, from the admin's **New collection** dialog, or when
  restoring a migration snapshot — is stored as `""` (admin only). It used to be stored
  as `null`, which is public, so a new collection was readable and writable by anyone
  until someone set its rules. Existing collections keep the rules they have. To make a
  collection public, set `null` explicitly or pick **Public** on the **API rules** tab.
- **Rules can now see the request body.** `@request.body.<field>` was always empty, so
  `:isset` was always false and comparisons against the body always failed. Rules that
  use it now behave as written — check any that only worked because the body was empty.
- **Update rules are checked against the record as it would be after the change**, as
  well as the record as it is now. A rule like `owner = @request.auth.id` no longer lets
  the owner hand the record to someone else in the same request.
- **`expand` follows the related collection's `view_rule`.** Related records the caller
  can't view are left out of `expand` instead of being returned in full.
- **Auth cookies only work on same-origin requests.** `vaultbase_admin_token` and
  `vaultbase_user_token` are ignored on cross-site and same-site (sibling subdomain)
  requests. The admin UI and anything sending `Authorization: Bearer …` are unaffected.
  With the SDK, `authTransport: "cookie"` now only works when your app is served from the
  same origin as Vaultbase; the default, `"both"`, also sends the header and keeps working.
- **Uploaded files are served more strictly.** Only safe raster images are shown inline;
  everything else, SVG included, downloads as `application/octet-stream`. Every file
  response carries `Content-Security-Policy: sandbox`, and stored file extensions now
  come from the validated MIME type rather than the uploaded file name.
- **A fresh install now gates the first-admin endpoint.** `install.sh` generates a
  `VAULTBASE_SETUP_KEY` into `/etc/vaultbase/vaultbase.env`, so `POST /api/v1/admin/setup`
  requires an `X-Setup-Key` header. Bootstrap with `vaultbase setup-admin`, which ignores
  the key. The browser setup page at `/_/` cannot send the header — to use it instead,
  comment the key out, restart, create the account, then uncomment it. Existing installs
  are untouched: the key is only written when the env file is created.
- **Sign-in lockout is on by default and covers users too.** After 10 failed sign-ins in
  15 minutes, the account (and, behind a configured trusted proxy, the client IP) gets
  `429 Too many failed attempts` until the window passes. This applies to admin sign-in,
  which previously shipped with the lockout off, and now also to
  `POST /auth/:collection/login`, which had none. Tune or disable it at **Settings →
  Security → Brute-force lockout** (`auth.lockout.max_attempts`, `0` turns it off). An
  install that had explicitly saved `0` keeps it off.
- **Refreshing a token revokes the old one, and sessions have a maximum age.**
  `POST /auth/refresh` now revokes the token it was called with, so keep the new token
  and drop the old one (the SDK already does). Refreshing the same token again within
  30 seconds — another tab, a retried request — returns the same new token rather than
  an error. Signing out with the old token in that window ends the new one too. A sign-in can be kept alive by refreshing
  for at most 30 days from the original sign-in; after that `/refresh` answers `401` and
  the user or admin signs in again. Set `auth.session.max_seconds` (**Settings → Auth →
  Session lifetimes → Maximum session age**) to change it, `0` for no cap. Anonymous
  sessions are exempt.
- **`/totp/setup` refuses while MFA is on.** To move a user to a new authenticator,
  call `/totp/disable` with a current code, then `/totp/setup` and `/totp/confirm` again.
- **`request-email-change` no longer reports a taken address.** It answers
  `{ "sent": true }` and sends nothing; the old `422 Email already in use` is gone.
- **Admins can only edit their own email and password.** `PATCH /admin/admins/:id` on
  another admin answers `403`, and the **Superusers** page only offers Edit on your own
  row. Reset another admin's password from the server with
  `vaultbase setup-admin --email … --password … --force`.
- **The admin SQL runner runs one statement per query.** A script with several
  statements separated by `;` now answers an error; run them one at a time.
- **MCP `run_sql` writes need the `mcp:admin` scope.** A token with only `mcp:sql` can
  still read; `allow_write: true` now answers with an error unless the token also has
  `mcp:admin` (or `admin`).
- **Regenerating recovery codes needs a current TOTP code.** Send
  `{ "code": "123456" }` to `/totp/recovery/regenerate`; without it the call answers
  `401`. `/totp/confirm` now returns the first set of recovery codes as
  `recovery_codes`, so enrolling doesn't need a separate regenerate call.
- **Re-running the installer now restarts the service.** Previously the binary was replaced
  but the running process kept serving the old one until someone restarted it by hand.

### Added
- **The installer detects the platform.** `curl -fsSL https://get.vaultbase.dev | sh` now works on macOS (Intel and Apple silicon, including from a Rosetta shell) as well as Linux. On macOS it installs the binary only. New `--install-dir` flag.
- **Windows installer.** `irm https://get.vaultbase.dev/install.ps1 | iex` downloads the Windows binary, checks it against `SHA256SUMS`, installs it to `%LOCALAPPDATA%\Programs\Vaultbase` and adds it to the user `PATH`.
- **Queue stats are windowed.** `GET /admin/queues/stats` accepts `?window=<seconds>` (default 24h, clamped to 30d) and each queue now also reports `succeeded_window`, `failed_window`, `dead_window` and `oldest_queued_at`. The all-time `queued` / `running` / `succeeded` / `failed` / `dead` counters are unchanged, so existing callers are unaffected.
- **Collection stats are windowed.** `GET /admin/collections/stats` accepts the same `?window=` parameter, driving `recentWrites`. It previously hardcoded 24 hours.
- **Redesigned admin.** New first-run setup wizard, sign-in screen and dashboard, and a
  token layer that applies the design system across the rest of the admin. The dashboard
  is rebuilt around four live tables — dead jobs, per-queue backlog, top collections and
  recent requests — with a 1h / 24h / 7d range picker backed by the windowed endpoints above.
- The installer grants `CAP_NET_BIND_SERVICE` when `--port` is below 1024, instead of writing a unit that cannot bind.

### Security
- **New collections were public by default.** See the upgrade note above. The admin's
  rule editor also had a bug that saved an "Admin only" rule as public when the
  collection was edited; both are fixed.
- **Filters could read hidden columns.** `filter` and `sort` accepted `password_hash`,
  `totp_secret` and other private auth columns, which let a caller recover them one
  character at a time. They — and any column that isn't a declared field — are now
  rejected as unknown, including through `@collection.*` and `_via_` references.
- **An uploaded file could run as a page on the API's own origin.** A file stored with
  an `.html` name was served as `text/html` even when uploaded as an image, which with
  the admin cookie amounted to admin takeover. See the upgrade note on file serving.
- **The auth cookies could be used from another site.** See the upgrade note above.
- **Rules didn't see the request body, and update rules only checked the old record.**
  Together these let a user write fields a rule was meant to block, or move a record they
  owned to another user. The built-in `notifications` collection's update rule now also
  pins the `user` field.
- **`expand` ignored the related collection's view rule**, returning related records the
  caller wasn't allowed to see.
- **Dropping an index wasn't tied to its collection.** `DELETE
  /admin/collections/:name/indexes/:indexName` only checked the `idx_`/`uniq_` prefix, so
  it could drop any matching index in the database, including the one keeping admin
  emails unique, and the name went into SQL unescaped. It now returns 404 unless the
  index belongs to that collection.
- **View queries could read SQLite metadata.** `pragma_*()` functions and `sqlite_*`
  tables passed the view-query check and could expose the schema and database file path
  through a public view. They are now rejected.
- **OTP sign-in codes could be guessed without limit.** A wrong code was never counted
  against the attempt limit, and requesting a new code left the older ones valid. Each code
  now allows 5 attempts, a new code voids the previous one, used and expired codes are
  never matched, and an address allows 10 failed codes per 15 minutes in total; past that,
  `POST /auth/:collection/otp/auth` answers `429` until the window passes. Both limits
  are charged before the code is compared, so parallel guesses can't race past them.
- **The MFA code limit could be reset by signing in again.** The 5-attempt limit on the
  second step of MFA sign-in was kept per sign-in ticket, so anyone holding the password
  could fetch a new ticket and keep guessing; parallel guesses could also slip past the
  count. Failed TOTP and recovery codes now count per account (10 per 15 minutes, then
  `429`), including on `POST /auth/:collection/totp/disable`, and the counter is updated
  atomically, before the code is checked, so guesses sent in parallel can't get past
  either limit. A TOTP code is accepted once: replaying a code that has just been used is
  refused (and isn't counted as a failed guess). A recovery code or MFA ticket can no
  longer be used twice by sending two requests at the same time.
- **Passwords could be guessed without an account lockout.** User sign-in had no
  per-account limit, only the per-IP rate limit, and the admin lockout was off by default.
  See the upgrade note above. The lockout is also charged before the password is checked,
  so parallel attempts can't slip past it, and it now also guards the password checks in
  `confirm-email-change` and `oauth2/merge-confirm`. The per-IP limit is five times the
  per-account one and is kept separately for admin and user sign-in, so people sharing an
  address can't lock the admin out. `vaultbase setup-admin --force` clears an admin's
  lockout when resetting the password.
- **A victim's inbox could be flooded with reset and sign-in emails.** Password-reset,
  OTP and verification emails were limited only per client IP. Each user now gets at most
  one email of each kind per minute; extra requests to the public endpoints still answer
  `200` but send nothing, and `request-verify` answers `429`. A held-back OTP request
  doesn't void the code that was already sent. `request-email-change`, which mails an
  address the caller chooses, has the same one-a-minute limit (`429`).
- **A stolen token could be kept alive forever.** `/auth/refresh` left the old token
  valid until its own expiry and re-stamped the expiry on every call, with no limit on
  the session's total age. Admin refreshes also didn't appear in **Settings → Security →
  Sessions**, so they couldn't be revoked from there. See the upgrade note above.
- **Promoting a guest account could set protected columns.** `POST
  /auth/:collection/promote` copied every extra body field into the user row, so a guest
  could mark their new email verified, set MFA columns, or change the record's `id`. Only
  the collection's own declared fields are accepted now (the same rule is enforced when
  creating users). Promoting also ends the guest session: the anonymous token stops
  working and the caller keeps the new token from the response.
- **A stolen session could replace an account's TOTP secret.** `POST
  /auth/:collection/totp/setup` overwrote the secret even with MFA already on, with no
  code required, after which the attacker's authenticator passed every MFA check. Setup
  now answers `409` while MFA is enabled; disable it with a current code first.
- **A stolen session could mint new MFA recovery codes.** `POST
  /auth/:collection/totp/recovery/regenerate` needed only a session; it now needs a
  current authenticator code, under the same attempt limit as sign-in.
- **The account lockout could be reset from a look-alike account.** Address lookups are
  case-sensitive, but the lockout was keyed by the lower-cased address, so signing in to
  `VICTIM@example.com` cleared the failures recorded against `victim@example.com`. The
  lockout is now keyed by the account itself.
- **Registration and email change could reveal which addresses have accounts.** Register
  skipped password hashing (and validation) when the address was taken, so the response
  came back measurably faster; both branches now do the same work and validate first.
  `request-email-change` answered "Email already in use" for a taken address; it now
  answers like any other request and sends nothing. Reset, OTP and email-change requests
  no longer wait for the mail server before answering, which made addresses with an
  account measurably slower, and `promote` checks the password before the address.
- **One-time tokens were stored in plaintext.** Password-reset, verification, OTP and
  invitation links, MFA tickets and OAuth merge tokens were kept verbatim in the
  database, so anyone with a copy of it (a backup, read-only SQL access) could use a
  pending reset link. They are now stored as SHA-256 hashes, and an OTP's 6-digit code as
  an HMAC keyed with the server secret. Links issued before the upgrade are re-keyed on
  first start and keep working; OTP codes issued before it stop working (they last ten
  minutes — request a new one).
- **Any admin could take over another admin's account.** `PATCH /admin/admins/:id`
  changed any admin's email and password; it now only changes the caller's own (`403`
  otherwise). A locked-out admin is recovered with `vaultbase setup-admin --force`.
- **The admin SQL time limit never worked.** A query ran on the server's own thread, so
  the 5-second limit couldn't interrupt it and one slow query stalled every other
  request. Queries now run in a separate process (read-only mode) or worker (sandbox) and
  are stopped when the limit is reached. The sandbox also refuses `ATTACH`, `DETACH` and
  `VACUUM`, which could reach the live database or write files outside it, and the
  SQL runner now runs one statement at a time.
- **An `mcp:sql` token could rewrite the database.** The MCP `run_sql` tool's
  `allow_write` flag was the caller's own choice, reads ran on the server's own
  connection (where a `PRAGMA` could change its behaviour for every later request), and
  nothing was audited. Writes now also need the `mcp:admin` scope, reads use a separate
  read-only connection with the 5-second limit, and every call goes to the audit log.

### Fixed
- **The hosted magic-link page now works for accounts with two-factor sign-in.** It used
  the link and then showed "Invalid or expired link", because it didn't know what to do
  with the MFA step. It now asks for the authenticator (or recovery) code and finishes the
  sign-in.
- On Alpine, the installer now installs `libstdc++` and `libgcc`. Without them the musl binary failed to start. On Alpine arm64, where there is no musl build, it stops with a clear message instead of installing a binary that can't run.
- **The installer works on stock Alpine.** It no longer requires `useradd` (from the `shadow` package, absent on Alpine) and falls back to busybox `adduser` / `addgroup`. It also installs `xz` when missing, so musl hosts download the ~30 MB compressed asset instead of the ~100 MB raw binary.
- **`--version`, `--port` or `--install-dir` as the final argument** no longer aborts with `shift: can't shift that many` and exit 2. This hit dash — `/bin/sh` on Debian and Ubuntu, i.e. the documented `curl … | sudo sh` path.
- **A service that fails to start no longer swallows the installer's output.** The summary, the `journalctl` hint and the generated setup key are printed either way; the installer exits non-zero so a wrapper still notices.
- **The installer re-asserts `/etc/vaultbase/vaultbase.env` ownership and mode on every run.** An env file left at `0644` kept the JWT signing key and setup key readable by every local user; re-running is the documented repair path and now actually repairs it.
- **A pre-existing `vaultbase` user with a different primary group** no longer aborts the install with `install: invalid group 'vaultbase'`. The group is created independently of the user, and failures name the fix.
- The installer validates `--port` (1–65535) and requires `--install-dir` to be absolute, rejecting paths under `/home` or `/root` that `ProtectHome=yes` would hide from the service.
- On an upgrade the installer no longer claims `--port` was ignored when it was never passed, and no longer tells you to bootstrap an admin that already exists.
- **The hook editor advertises the real helper surface.** All four scaffolds (record hook, custom route, cron job, queue worker) listed between six and nine helpers and no namespaces; `notify`, `enqueue`, `recordRule`, `uuid`/`id` and all twelve namespaces (`db`, `http`, `security`, `fs`, `flags`, `webhooks`, `mails`, `cron`, `template`, `path`, `util`, `os`) were invisible from the editor.
- Documented `helpers.uuid()` / `helpers.id()`, `helpers.flags.*` and `helpers.webhooks.dispatch()`, which the hooks reference omitted.

## [0.16.0] — 2026-10-11

### Upgrade notes

- **Orphaned files are now deleted.** An hourly sweep removes stored files (and their thumbnails) whose record or collection is gone, whose field was dropped, or that the record's field no longer names, once they are 24 hours old. Collections with record history are skipped. Set `files.orphan_cleanup` to `0` to keep the old behaviour.
- **Request-log files follow data retention.** Daily `logs/*.jsonl` files older than `maintenance.retention_days` (default 30) are deleted. Set it to `0` to keep everything.
- **Changing an admin's password signs that admin out everywhere**, including the session that made the change.

### Added
- **Email change.** `POST /auth/:collection/request-email-change` emails a link to the new address; `confirm-email-change` applies it with the current password, marks it verified and ends existing sessions. SDK: `vb.auth.<collection>.requestEmailChange()` / `.confirmEmailChange()`.
- **Invitations.** `POST /admin/users/:collection/invite` creates a user without a usable password and emails a 7-day link; `accept-invite` sets the password and verifies the email. Admin: **Records → Invite user** on auth collections. SDK: `vb.auth.admin.invite()`, `vb.auth.<collection>.acceptInvite()`.
- Hosted pages for both flows at `/auth/confirm-email-change` and `/auth/invite`.

### Security
- Confirming a password reset didn't end existing sessions, so a stolen token kept working after the owner reset their password. It now does, as does an admin password change.
- The hosted auth pages put the `token` / `collection` query values into an inline script unescaped. The site CSP blocked the injection, but see below.

### Fixed
- The hosted `/auth/reset`, `/auth/verify` and `/auth/otp` pages never worked in a browser: the site-wide CSP (`script-src 'self'`) blocked their inline scripts, leaving a form or spinner that did nothing. Each page now sends its own CSP with a per-response nonce.
- SMTP had no timeouts, so a hung mail server could hold a request open for minutes. Connect and greeting now time out after 15 s.
- Very long request paths and hook log messages are truncated in the log (2 KB / 8 KB).

## [0.15.0] — 2026-10-11

### Upgrade notes

- **Thumbnail variants are capped at 32 per file** for non-admin requests. If your app requests more distinct sizes, formats or qualities than that for one image, the extra ones get the original file (`X-Vaultbase-Thumb: limit`). Thumbnails already cached keep working. List the sizes you use in the field's **Thumbnail sizes** to make the set explicit.

### Added
- **Full-text search.** Mark `text`, `editor`, `email` or `url` fields as **Searchable** (field option `searchable: true`) and query them with `?search=` on the list endpoint. Words are ANDed, the last one matches as a prefix, and matching ignores case and accents. Results are ordered by relevance unless `sort` is set. Search combines with `filter`, pagination, the list rule and `nearVector`. Backed by a SQLite FTS5 index kept in sync by triggers, so every write path updates it. Existing records are indexed when the option is turned on.
- **Image output format and quality.** `?format=webp|jpeg|png|auto` re-encodes an image, with or without `?thumb=`. `auto` returns WebP when the browser accepts it and sets `Vary: Accept`. `?quality=1-100` applies to JPEG and WebP.
- **One-side thumbnails.** `?thumb=800x0` or `?thumb=0x300` keeps the aspect ratio.
- **Allowed thumbnail sizes per file field** (option `thumbs`). Non-admin requests for other sizes get the original file.
- **Aggregations.** `GET /api/v1/:collection/_aggregate?agg=count,sum(amount)&groupBy=status` returns count / sum / avg / min / max, grouped by up to 3 fields or by time buckets (`created:month`). Scoped like a list: filter, search and the list rule all apply. SDK: `collection.aggregate()`.
- **OpenAPI spec.** `GET /api/v1/openapi.json` describes the records, auth and files API as OpenAPI 3.1, generated from the live collections, for Swagger UI / Postman / client generators in any language. Admin-only by default; **API preview → public spec** serves it to anyone, minus admin-only collections.

### Security
- Anyone who could read an image could request unlimited distinct thumbnail sizes, each one a fresh decode and a new cache file. A file now accumulates at most 32 cached variants from non-admin requests; beyond that the original is served.

### Fixed
- `?thumb=WxH&fit=cover` ignored `fit` when it was sent as its own query parameter (the form shown in the docs). Only the `WxH_cover` suffix worked.

## [0.14.0] — 2026-10-11

### Added
- **Scheduled backups.** Settings → Backup & restore can now take snapshots on a cron schedule (UTC, default daily 03:00), keep the newest N (default 7), and optionally copy each one to a private S3-compatible bucket. Stored snapshots can be listed, downloaded, restored and deleted from the same page or via `/api/v1/admin/backups`. In cluster mode only one worker runs each backup.

### Fixed
- `GET /admin/backup` streamed the live database file, which could miss recent writes still in the WAL. It now returns a `VACUUM INTO` snapshot.
- The S3 storage secret (`s3.secret_access_key`) was stored in plaintext even with `VAULTBASE_ENCRYPTION_KEY` set. It's encrypted on the next save.
- Restore could fail on Windows with `EBUSY` because the old database handle wasn't released.

## [0.13.2] — 2026-10-10

### Upgrade notes

- **API tokens are limited to their scopes on the data API.** Records, batch, files, realtime and custom routes used to treat every API token as the admin who created it. Now `admin` keeps full access, `read` can read but not write, `write` can write under collection rules (as a non-admin), and any other scope (e.g. only `mcp:*`) is treated as anonymous. Give a token `read`, `write` or `admin` if it calls these endpoints.
- **API tokens can't be refreshed** (`401` on `/auth/refresh`).
- **File download tokens are not sessions.** They work only on the file download they were issued for.

### Security
- An API token with any scope could act as full admin on records and files, and `/auth/refresh` turned it into an unscoped admin session.
- Sign in with Apple trusted the `id_token` without verifying it. It is now checked against Apple's keys (signature, issuer, audience, expiry).
- Logged-out or deleted users' tokens still worked on the TOTP, recovery-code, email-verify, promote and OAuth2 link/unlink endpoints, and a token from one auth collection was accepted on another's. All now use the central token check.
- Revoked or force-logged-out admin tokens still worked for collection create / update / delete and for impersonation.
- Custom routes accepted revoked tokens.
- A forged API token could overwrite a real token's last-used IP and user agent.
- The `/metrics` bearer token is compared in constant time.

### Changed
- Removed the UPX compression scripts (UPX-packed binaries crash on start). `--help` no longer claims the encryption key can come from a file.

## [0.13.1] — 2026-10-10

### Upgrade notes

- **AVIF uploads are no longer resized.** `?thumb=` on an AVIF file returns the original. AVIF files are still stored and served as before.

### Fixed
- **Image thumbnails in release binaries.** `?thumb=` returned the original file for every format, because the image codecs were not part of the single binary. Thumbnails now use Bun's built-in image engine for JPEG, PNG, WebP and still GIFs, and are generated and cached as intended. Large photos thumbnail in milliseconds instead of most of a second.
- JPEG thumbnails respect EXIF orientation, so phone photos come out upright.
- Animated GIF thumbnails stay animated instead of becoming a still PNG of the first frame.
- PNG thumbnails are compressed. They were written uncompressed, often larger than the source.

## [0.13.0] — 2026-10-10

### Upgrade notes

- **History cleanup.** A daily task deletes finished queue jobs and finished webhook deliveries older than 30 days. Change or disable it in **Settings → Data retention** (`maintenance.retention_days`, `0` keeps everything). Expired token revocations and one-time auth tokens are always cleaned up.
- **ETag format** is now `W/"<updated>-<content hash>"`, so two writes in the same second get different tags. Old `W/"<updated>"` tags still work on `If-Match`; on `If-None-Match` they no longer match (fresh `200` instead of `304`). Treat ETags as opaque.
- **Unique fields.** Adding a unique field to an existing collection works, and switching `unique` on is enforced in the database (`422` over duplicate data). A field created unique together with its collection can't have `unique` switched off in place; drop and re-add it.
- **Delete order.** `restrict` checks, then the `beforeDelete` hook, then cascades. A refusing hook leaves children untouched; cascading deletes are atomic.
- **Batches.** Other record writes wait while a batch runs; its realtime events, webhooks and after-hooks fire only after `COMMIT`.
- **Startup migrations** add timestamp indexes to every collection, file-metadata indexes and three jobs-log columns.

### Added
- Settings → Data retention (`maintenance.retention_days`).

### Fixed
- Collection rename renames the table and indexes and repoints relation fields, hooks and record history.
- Cascading deletes are atomic and run after `beforeDelete`.
- `helpers.enqueue` honours `retries`, `backoff` and `retryDelayMs`.
- Realtime no longer accumulates empty topics; dead sockets are dropped from every topic.
- Dependencies: nodemailer 10 (clears the open Dependabot alerts), elysia 1.4.30, react-router 7.18, DOMPurify 3.4.16.

### Performance
- Record writes ~1.8× faster (hook / webhook / relation lookups cached).
- Default list sort and file lookups use indexes.
- Admin initial load ~5.8 MB → ~1.5 MB (Monaco and Quill load on demand).
- Repeat vector searches ~12× faster (parsed-vector cache).
- Logs page reads only new lines; request logging no longer re-verifies JWTs; each uncached thumbnail is generated once.

## [0.12.0] — 2026-10-10

### Upgrade notes

- **Uploads are capped at 50 MB per request by default** (`413` above it); configurable in Settings → File storage, up to 128 MB.
- **`perPage` is capped at 500**; invalid `page` / `perPage` fall back to 1 / 30.
- **A list rule that can't be evaluated returns `403`** instead of being silently dropped; an invalid `?filter=` returns `400`.
- **Impersonation tokens can't be refreshed** (`403`).

### Fixed
- List rules fail closed: broken or cold-cache rules no longer expose every row.
- Token refresh kept only `id` / `email`, logging every user out; claims are now preserved.
- Batch requests no longer sweep other requests' writes into their transaction; concurrent batches work.
- Webhook deliveries are claimed before sending (no duplicate POSTs); cron jobs run once per slot, also under `vaultbase cluster`.
- Realtime accepts non-browser clients without an `Origin` header again.
- `vaultbase --help` / `--version` exit instead of hanging.

### Changed
- Linux binaries ~118 MB → ~89 MB (Bun 1.4.2, admin UI embedded once), plus `.xz` downloads (~30 MB) that the installer prefers.
- New vb monogram brand in the admin UI.

## [0.11.5] — 2026-05-06
### Security
- Fixes from the 2026-05 audit: MCP `run_sql` write bypass via CTEs, MCP settings scope, records sort identifier validation, trusted-proxy CIDR matching, realtime `Origin` checks, SQL sandbox quoting.

## [0.11.4] — 2026-05-05
### Added
- Built-in HTML pages for `/auth/reset`, `/auth/verify` and `/auth/otp`.
- Server version shown in the admin sidebar, login and setup screens.

## [0.11.3] — 2026-05-05
### Fixed
- MCP write tools, CLI help, secret reveal toggles in the admin.

## [0.11.2] — 2026-05-04
### Fixed
- `setup-admin --force` resets an existing admin's password instead of failing.

## [0.11.1] — 2026-05-04
### Added / Fixed
- Auth hooks, admin records flow for auth collections, collection stats.

## [0.11.0] — 2026-05-04
### Changed
- Auth is a first-class collection: each auth collection has its own `vb_<name>` table with inline auth columns. Tokens minted before 0.11 are rejected; users sign in again.
### Added
- `vaultbase wipe` reset CLI.

## [0.10.2] — 2026-05-03
### Fixed / Added
- Realtime subscriptions keyed by connection id; event-typed topics (`posts.create`, `*.delete`).

## [0.10.1] — 2026-05-03
### Fixed
- Realtime unsubscribe with the wildcard forms (`<col>.*`, `<col>/*`) was a no-op.

## [0.10.0] — 2026-05-03
### Added
- API tokens, a built-in MCP server for AI agents, and a SQL runner with IntelliSense.

## [0.9.1] — 2026-05-03
### Changed
- Admin UI redesign; coral brand accent.
### Fixed
- geoPoint map renders (OpenStreetMap tiles allowed in CSP).

## [0.9.0] — 2026-05-03
### Added
- Push notifications via OneSignal and FCM.

## [0.8.2] — 2026-05-03
### Added
- geoPoint fields shown on a map in the admin (Leaflet + OpenStreetMap).

## [0.8.1] — 2026-05-03
### Fixed
- Remaining `/api/` references moved to `/api/v1/`, including the admin theme loader.

## [0.8.0] — 2026-05-03
### Added
- `vaultbase update`: self-update with SHA-256 and cosign verification.

## [0.7.1] — 2026-05-03
### Fixed / Performance
- Request logs mounted inside `/api/v1`; WAL size capped and optimizer sampling tuned.

## [0.7.0] — 2026-05-01
### Changed
- **Breaking:** the API moved under `/api/v1/`.

## [0.6.1] — 2026-05-01
### Security
- Dependency advisories closed (drizzle-orm SQL identifier escaping, drizzle-kit, Quill pinned).

## [0.6.0] — 2026-05-01
### Added
- Rule-based file protection: per-field rules, one-time and IP-bound tokens, download audit.

## [0.5.0] — 2026-05-01
### Added
- Outbound webhooks with HMAC-signed deliveries and an admin UI.

## [0.4.0] — 2026-05-01
### Added
- Feature flags phase 2–3: WebSocket push, segments, prerequisites.

## [0.3.0] — 2026-05-01
### Added
- Feature flags: evaluation engine and admin UI.

## [0.2.2] — 2026-05-01
### Added
- Admin Theme tab: customizable accent and surface colors.

## [0.2.1] — 2026-05-01
### Fixed
- Disabling MFA now sticks.

## [0.2.0] — 2026-05-01
### Added
- Security settings: sessions, brute-force lockout, trusted proxies, fingerprints.

## [0.1.9] — 2026-05-01
### Fixed
- Admin Updates tab layout.

## [0.1.8] — 2026-05-01
### Changed
- Admin Updates tab redesign.

## [0.1.7] — 2026-05-01
### Added
- CORS settings, password policy, Prometheus metrics, update checker.

## [0.1.6] — 2026-05-01
### Added
- Admin audit log page and hook egress settings.

## [0.1.5] — 2026-05-01
### Added
- Admin actions audit log; `vaultbase backup --to <dest>`; SBOMs and cosign keyless signatures on releases.

## [0.1.4] — 2026-05-01
### Security
- SSRF denylist for `helpers.http`.

## [0.1.3] — 2026-04-30
### Security
- Every admin endpoint verifies tokens through one path; record history encrypted at rest; admin password policy.

## [0.1.2] — 2026-04-30
### Security
- drizzle 0.44.7 and DOMPurify 3.4.2.

## [0.1.1] — 2026-04-30
### Fixed
- imagescript codec patch for single-binary builds; installer resolves the latest release correctly.

## [0.1.0] — 2026-04-30
- First release.
