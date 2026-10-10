# Changelog

All notable changes to Vaultbase. Newest first. Versions before 1.0 follow
[SemVer](https://semver.org/) loosely: a minor bump (0.x.0) may change behaviour
existing installs notice; read the **Upgrade notes** before upgrading.

Binaries, checksums, signatures and SBOMs for every version are on
[GitHub Releases](https://github.com/vaultbase-sh/vaultbase/releases).

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
