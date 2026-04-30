# Vaultbase Security Audit — Working Findings

**Branch:** `security/audit-2026-04-30`
**Date:** 2026-04-30
**Status:** Workstream 1 (legacy verification) substantially complete; Workstream 2 (new surfaces) discovered a High-severity finding that touches 14 files — paused for direction before fixing.

---

## Workstream 1 — Legacy 37 findings

| ID | Severity (orig) | Status | Notes |
|---|---|---|---|
| **C-1** file upload anonymous writes | Critical | ✅ **Fixed** | `getAuthContext` + `checkRule(create_rule|update_rule)` at `src/api/files.ts:128-150` |
| **C-2** file delete anonymous calls | Critical | ✅ **Fixed** | `update_rule` checked on both DELETE handlers (`src/api/files.ts:386,419`) |
| **C-3** non-protected files world-readable | Critical | ✅ **Fixed** | `viewRuleAllows` evaluated for every read (`src/api/files.ts:298-318`); orphan files admin-only |
| **C-4** WS Origin missing | Critical | ✅ **Fixed** | `isOriginAllowed` on WS upgrade + SSE GET (`src/server.ts:149,191`) |
| **H-1** token in URL | High | ⚠ **Partial / accepted** | WS form removed (header-only); file `?token=` retained for legacy `<img src>` use cases (in-comment justification at `src/api/files.ts:295-300`). Document. |
| **H-2** login timing enumeration | High | ✅ **Fixed** | `Bun.password.verify(.., DUMMY_HASH)` on miss (`auth.ts:304,411`) |
| **H-3** register email leak | High | ✅ **Fixed** | Generic 200 + reset-mail to existing owner (`auth.ts:355`) |
| **H-4** XFF rate-limit bypass | High | ✅ **Fixed** | `VAULTBASE_TRUSTED_PROXIES` env (`core/sec.ts:196`) |
| **H-5** looseEq NULL bypass | High | ✅ **Fixed** | `UNAUTH_SENTINEL` + null-only-equals-null (`core/rules.ts`) |
| **H-6** path-traversal on file GET | High | ✅ **Fixed** | `isValidStorageFilename` regex + `SAFE_EXT_RE` (`api/files.ts:116,232`) |
| **H-7** file extension allowlist | High | ✅ **Fixed** | `SAFE_EXT_RE`, server detected MIME, `Content-Disposition: attachment` for non-inline-safe |
| **H-8** JWT secret + no revocation | High | ✅ **Fixed centrally** | `tokenRevocations` table + `verifyAuthToken` checks `jti` and `password_reset_at`. **BUT see new finding N-1: most admin endpoints bypass this central path.** |
| **M-1** admin token in localStorage | Medium | Need verify | Admin SPA — out of scope for this audit |
| **M-2** same-origin file serve | Medium | ✅ **Fixed** | `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` + `Referrer-Policy: no-referrer` for non-inline-safe (`api/files.ts:328-335`) |
| **M-3** CSP / CORS missing | Medium | ✅ **Partial** | CSP shipped (`core/sec.ts:256`); CORS plugin still absent (operator wires at proxy) |
| **M-4** refresh re-validation | Medium | ✅ **Fixed** | Refresh now re-validates principal (`auth.ts:1462`) |
| **M-5** setup race + weak password | Medium | ✅ **Fixed** | `VAULTBASE_SETUP_KEY` env gate, atomic-set, ≥12 chars (`auth.ts:251-272`) |
| **M-6** PII / token in URL | Medium | ⚠ **Partial** | Same as H-1 — accepted residual for email links |
| **M-7** OAuth redirectUri allowlist | Medium | ✅ **Fixed** | `oauth2.<provider>.allowed_redirect_uris` setting (`auth.ts:64`) |
| **M-8** OTP brute-force counter | Medium | ✅ **Fixed** | `attempts` column + `MAX_OTP_ATTEMPTS` (`auth.ts:469-505`) |
| **M-9** recovery code timing/DoS | Medium | ✅ **Fixed** | `mfaRecoveryLookup` HMAC table for O(1) lookup |
| **M-10** quoteIdent escape | Medium | ✅ **Fixed** | `name.replace(/"/g, '""')` (`core/collections.ts:159`) |
| **M-11** view-query regex bypass | Medium | ⚠ **Partial / accepted** | Documented as admin-trust; `validateViewQuery` blocks the obvious tokens, comments concede this is not a sandbox |
| **L-1** password policy | Low | ✅ **Fixed in auth.ts** (12 chars) — admins.ts:49 still has 8 → minor open |
| **L-2** /me re-validates | Low | Need verify (likely fixed alongside M-4) |
| **L-3** argon2id parameters pinned | Low | ⚠ **Partial** — `auth.ts` has `HASH_OPTS`; `admins.ts:59,93` calls `Bun.password.hash(pw)` without options |
| **L-4** `@types/bun: latest` | Low | ✅ Pinned `^1.3.0` in `package.json:42` |
| **L-5** authValue empty-string | Low | ✅ Fixed by H-5 sentinel approach |
| **L-6** PII in console.error | Low | ⚠ **Partial** — `redactEmail` exists and is called in some sites; not blanket |
| **I-1** JWT iss claim | Info | ✅ Fixed (`ISSUER` set + verified) |
| **I-2** `helpers.fetch` SSRF | Info | ⚠ **Status quo** — still no allowlist; documented as admin-trust; expanded surface (see N-2) |
| **I-3** `helpers.query` user filter | Info | ⚠ **Status quo** — admin-trust |
| **I-4** image decoder advisories | Info | ⚠ **Open** — no thumbnail-worker isolation; still single-process |
| **I-5** Quill 2.0.x XSS | Info | ⚠ **Open** — Quill 2.0.3 is latest; no upstream patch for export-XSS |
| **I-6** in-process queue worker JS | Info | ⚠ **Status quo** — admin-trust |
| **I-7** `.gitignore` strictness | Info | Need verify — `.env*` / `*.pem` |
| **I-8** Astro `site` URL | Info | ✅ Now `process.env.DOCS_SITE_URL ?? "https://vaultbase.dev"` |

**Tally:** 22 Fixed · 10 Partial / status-quo accepted · 4 Need-verify · 1 New-finding-supersedes (H-8 → N-1).

---

## Workstream 2 — New surfaces

### N-1 — Admin API endpoints bypass `verifyAuthToken` (HIGH — supersedes H-8)

- **Severity:** **High** (regression of legacy H-8 fix everywhere except `auth.ts` and `files.ts`)
- **Locations (16 files):**
  - `src/api/admins.ts`
  - `src/api/auth-users.ts`
  - `src/api/backup.ts`
  - `src/api/batch.ts`
  - `src/api/csv.ts`
  - `src/api/hooks.ts`
  - `src/api/indexes.ts`
  - `src/api/jobs.ts`
  - `src/api/logs.ts`
  - `src/api/metrics.ts`
  - `src/api/migrations.ts`
  - `src/api/queues.ts`
  - `src/api/records.ts` (uses local `getAuthContext` that calls `jose.jwtVerify` directly — see also)
  - `src/api/routes.ts`
  - `src/api/settings.ts`
  - (`src/api/auth.ts` is the only correct one; `src/core/sec.ts::verifyAuthToken` exists but is mostly unused.)
- **Description:** Each plugin defines a local `isAdmin(request, jwtSecret)` that calls `jose.jwtVerify(token, secret, { audience: "admin" })` and returns true on success. This skips:
  1. `jti` revocation lookup (`tokenRevocations` table) — a logged-out / revoked token still works at every admin endpoint EXCEPT `/api/auth/*`.
  2. `password_reset_at` enforcement — after an admin resets their password (which bumps `password_reset_at`), pre-existing JWTs should be rejected; they are not.
  3. Issuer check (`iss = "vaultbase"`).
  4. Principal-row-still-exists check — a deleted admin's token works at every admin endpoint until natural expiry.
- **Attack scenarios:**
  1. Admin A is fired; admin B deletes A's row. A's JWT continues working at `/api/admin/admins`, `/api/admin/settings`, `/api/admin/jobs`, `/_/metrics`, `/api/batch`, etc. — every admin surface — until expiry (default 7d, configurable up to 365d).
  2. Admin A's token leaks via XSS, log scraping, or proxy log. Admin A clicks "logout" expecting revocation. The token still works at every admin endpoint.
  3. Admin A resets password to invalidate prior sessions (`password_reset_at` bumped). Old token still works at every admin endpoint.
- **Fix:** Replace each plugin's local `isAdmin` with a call to the centralized `verifyAuthToken` from `core/sec.ts`, requiring `ctx.type === "admin"`. One PR-local commit per affected plugin. Tests cover each.
- **Estimated touch:** 14 files (one-line change each — drop local `isAdmin`, import + call `verifyAuthToken`). Bigger than the plan's "localised one-file change" threshold — pausing for direction.

### N-2 — JSVM `helpers.http` allows SSRF to cloud metadata + RFC1918 (Medium → status-quo by design)

- **Severity:** Medium (admin-trust; documented as residual; still worth opt-in egress allowlist)
- **Location:** `src/core/hook-helpers-extra.ts` — `helpers.http.request`
- **Impact:** A hook author or admin-authored route can `helpers.http.request({url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/<role>"})` and exfiltrate the host's IAM credentials. Same for internal DNS, in-VPC services.
- **Recommendation (not fixing):** Add an opt-in `helpers.http.egress_denylist` (settings-driven) defaulting to RFC1918 + 169.254/16 + ::1 + fc00::/7. Keep admin able to override per call. Document in `SECURITY.md`.
- **Status:** Document.

### N-3 — Cluster mode rate-limit + realtime cross-worker (Medium)

- **Severity:** Medium
- **Location:** `src/cluster.ts` + `src/api/ratelimit.ts`
- **Description:** `Bun.serve({ reusePort: true })` distributes connections across workers. The token-bucket store is per-process — N workers means N× the configured rate limit. Realtime broadcast is per-worker — a write on worker 0 reaches subscribers on worker 0 only.
- **Impact:**
  - Login brute-force budget effectively N× higher than configured.
  - Real-time subscribers can miss events depending on which worker the writer landed on.
- **Fix path:** Move rate-limit bucket to SQLite (token-bucket-in-DB pattern) or a shared-memory IPC. Realtime: worker-to-worker fanout via Unix-domain-socket pub/sub or DB-backed event log.
- **Status:** Document (architectural). Cluster mode is opt-in and already documented as Linux/macOS-only — note this caveat alongside.

### N-4 — Vector search candidate-window auth — verified safe ✅

- **Status:** OK. `listRecords` is called with the same `auth + filter + accessRule` as the non-vector path (`src/api/records.ts:178`). Top-K only re-orders, never adds rows.

### N-5 — ETag check ordering — verified safe ✅

- **Status:** OK. `ifMatchFails` is called AFTER `checkRule` on both PATCH (line 290) and DELETE (line 321). Stale-ETag replay cannot bypass auth.

### N-6 — Record history / restore — verified safe ✅

- **Status:** OK. `POST /:collection/:id/restore` checks `auth?.type === "admin"`. `GET /:collection/:id/history` runs the parent's `view_rule` (or last-snapshot fallback). Encrypted-at-rest fields are stored encrypted in history rows because the snapshot is the post-write record state — already passed through `encodeForStorage`.
- **Caveat:** History snapshots persist encrypted-field plaintext **values** as part of the API record shape (decoded by `rowToMetaAsync`). So `recordHistory.snapshot` JSON contains decrypted values. **This means history rows carry plaintext PII even when the live row is encrypted.** Operators may not expect this. Document or change to store the encrypted form.
- **New finding:** **N-6a — record history snapshots store decrypted plaintext for encrypted fields** (Medium).

### N-7 — `/_/metrics` info leak — admin-gated, content OK

- **Status:** Auth gate present (admin only). Histogram labels carry only step names, no per-user / per-collection cardinality. SQLite info exposes page count + WAL pages — informational, not sensitive.
- **Subsumed by N-1**: the `isAdmin` here also bypasses revocation. Fix lands with N-1.

### N-8 — Imagescript build-time patch — verified safe ✅

- **Status:** Stub only throws lazily on `jpeg.encode_async` etc. Top-level imports succeed. Decoders unaffected. Local-dev tests use the real native module; CI patches before compile only.

### N-9 — `vb-migrate` admin token in argv (Low)

- **Severity:** Low
- **Location:** SDK `sdk-js/src/migrate/bin.ts`, `vb-types` CLI similar
- **Description:** Admin token passed via `--admin-token` flag is visible in `ps aux` to other users on the box. Same for `--password` on `setup-admin` subcommand.
- **Recommendation:** Prefer env var (`VAULTBASE_ADMIN_TOKEN`) over flag. Document.

### N-10 — `install.sh` curl-pipe-sh chain trust (Info)

- **Severity:** Info — inherent to all `curl | sh` patterns
- **Status:** Script is served over HTTPS (CF-issued cert), CF Worker fetches from raw GitHub `main` branch (also HTTPS). Binaries verified by SHA-256 sidecar. No code-signing yet; published binaries on GitHub Releases trust the Actions-runner identity.
- **Recommendation:** Add cosign / sigstore signatures to releases. Out of audit scope.

### N-11 — `bun.lock` audit (Info)

- **Status:** Drizzle bumped to 0.44.7 (CVE patched). DOMPurify forced to 3.4.2 in admin via `overrides`. Quill 2.0.3 export-XSS — no upstream fix; admin-only surface.

---

## Pause point — direction request

**Workstream 1** is substantially complete (status of 37 legacy findings tabled above).

**N-1 (HIGH) is the headline finding** of Workstream 2. It restores the protection of legacy H-8 (token revocation) across the entire admin API surface. Proposed fix touches 14 files but each change is mechanical: replace local `isAdmin(request, secret)` with a call to `core/sec.ts::verifyAuthToken` checking `ctx.type === "admin"`.

**Risk of NOT fixing:** Every admin endpoint accepts revoked tokens, deleted-admin tokens, and password-reset-stale tokens until natural expiry (up to 365 days configurable). This regresses the entire H-8 fix everywhere outside `auth.ts`.

### Options

**(A) Ship the N-1 fix now in this branch** — single commit, one mechanical pass across 14 plugin files, regression test that confirms a revoked admin token is rejected at `/_/metrics` (exemplar). Tests stay green; if any test asserts the old broken behavior, flag and pause.

**(B) Document N-1 in the report and defer fix** — mark as Critical/High residual, owner decides to live with it until next release.

**(C) Audit deeper before fixing** — finish Workstream 2 N-3..N-11 verification end-to-end first, then fix.

Recommend **(A)** — N-1 is a regression of an already-fixed issue, mechanical, with a regression-test path. Want me to proceed with the fix on this branch?
