# Vaultbase Security Audit — 2026-04-30

**Branch:** `security/audit-2026-04-30`
**Scope:** `vaultbase/` server only. SDK / landing / docs / admin SPA out of scope unless they directly affect server security.
**Methodology:** White-box source review against the threat model in the audit prompt; runtime checks where cheap; regression tests for each High/Medium fix landed. No live exploitation.

---

## Executive summary

A prior audit (`SECURITY_AUDIT.md`) catalogued 37 findings. This pass found that **22 of those have been remediated** in `main`, **10 are partial / accepted residuals** (with operator-facing documentation), and **4 had been resolved en passant** by other fixes. One legacy fix had silently regressed across the broader admin surface — that's the headline of this audit.

**Three fixes landed on `security/audit-2026-04-30`:**

1. **N-1 (HIGH)** — 14 admin-API plugins + the records hot path used local `jose.jwtVerify` calls that bypassed the centralized `verifyAuthToken`. This effectively undid the legacy H-8 fix for token revocation everywhere except `/api/auth/*`. Net effect: a revoked / deleted-admin / password-reset-stale JWT was accepted at every admin surface (incl. `/_/metrics` and `/api/batch`) until natural expiry — up to 365 days configurable. Fixed; 5 regression tests on `/_/metrics` exemplar.
2. **N-6a (MEDIUM)** — record history rows stored decrypted plaintext for encrypted-at-rest fields, defeating the encryption-at-rest guarantee for any operator who relied on it. Fixed via re-encrypt-on-write + decrypt-on-read in `core/record-history.ts`; 3 regression tests confirm DB-level ciphertext + API-level plaintext round-trip.
3. **L-1 / L-3 partial (LOW)** — `admins.ts` allowed 8-char passwords (vs. 12 in `auth.ts`) and called `Bun.password.hash` without `HASH_OPTS`. Bumped to 12 + threaded the pinned argon2id parameters.

**Top 3 risks remaining, in order of operator-visible severity:**

1. JSVM helper stdlib (`helpers.http`, `helpers.fs`, `helpers.db`) — admin-trusted code execution surface, no SSRF / fs sandbox. Documented; opt-in egress allowlist remains future work.
2. Cluster mode (Linux/macOS) splits rate-limit token buckets per worker → effective N× the configured limit. Realtime broadcast is also per-worker. Documented; shared-state migration is architectural (deferred).
3. Quill 2.0.3 export-XSS — Low, no upstream patch; admin-only surface.

**Branch state:** four commits, `554/554` tests pass, typecheck clean.

---

## Findings

### [SEV-N-1] HIGH — Admin endpoints bypass `verifyAuthToken`

- **Location:** 14 plugin files: `src/api/{admins,auth-users,backup,batch,csv,hooks,indexes,jobs,logs,metrics,migrations,queues,routes,settings}.ts` + `src/api/records.ts`.
- **Impact:** Each plugin's local `isAdmin()` / `extractAuth()` called `jose.jwtVerify(token, secret, { audience: "admin" })` directly, skipping:
  1. `jti` revocation lookup (`vaultbase_token_revocations`)
  2. `password_reset_at` enforcement on admin rows
  3. Issuer (`iss = "vaultbase"`) check
  4. Principal-row-still-exists check
  Effective regression of legacy H-8. A revoked / deleted-admin / password-reset-stale JWT is accepted at every admin surface until natural expiry (default 7 days, configurable up to 365). Logout client-side does nothing meaningful for these endpoints.
- **Fix:** Every site replaced with a call to the centralized `verifyAuthToken` from `core/sec.ts`. The exception is `logs.extractAuth` (called on every request just for log-row attribution) — kept the thin direct verify but added the issuer check; intentional carve-out documented inline.
- **Commit:** `3301a68` `security(auth): N-1 fix — route every admin endpoint through verifyAuthToken`
- **Regression test:** `src/__tests__/n1-admin-token-revocation.test.ts` — 5 cases driving `/_/metrics`: fresh token (200), revoked jti (401), iat < password_reset_at (401), deleted admin row (401), wrong issuer (401).

### [SEV-N-6a] MEDIUM — Record history snapshots stored plaintext for encrypted-at-rest fields

- **Location:** `src/core/record-history.ts::maybeRecordHistory`
- **Impact:** When a collection has both `history_enabled = 1` and one or more `options.encrypted = true` fields, the history row's `snapshot` JSON contained the **decrypted plaintext** value (the snapshot is the post-write API record shape, already passed through `rowToMetaAsync`). Operators relying on encryption-at-rest for PII (e.g., emails, freeform notes, JSON metadata) had a parallel plaintext copy of every prior version of every encrypted field sitting in `vaultbase_record_history`.
- **Fix:**
  - On write: walk the snapshot per the collection's field definitions; for every value belonging to an encrypted field, re-encrypt via `encryptValue` from `core/encryption.ts` before persistence.
  - On read (`listRecordHistory`, `getHistoryAt`): walk the parsed snapshot, detect `vbenc:1:` prefix via `isEncrypted`, decrypt via `decryptValue` so the API consumer still sees plaintext values.
- **Commit:** `73c0898` `security(history+admins): N-6a + L-1/L-3 …`
- **Regression test:** `src/__tests__/n6a-history-encryption.test.ts` — 3 cases:
  1. DB-level inspection of `vaultbase_record_history.snapshot` confirms ciphertext for encrypted fields.
  2. `listRecordHistory` round-trips back to plaintext.
  3. Live record API shape is unchanged (no regression).

### [SEV-L-1, L-3 partial] LOW — `admins.ts` password policy

- **Location:** `src/api/admins.ts:43, 83, 53, 87` (pre-fix line numbers)
- **Impact:** Admin-create + admin-update accepted 8-character passwords (vs. 12-char floor in `auth.ts::PASSWORD_MIN_LENGTH`); both call sites used `Bun.password.hash(body.password)` without explicit options, allowing a future Bun upgrade to silently downgrade hashing parameters.
- **Fix:** Bumped both to 12 chars via a local `ADMIN_PASSWORD_MIN_LENGTH` constant. `HASH_OPTS` (the pinned `argon2id` config) hoisted from `auth.ts` to `core/sec.ts` so all auth call sites share one source of truth; threaded into both `admins.ts` call sites.
- **Commit:** `73c0898` (same as N-6a)

### [SEV-PARSE] MEDIUM — Defensive `parseFields` (collateral fix)

- **Location:** `src/core/collections.ts::parseFields`
- **Impact:** Every records-API request resolves the collection and parses `col.fields` JSON. A single corrupted DB row (manual edit, partial migration, encoding glitch) would 500 every subsequent call to that collection.
- **Fix:** Wrapped `JSON.parse` in try/catch; returns `[]` on failure with a single-row error log.
- **Plus** top-level `process.on("unhandledRejection")` + `process.on("uncaughtException")` in `src/index.ts` so a stray rejection from a `void asyncFn()` site (log writer, scheduler ticks, queue runners) logs to stderr instead of crashing the process.
- **Commit:** `349a624` `security(error-handling): defensive parseFields + top-level rejection trap`

---

## Status of legacy `SECURITY_AUDIT.md` findings

| ID | Severity (orig) | Status | Evidence |
|---|---|---|---|
| C-1 file upload anonymous writes | Critical | ✅ Fixed | `getAuthContext` + `checkRule` in `src/api/files.ts:128-150` |
| C-2 file delete anonymous calls | Critical | ✅ Fixed | `update_rule` checked on both DELETE handlers |
| C-3 non-protected files world-readable | Critical | ✅ Fixed | `viewRuleAllows` evaluated for every read; orphan files admin-only |
| C-4 WS Origin missing | Critical | ✅ Fixed | `isOriginAllowed` on WS upgrade + SSE GET |
| H-1 token in URL | High | ⚠ Partial / accepted | WS form removed; file `?token=` retained for legacy `<img>` use; documented in `src/api/files.ts:295-300` |
| H-2 login timing enumeration | High | ✅ Fixed | Dummy-hash verify on miss in `auth.ts:304,411` |
| H-3 register email leak | High | ✅ Fixed | Generic 200 + reset-mail to existing owner (`auth.ts:355`) |
| H-4 XFF rate-limit bypass | High | ✅ Fixed | `VAULTBASE_TRUSTED_PROXIES` env (`core/sec.ts:196`) |
| H-5 looseEq NULL bypass | High | ✅ Fixed | `UNAUTH_SENTINEL` + null-only-equals-null in `core/rules.ts` |
| H-6 path-traversal on file GET | High | ✅ Fixed | `isValidStorageFilename` regex + `SAFE_EXT_RE` |
| H-7 file extension allowlist | High | ✅ Fixed | `SAFE_EXT_RE` + `Content-Disposition: attachment` for non-inline-safe |
| H-8 JWT secret + no revocation | High | ✅ Fixed centrally; **regressed everywhere outside auth.ts → resolved by N-1 above** |
| M-1 admin token in localStorage | Medium | Out of scope | Admin SPA — not in this audit's scope |
| M-2 same-origin file serve | Medium | ✅ Fixed | `Content-Disposition: attachment` + `nosniff` + `no-referrer` |
| M-3 CSP / CORS missing | Medium | ✅ Partial | CSP shipped (`core/sec.ts:256`); CORS plugin still absent (operator wires at proxy — documented) |
| M-4 refresh re-validation | Medium | ✅ Fixed | Refresh re-validates principal (`auth.ts:1462`) |
| M-5 setup race + weak password | Medium | ✅ Fixed | `VAULTBASE_SETUP_KEY` env gate + atomic-set + ≥12 chars |
| M-6 PII / token in URL | Medium | ⚠ Partial / accepted | Same as H-1 |
| M-7 OAuth redirectUri allowlist | Medium | ✅ Fixed | `oauth2.<provider>.allowed_redirect_uris` setting |
| M-8 OTP brute-force counter | Medium | ✅ Fixed | `attempts` column + `MAX_OTP_ATTEMPTS` |
| M-9 recovery code timing/DoS | Medium | ✅ Fixed | `mfaRecoveryLookup` HMAC table for O(1) lookup |
| M-10 quoteIdent escape | Medium | ✅ Fixed | `name.replace(/"/g, '""')` |
| M-11 view-query regex bypass | Medium | ⚠ Partial / accepted | Documented as admin-trust |
| L-1 password policy | Low | ✅ Fixed | 12-char floor in `auth.ts` and now `admins.ts` |
| L-2 `/me` re-validates | Low | ✅ Fixed | Uses `verifyAuthToken` with default `recheckPrincipal = true` |
| L-3 argon2id parameters pinned | Low | ✅ Fixed | `HASH_OPTS` in `core/sec.ts`; threaded everywhere |
| L-4 `@types/bun: latest` | Low | ✅ Fixed | Pinned `^1.3.0` |
| L-5 authValue empty-string | Low | ✅ Fixed | Subsumed by H-5 sentinel approach |
| L-6 PII in `console.error` | Low | ⚠ Partial | `redactEmail` exists and is called in some sites; not blanket. Recommended cleanup deferred. |
| I-1 JWT iss claim | Info | ✅ Fixed | `ISSUER` set + verified |
| I-2 `helpers.fetch` SSRF | Info | ⚠ Status quo (admin-trust) | Documented |
| I-3 `helpers.query` user filter | Info | ⚠ Status quo (admin-trust) | Documented |
| I-4 image decoder advisories | Info | ⚠ Open | No worker isolation; single-process. Recommended for follow-up. |
| I-5 Quill 2.0.x XSS | Info | ⚠ Open | No upstream patch (Quill 2.0.3 latest). Admin-auth-only surface. Defer to next major Quill release. |
| I-6 in-process queue worker JS | Info | ⚠ Status quo (admin-trust) | Documented |
| I-7 `.gitignore` strictness | Info | Defer | Add `.env*`, `*.pem`, `*.key` defensively |
| I-8 Astro `site` URL | Info | ✅ Fixed | Now `process.env.DOCS_SITE_URL ?? "https://vaultbase.dev"` |

---

## Workstream 2 findings (new surfaces)

### [SEV-N-2] MEDIUM (status-quo, admin-trust) — JSVM `helpers.http` allows SSRF to cloud metadata + RFC1918

- **Location:** `src/core/hook-helpers-extra.ts`
- **Impact:** Hook / route / cron / worker authors (admin-trusted) can `helpers.http.request({ url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/<role>" })` to exfiltrate AWS / GCP metadata, hit RFC1918 internal services, or reach link-local addresses. Same applies to hooks running queries against intranet endpoints.
- **Recommendation:** Add an opt-in `helpers.http.egress_denylist` (settings-driven) defaulting to RFC1918 + 169.254.0.0/16 + ::1 + fc00::/7. Allow admin override via setting. Ship a `core/hook-egress.ts` module the hook helpers consult before issuing the request.
- **Status:** Document. Operator-side mitigation: run the binary in a Linux network namespace / nftables egress filter that blocks `169.254.0.0/16` + RFC1918 + IPv6-link-local. Already in `SECURITY.md::Hardening checklist for production`.

### [SEV-N-3] MEDIUM (architectural) — Cluster mode splits rate-limit + realtime state per worker

- **Location:** `src/cluster.ts`, `src/api/ratelimit.ts` (token-bucket), `src/realtime/manager.ts`
- **Impact:**
  1. **Rate limit:** Each worker has its own in-memory token bucket. With N workers, an attacker effectively gets N× the configured rate limit on any IP-keyed bucket — login brute-force budget scales with worker count.
  2. **Realtime broadcast:** Connections distribute across workers via SO_REUSEPORT. A write that lands on worker 0 broadcasts only to subscribers on worker 0. Subscribers on workers 1..N-1 miss the event.
- **Recommendation:**
  - Migrate rate-limit bucket to a SQLite-backed token-bucket (one row per `(rule, key)`, atomic UPDATE … RETURNING). Cost: per-request DB write + read; mitigated by short TTL + per-row index.
  - Realtime fanout: write a small `vaultbase_realtime_events` table; each worker tails it via `select * from … where id > last_seen` polled every ~50 ms. Or use a Unix-domain-socket multicast.
- **Status:** Document. Cluster mode is opt-in and Linux/macOS-only; flag in `README.md::Cluster mode (multi-process throughput)`.

### [SEV-N-4] OK — Vector search candidate-window auth

- **Status:** ✅ Verified safe. `listRecords` is called with `auth + filter + accessRule` (`src/api/records.ts:178`). The in-process top-K only re-orders, never adds rows. No bypass.

### [SEV-N-5] OK — ETag check ordering

- **Status:** ✅ Verified safe. `ifMatchFails` is called AFTER `checkRule` on PATCH (line 290) and DELETE (line 321). A stale ETag cannot bypass the auth check; precondition failures only return after auth has already passed.

### [SEV-N-6] OK — Record history admin-only restore

- **Status:** ✅ `POST /:collection/:id/restore` checks `auth?.type === "admin"` server-side. `GET /:collection/:id/history` evaluates the parent's `view_rule` against the live or last-snapshot record.

### [SEV-N-7] OK — `/_/metrics` content + auth gate

- **Status:** ✅ Auth-gated (admin only — fixed by N-1). Histogram labels carry only step names — no per-user / per-collection cardinality leak. SQLite info exposes `page_count` + `wal_pages` — informational, not sensitive.

### [SEV-N-8] OK — Imagescript build-time patch

- **Status:** ✅ The stub only throws lazily on `jpeg.encode_async` / `webp.encode_async` / `gif.encoder` calls. Top-level `import` succeeds. Decoders unaffected. Local-dev tests use the real native module; CI patches before compile only. No runtime safety regression.

### [SEV-N-9] LOW — `vb-migrate` admin token in argv

- **Location:** `sdk-js/src/migrate/bin.ts` (out of audit scope, but called out)
- **Impact:** Admin token passed via `--admin-token <TOKEN>` is visible in `ps aux` to other users on the host. Same for `--password` on `vaultbase setup-admin`.
- **Recommendation:** Prefer `VAULTBASE_ADMIN_TOKEN` / `VAULTBASE_ADMIN_PASSWORD` env vars in CLI argument parsing; document that flags are convenience-only and not for production CI.
- **Status:** Document. Out of audit branch scope (SDK lives in a sibling repo).

### [SEV-N-10] INFO — `install.sh` curl-pipe-sh trust chain

- **Location:** `deploy/install.sh`, served via Cloudflare Worker at `get.vaultbase.dev`
- **Impact:** Inherent to all `curl | sh` patterns. Mitigations in place: HTTPS end-to-end (CF-issued cert at edge; CF Worker fetches `raw.githubusercontent.com/.../main/deploy/install.sh` over HTTPS); SHA-256 sidecars verified for each downloaded binary.
- **Recommendation:** Add `cosign` / `sigstore` signatures to GitHub Releases assets; include `--verify-sig` flag in the install script.
- **Status:** Out of audit scope; document.

### [SEV-N-11] LOW (deps) — Dependency advisories

- **Drizzle ORM 0.44.7** — patched (was 0.44.0).
- **DOMPurify 3.4.2** (admin) — forced via `overrides`; was 3.2.7 transitive.
- **esbuild 0.25.12** — already past CVE patch line (0.25.0+); dev-only.
- **Quill 2.0.3** — latest; export-XSS in HTML export has no upstream patch. Admin-only; LOW; defer.

---

## Residual risks & operator guidance

These cannot be defended against by the binary alone. Operators must configure them. Mirror to `SECURITY.md::Hardening checklist for production`.

1. **TLS termination at the proxy.** Vaultbase ships no TLS itself. Compression + HTTPS belong to nginx / Caddy / Cloudflare in front.
2. **`VAULTBASE_TRUSTED_PROXIES`** must be set when running behind any reverse proxy or rate-limiting / IP-extraction is bypassable.
3. **`VAULTBASE_JWT_SECRET`** must be set explicitly. The `<dataDir>/.secret` fallback is dev-only; loss = all sessions invalidated.
4. **`VAULTBASE_ENCRYPTION_KEY`** required for any field with `options.encrypted = true`. Loss = permanent corruption of the encrypted columns.
5. **`VAULTBASE_SETUP_KEY`** on first boot, then unset after creating the seed admin.
6. **`security.allowed_origins`** set for the admin SPA + user app origins (WS / SSE upgrades reject everything else).
7. **`oauth2.<provider>.allowed_redirect_uris`** for every enabled IdP.
8. **`/etc/vaultbase/vaultbase.env` mode 0640** — installer sets this; verify after manual edits.
9. **Egress firewall** if hooks / routes / cron run untrusted-by-you admin code that you'd rather not let reach metadata services or RFC1918. Document in your runbook for any admin you grant.
10. **Cluster mode multipliers.** N workers = N× rate-limit budget. Tune `*:auth` rule values down if running cluster-mode under public-internet attack pressure, or wait for the shared-bucket implementation.
11. **History rows persist forever by default.** Wire a cron job that calls `pruneHistoryOlderThan(now - 90*86400)` (or your chosen TTL). History rows for encrypted fields are now encrypted at rest (N-6a) but still grow unbounded without retention.
12. **Quill 2.0.3 admin-only XSS.** When the editor renders user content via `getHTML`, sanitise via DOMPurify. Already pinned to 3.4.2 in admin.

---

## Recommended next steps

In priority order:

1. **Next release** — pull this branch (`security/audit-2026-04-30`) into `main` via PR. Cut `v0.1.3`. The N-1 fix is the most operator-visible regression-of-fix item — every operator running `v0.1.0`/`v0.1.1`/`v0.1.2` is exposed.
2. **Within this quarter** — N-2 egress denylist for `helpers.http`. Small (~half day). Adds a settings-driven allow/deny CIDR list, default-deny for RFC1918 + link-local.
3. **Next major** — N-3 shared rate-limit bucket via SQLite for cluster mode. Touches `api/ratelimit.ts` and adds a migration. Pair with a realtime cross-worker fanout via the same DB-tail pattern.
4. **Defer** — N-9 (vb-migrate env-var-first), I-4 image decoder isolation, I-5 Quill upstream watch.

---

## Out of scope (per the audit prompt)

- Performance regressions unless an order of magnitude.
- Style / formatting / non-security refactors.
- Feature additions beyond what's needed to fix a finding.
- SDK / landing / docs (except where they affect server security — covered for `install.sh`).
- Architectural rewrites (N-3 cluster shared state) — flagged in the report; awaiting decision before implementation.

---

## Branch summary

```
main
 └── security/audit-2026-04-30
      ├── 349a624  security(error-handling): defensive parseFields + top-level rejection trap
      ├── fe7c041  security(audit): workstream-1 verify legacy + working list
      ├── 3301a68  security(auth): N-1 fix — route every admin endpoint through verifyAuthToken
      └── 73c0898  security(history+admins): N-6a + L-1/L-3 — encrypt-at-rest in history; admins.ts password policy
```

**Tests:** 554/554 pass. Typecheck clean.
**Files touched:** 22 source + 4 tests + 3 audit docs.
**Net diff:** +730 / −150 across all four commits (rough).

Open the PR.
