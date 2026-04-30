# Vaultbase Security Audit Plan

**Date:** 2026-04-30
**Scope:** `vaultbase/` server only. SDK / landing / docs out of scope unless
they directly affect server security (specifically: install script served
from `get.vaultbase.dev`).
**Methodology:** White-box source review against a defined threat model;
runtime checks where cheap. No live exploitation.

---

## State of play — existing audit (`SECURITY_AUDIT.md`, 37 findings)

A prior audit catalogued 37 findings (4 Critical, 8 High, 11 Medium, 6 Low,
8 Info). Spot-checks against current `main` show several have been
remediated since:

| Finding | Status (per quick grep) |
|---|---|
| C-1 file upload anonymous writes | **Fixed** — `getAuthContext` + `checkRule` in `src/api/files.ts:128` |
| C-2 file delete anonymous calls | **Fixed** — `update_rule` checked on both DELETE handlers |
| C-4 WS Origin check | **Fixed** — `isOriginAllowed` wired in `src/server.ts` |
| H-2 timing-based email enumeration on login | **Fixed** — dummy `Bun.password.verify` on miss |
| H-4 XFF rate-limit bypass | **Fixed** — `VAULTBASE_TRUSTED_PROXIES` env honoured |
| H-6 path-traversal on `/api/files/:filename` | **Fixed** — `isValidStorageFilename` regex guard |
| H-8 JWT revocation | **Fixed** — `tokenRevocations` table + `isRevoked` check |
| M-10 `quoteIdent` escape | **Fixed** — `replace(/"/g, '""')` |

**Workstream 1** verifies all 37 findings against current `main` and updates
the legacy doc with `STATUS: fixed | open | partial` per item. Items still
open are merged into the new findings list.

---

## New surfaces since last audit (need fresh review)

The repo has shipped several major features since `SECURITY_AUDIT.md` was
written. Each is a new attack surface that the prior doc never touched.

| Surface | Files | Why it matters |
|---|---|---|
| **Record history + restore** | `core/record-history.ts`, `api/records.ts` history/restore endpoints | Admin-only restore; must be enforced server-side. History rows must respect at-rest encryption. |
| **Vector search** | `core/vector.ts`, `api/records.ts` nearVector params | Candidate-window scope: must respect `list_rule` + `filter`. Query vector size sanity. |
| **ETag / If-Match concurrency** | `api/records.ts` recordEtag / ifMatchFails | Bypass risk if precondition runs *before* `checkRule`. Stale-ETag replay against deleted-and-recreated record. |
| **JSVM helpers stdlib** | `core/hook-helpers-extra.ts` | New `fs`, `http`, `db`, `os`, `path`, `cron`, `mails`, `security`, `template`, `util` namespaces. Each is admin-trusted code-execution surface. |
| **Cluster mode** | `cluster.ts`, `index.ts` | Shared state (rate limits, sessions, realtime subs) — per-worker state means N× rate limit. |
| **`/_/metrics` endpoint** | `api/metrics.ts`, `core/perf-metrics.ts` | Must be auth-gated. Must not leak cardinality info about users / collections via labels. |
| **`install.sh` + `get.vaultbase.dev` worker** | `deploy/install.sh`, CF Worker | curl-pipe-sh attack surface. SHA-256 verification chain. Worker upstream trust. |
| **`vb-migrate` CLI + admin bootstrap** | `src/index.ts` setup-admin subcommand, `sdk-js/src/migrate/` | Admin token may pass through argv (visible in `ps`); password too. |
| **Imagescript patch for single-binary** | `scripts/patch-imagescript.ts`, `node_modules/imagescript/codecs/node/index.js` | Build-time replacement of a third-party module — verify the stub does not introduce footguns at runtime. |
| **Drizzle 0.44.0 → 0.44.7 SQL-injection CVE bump** | `package.json`, `bun.lock` | Confirm transitive resolution; verify no other call site uses raw SQL templating. |
| **DOMPurify 3.2.7 → 3.4.2 (admin)** | `admin/package.json` overrides | Admin SPA fixed; verify nothing imports the old version. |

---

## Threat-model coverage map

For each section of the supplied threat model, the audit will visit:

### A. Authentication & sessions

- `src/api/auth.ts` (1500+ lines, primary surface)
- `src/api/admins.ts` (admin CRUD + setup)
- `src/api/auth-users.ts` (user CRUD)
- `src/core/sec.ts` (`verifyAuthToken`)
- `src/core/auth-features.ts`, `src/core/auth-tokens.ts`, `src/core/totp.ts`

**Specific checks:**
1. `jose.jwtVerify` callsites all pin `algorithms: ["HS256"]` — confirm.
2. `setIssuer("vaultbase")` + `verify({issuer: "vaultbase"})` everywhere.
3. `Bun.password.hash` parameters pinned (legacy L-3).
4. MFA TOTP secret column — confirm encryption-at-rest applies.
5. OTP code: hashed at rest + per-token attempt counter (legacy M-8).
6. Recovery-code timing/DoS (legacy M-9) — confirm HMAC lookup lands.
7. Anonymous-auth → cannot be promoted via rule bypass.
8. Admin impersonation: scoped, audit-logged in records-API path, cannot
   chain (admin → impersonate user → impersonate other user).
9. **All 10 OAuth providers** — for each: `state`, PKCE where supported
   (especially Apple's Ed25519 / OIDC nonce), `redirect_uri` allowlist
   (legacy M-7), email-verified gating, account-linking race.

### B. Authorization / rule engine

- `src/core/rules.ts` (`evaluateRule`, `looseEq`)
- `src/core/filter.ts` (`compileToSql`, identifier validation)
- `src/core/expression.ts` (parser — operator confusion / depth)
- `src/api/_rules.ts` (`checkRule`, `recordListRule`)
- All API handlers that call `checkRule` (records, files, batch, history, restore)

**Specific checks:**
1. `looseEq` NULL semantics (legacy H-5) — confirm fix.
2. `:isset` / `:changed` / `:length` / `:each` / `:lower` modifiers — each
   evaluated on the **server-supplied** body (not a value the user can
   spoof from headers).
3. `@request.body` — when used in `update_rule`, does the rule engine see
   the un-merged delta or the merged-with-existing record?
4. `@collection.<other>:<alias>.<field>` joins — does the joined
   collection's `view_rule` get inherited (legacy regression test)?
5. Back-relation `<target>_via_<refField>` — confirm filter-cache is
   keyed on (rule, table, lookup-fn) so a join-target rule change
   invalidates the cached SQL.
6. **Field-level projection (`?fields=`)** — does selecting only `id`
   bypass any field-redaction rule? (No such feature exists today —
   confirm.)
7. **Expand (`?expand=`)** — does the relation target's `view_rule`
   re-evaluate per row, not just at the parent's authorization?
8. **Batch (`/api/batch`)** — confirm each op runs `checkRule` (the
   parity doc flagged this as a gap; verify status).
9. **ETag bypass:** is `If-Match` checked AFTER auth (otherwise a
   precondition failure short-circuits the auth check, leaking
   "this record id exists").
10. **Realtime per-record auth:** confirm `view_rule` re-runs at broadcast
    time, not just at subscribe.
11. **Vector `nearVector`:** confirm `listRecords` is called with `auth`
    + `filter` + `accessRule`, then the in-process top-K only
    *re-orders* — never adds rows.
12. **Record history / restore:** `GET /:collection/:id/history` runs
    `view_rule` against the live or last-snapshot record. `POST .../restore`
    is admin-only — confirm `auth?.type === "admin"` check.

### C. Input validation & query safety

- `src/core/validate.ts` (per-field-type validators)
- `src/core/expression.ts` parser depth / operand caps
- `src/core/filter-cache.ts` keying
- `src/core/collections.ts` (`assertSqlIdent`, `parseFields`)
- `src/db/migrate.ts` (raw SQL — should be DDL only)

**Specific checks:**
1. `parseFields` defensive parse (already shipped Tier 1 fix).
2. Vector-field validation: dimensions sanity, finite numbers, bounded
   length (≤4096 — confirm).
3. JSON field — depth/size bounds via Bun's parse default + post-parse
   check?
4. `vb_<collection-name>` table generation — `assertSqlIdent` regex tight
   enough? Long Unicode names? Reserved SQLite words?
5. `geoDistance` / `strftime` in filter expression — function allowlist
   complete? No way to call arbitrary SQLite functions?
6. ReDoS: every regex in `filter.ts`, `expression.ts`, `validate.ts`,
   `email.ts` — exponential backtracking?

### D. Crypto & secrets

- `src/core/encryption.ts` (AES-GCM)
- `src/config.ts` (JWT secret loader)
- `src/core/sec.ts` (file-token signing)
- `deploy/install.sh` (JWT secret generation)

**Specific checks:**
1. AES-GCM **nonce uniqueness:** `crypto.getRandomValues` for every
   encrypt — but in HOT PATHS (e.g. record history with encrypted fields,
   thousands of writes) is the random source seeded enough to never
   collide? Document the 2^32 birthday-bound caveat.
2. Encrypted-field re-encryption on update — confirm new IV per write
   (no IV reuse on idempotent re-saves).
3. `VAULTBASE_ENCRYPTION_KEY` accepts base64 / hex / 32-char raw — confirm
   the raw 32-char path doesn't downgrade to a weak ASCII subset.
4. JWT secret in install.sh — `head -c 48 /dev/urandom | base64` →
   confirm at least 256 bits, not weak.
5. File `?token=` — HMAC, single audience, scoped to filename + record id.
6. `/etc/vaultbase/vaultbase.env` mode 0640 — confirm install.sh does this.
7. Secrets in error responses + log lines (legacy I-2 / L-6).

### E. Hooks / Routes / Cron / Queues + helpers stdlib

- `src/core/hooks.ts` + `src/core/hook-helpers-extra.ts`
- `src/api/hooks.ts`, `src/api/routes.ts`, `src/api/jobs.ts`, `src/api/queues.ts`

**Specific checks (each helper namespace):**
1. **`fs`** — sandbox? Currently unsandboxed. Document explicitly. Hook
   author can `fs.read("/etc/shadow")` if running root (we install as
   `vaultbase` system user — verify principle of least privilege holds).
2. **`http`** — SSRF guard? Currently none. Hooks can hit
   `http://169.254.169.254/latest/meta-data/iam/...`. Document; consider
   opt-in egress allowlist (legacy I-2).
3. **`os.exec` is NOT exposed** — confirm.
4. **`db`** — exposes raw `bun:sqlite` to hook authors. SQL injection
   inside a hook is the hook author's problem; but confirm the helper
   can't be used to hop into another tenant's data if multi-tenant ever
   ships.
5. **`security.jwtSign` / `jwtVerify`** — does the helper accept
   `algorithms: any` from caller, enabling `alg: none` confusion?
6. **`template.render`** — `{{var}}` substitution; confirm output is NOT
   HTML-escaped (we documented this; verify there is no surprise
   helper that does the wrong thing for HTML emails).
7. **`mails.send`** — attachment names: path-traversal on the recipient
   side? Header injection (`To: x@y.z\nBcc: attacker@evil.tld`)? nodemailer
   handles header sanitization — confirm version is current.
8. **`cron.add`** — admin-only? Currently called from hooks which run as
   admin. Confirm no user-input path can reach it.

### F. File handling

- `src/api/files.ts`, `src/core/storage.ts`

**Specific checks:**
1. C-3 `view_rule` on GET — verify the post-fix `isFileProtected` /
   `view_rule` evaluation chain.
2. M-2 same-origin admin SPA + file serve — confirm
   `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`
   on non-image MIME.
3. S3/R2 backend SSRF — endpoint is admin-configurable; an attacker who
   compromises an admin can set the endpoint to `http://169.254.169.254`
   and read AWS metadata. Document.
4. Image processing OOM — pixel-bomb / decompression bomb against
   imagescript / @jsquash. Single decoder error must not crash the whole
   process. Confirm try/catch in `core/image.ts`.
5. Thumbnail cache poisoning — filename collision (UUID-based) — verify.

### G. Realtime

- `src/realtime/manager.ts`, `src/realtime/sse.ts`, `src/server.ts` `.ws`

**Specific checks:**
1. Origin allowlist (already fixed for WS — confirm same on SSE).
2. Per-record auth filter at broadcast (parity-doc flagged as TODO —
   confirm whether shipped or still open).
3. Subscribing to `*` — anonymous user gets `*`-topic events for null-
   `view_rule` collections, fine; but make sure unauth subscriber CANNOT
   get events for non-null `view_rule` collections.
4. Slow-loris / backpressure on idle WS connections — Bun.serve default
   behavior, document.

### H. Rate limiting & abuse

- `src/api/ratelimit.ts`

**Specific checks:**
1. Token-bucket key: IP-only? (legacy: yes). Add `+account` for login,
   reset, OTP send paths.
2. Per-rule defaults sane for public-internet — review the DEFAULT_RULES
   table.
3. **Cluster mode multiplies rate limits** — workers don't share buckets;
   N workers = N× the limit. Document or implement shared store.

### I. HTTP hygiene

- `src/server.ts` (onAfterHandle headers, securityHeaders)
- `src/core/sec.ts::securityHeaders`

**Specific checks:**
1. CORS plugin — currently absent (legacy M-3). Verify if added; if not,
   document recommended config.
2. CSP on admin SPA shell.
3. HSTS (terminated at proxy — document).
4. Error responses — no stack traces, no SQL fragments, no internal paths.
5. `/_/metrics` auth gate — admin JWT only.

### J. Logging

- `src/api/logs.ts`, `src/core/file-logger.ts`

**Specific checks:**
1. Authorization header NOT logged.
2. Cookie header NOT logged.
3. Request body NOT logged for `/api/auth/*`, `/api/admin/auth/*`,
   `/api/admin/setup`.
4. Encryption key, JWT secret never appear in error logs.
5. Record history rows: encrypted-field values stored encrypted (not
   re-encrypted with a new key — same-key replay is fine, but they MUST
   be encrypted, not plaintext snapshot).

### K. Dependencies / supply chain

- `bun.lock` audit
- `admin/bun.lock` audit
- `imagescript`, `@jsquash/{webp,avif}` advisories
- Install script: TLS, checksum, signing

**Specific checks:**
1. `bun pm audit` clean? (Account for `bun audit` not existing — use
   `npm audit --package-lock-only` against the parallel `package-lock.json`
   if maintained; otherwise crosscheck against GitHub Advisory DB by
   package@version manually.)
2. Quill 2.0.3 export-XSS — Low, no upstream patch — already documented.
3. Install script: `curl -fsSL ... | sh` — script over HTTPS, SHA-256
   sidecars verified. Add doc on the inherent trust delta vs signed
   binaries.

### L. Cluster mode

- `src/cluster.ts`, `src/index.ts` worker branch

**Specific checks:**
1. Per-worker rate limits (above).
2. Realtime subscriptions per worker — connections going to different
   workers means a write event on worker 0 reaches subscribers on
   worker 0 only. Broadcast across workers? (Currently NO — this is a
   correctness bug *and* a security implication: stale "you're not
   subscribed" responses.)
3. SQLite WAL: concurrent writers serialize on file lock — fine. Confirm
   no `INSERT … RETURNING` race that exposes a half-written row.
4. Worker respawn: a crashed worker that held auth state can leak via
   `journalctl`. Confirm the crash path doesn't log secrets.

### M. Admin SPA

- `admin/src/` (read-only audit; out-of-scope for fixes per the
  workstream rules, but noted)

**Specific checks:**
1. Admin token in `localStorage` (legacy M-1) — status?
2. CSP on admin shell.
3. Quill output sanitization (Quill 2.0.3 export XSS — Low).
4. Monaco custom decorations — XSS-safe?

---

## Workstream sequence

1. **W1 — Verify legacy.** Walk `SECURITY_AUDIT.md` top-to-bottom. For each
   finding, grep + read the cited code; mark `STATUS: fixed/partial/open`.
   Output: appended block to `SECURITY_AUDIT.md` and a working list of
   still-open items.
2. **W2 — Audit new surfaces.** Section by section per the table above.
   Output: per-finding entries in working list.
3. **W3 — Triage.** Map each finding to severity and remediation cost.
4. **W4 — Fix Critical/High inline.** One commit per fix on a fresh
   branch `security/audit-2026-04-30`. Tests stay green; never weaken a
   check to make a test pass.
5. **W5 — Document Medium.** Fix where trivial; document the rest.
6. **W6 — List Low / hardening / architectural** in the report; do NOT
   silently rewrite design.
7. **W7 — Final report.** `SECURITY-AUDIT-REPORT.md` at repo root.
   Executive summary, every finding with severity / location / impact /
   fix or recommendation / commit SHA, residual-risk section.

---

## Branch strategy

```
main
 └── security/audit-2026-04-30   ← all fixes here
      ├── security(rule-engine): close looseEq NULL bypass — verify legacy H-5
      ├── security(files): redact tokens in /api/files/.../token logs
      ├── security(realtime): per-record view_rule re-eval at broadcast
      ├── …
      └── docs(security): SECURITY-AUDIT-REPORT.md
```

One commit per logical fix, conventional-commit message starting
`security(area):`, never squashed. PR opens after the report is written.

---

## What the audit will NOT do

Per the user's scope rules:

- No performance regressions unless an order-of-magnitude.
- No style / formatting / non-security refactors.
- No feature additions beyond what's needed to fix a finding.
- No silent rewriting of architectural risks — those go in the report
  with a clear *Recommendation* and wait for explicit go-ahead.
- No SDK / landing / docs changes (out of scope).

---

## Stop condition for this plan

This document is the deliverable for the **plan** phase. The next step
requires explicit go-ahead from the requester before any fix lands. Once
approved I will:

1. `git checkout -b security/audit-2026-04-30`
2. Begin Workstream 1 (verify legacy 37 findings).
3. Push the working list as I go and stop again before any Critical/High
   fix that involves more than a localised one-file change.
