# Vaultbase Build Plan — Next 12 Weeks

> Security-first. Every new feature ships with auth, authz, rate limiting, input validation, and tests for the abuse cases in the same PR. No "we'll add auth later." No "MVP without rate limiting." If a task in this list cannot answer "how does an unauthenticated attacker abuse this?" before the PR opens, the task is not ready to merge.

Status conventions:
- `[ ]` not started
- `[~]` in progress
- `[x]` shipped
- `[!]` blocked / decision needed

Each task ends with a **Security checklist** of what must be verified before merge.

---

## Phase 1 — Rule engine parity (week 1, ~5 days)

The single most impactful catch-up item. PocketBase's rule expressiveness is its core moat — closing this gap is a hard prerequisite for everything in Phase 3+.

### 1.1 Parser additions

- [ ] **Add `!~` operator (NOT LIKE)** in `src/core/expression.ts` + filter compiler
  - Add to `OPERATORS` array; map to SQL `NOT LIKE ?` with `%...%` wrapping
  - Update `evaluateExpr` to invert `~` semantics in `looseEq`
  - Tests: `title !~ "spam"` matches records without "spam"

  **Security checklist:**
  - Parameterized binding only — no string concat
  - Pattern wrapping happens server-side (caller can't pass own `%` for ReDoS-via-LIKE)
  - Existing rule-fuzzer test suite must still pass

- [ ] **Add array-prefix operators `?=`, `?!=`, `?>`, `?>=`, `?<`, `?<=`, `?~`, `?!~`**
  - Parser: detect leading `?` in `readOperator`
  - Compile to `EXISTS (SELECT 1 FROM json_each(<col>) WHERE value <op> ?)` for JSON-array fields
  - For relation arrays, join via the relation table
  - Tests: `?=` matches when ANY array element equals; `?!=` matches when ANY element differs

  **Security checklist:**
  - JSON path is parameterized — column name validated via `assertSqlIdent`
  - Relation joins use existing parameterized helpers
  - Reject `?` ops on non-array columns at parse time (prevents bypass attempts)

- [ ] **Modifier syntax: `:isset`, `:changed`, `:length`, `:each`, `:lower`**
  - Extend `readWord` to recognize trailing `:modifier`
  - `Operand` AST adds optional `modifier?: string`
  - `:isset` only valid on `@request.body.*` / `@request.query.*` / `@request.headers.*`
  - `:changed` only valid on `@request.body.*` — needs access to existing record (thread through evaluator)
  - `:length` compiles to `json_array_length(<col>)` for JSON, `length(<col>)` for text
  - `:each` adds an `EXISTS` subquery per element
  - `:lower` wraps both sides in `LOWER()`

  **Security checklist:**
  - `:isset` cannot return server-internal request metadata (only the user-supplied body/query/headers)
  - `:changed` reads only from the diff of the active mutation — no cross-record leakage
  - Modifier validation is whitelist-based (unknown modifier → 422 at rule-save time)

### 1.2 Request-context expansion

- [ ] **Add `@request.method`, `@request.headers.*`, `@request.query.*`, `@request.body.*`, `@request.context`**
  - Parser: extend `@request.` prefix recognition
  - `RuleContext` type includes the active request's method/headers/query/body
  - Header keys lowercased and hyphens→underscores (matches PB)
  - `@request.context` populated by the dispatcher (`default` / `oauth2` / `otp` / `password` / `realtime` / `protectedFile`)

  **Security checklist:**
  - Headers exposed are only the request headers — never response headers, never the JWT secret, never internal config
  - Authorization header is **redacted** before exposure (return `<set>` / `<unset>` only)
  - Cookie header is also redacted
  - Body access bounded to the parsed JSON — no raw stream re-read
  - No way to read `@request.headers.set-cookie` or any internal header

### 1.3 `@collection.*` cross-collection joins

- [ ] **Implement `@collection.<name>.<field>` operand**
  - Parser produces `{ kind: "collection", collection: string, path: string, alias?: string }`
  - SQL compiler emits `EXISTS (SELECT 1 FROM <table> WHERE <correlated-condition>)`
  - Alias support: `@collection.posts:my_posts.author = @request.auth.id`
  - **Hard cap on join depth** = 4 (PB allows 6; we lower the cap to reduce DoS surface)

  **Security checklist:**
  - Collection names validated via `assertSqlIdent` before quoteIdent
  - Joined collection inherits the **calling user's view_rule** on the joined table — no rule bypass
  - DoS protection: cap rule expression nesting depth + total operand count (e.g., 50 operands max)
  - Query-timeout guard (`PRAGMA busy_timeout=2000` already set; add per-statement abort for long rule eval)

### 1.4 Datetime macros + functions

- [ ] **Datetime macros: `@now`, `@yesterday`, `@tomorrow`, `@todayStart/End`, `@monthStart/End`, `@yearStart/End`, `@hour`, `@day`, `@month`, `@year`, `@weekday`, `@second`, `@minute`**
  - Resolve at compile time to a parameter binding (not inline literal)
  - Server timezone fixed to UTC for determinism (admins can override via setting)

- [ ] **`geoDistance(lonA, latA, lonB, latB)` filter function**
  - Compile to inline Haversine using SQLite `acos`/`sin`/`cos`/`radians`
  - Used like: `geoDistance(loc.lon, loc.lat, 13.4, 52.5) < 10`

- [ ] **`strftime(format, time-value, modifiers...)` filter function**
  - Direct passthrough to SQLite's `strftime()`
  - Format string is bound, not inlined

  **Security checklist (all three):**
  - Function arguments parameterized — no SQL injection via format string
  - `geoDistance` args type-checked numeric at parse time
  - Strftime format-string allowlist (reject `%` patterns SQLite doesn't support, no `printf`-style format leaks)

### 1.5 Back-relations `_via_` syntax

- [ ] **`comments_via_post` field path in expand / filter / sort**
  - Compile to LEFT JOIN with the inverse relation
  - Cap result count per back-relation at 1000 (PB-compatible)
  - Apply view_rule of the joined collection on each back-relation row

  **Security checklist:**
  - Joined-collection view_rule enforced — back-relations cannot leak records the caller can't view
  - 1000-row cap is hard, not configurable per-request
  - Filter parser rejects unknown collection / field names with 422 at rule-save time

---

## Phase 2 — JSVM expansion (week 2, ~5 days)

Match PB's hooks ecosystem. Each module wraps Bun primitives. `helpers.*` becomes `$<module>.*` for path-compatible naming.

### 2.1 New JSVM modules

- [ ] **`$dbx`** — read/write query builder for hooks
  - Methods: `select(table).where(...).all()`, `insert(table).values(...).run()`, etc.
  - Built on existing `getDb()` Drizzle instance
  - **All queries traverse the rule engine** — hooks can't bypass authz unless they pass `{ asAdmin: true }` (audited)

- [ ] **`$filesystem`** — read/write under a sandbox prefix
  - Sandbox root = `<dataDir>/hookfs/`
  - Methods: `read(path)`, `write(path, data)`, `list(prefix)`, `delete(path)`, `stat(path)`
  - Path-traversal guard same as `core/storage.ts::safeLocalPath`

- [ ] **`$os`** — minimal env + time helpers; **NO `exec`**
  - `$os.env(name)`, `$os.now()`, `$os.platform()`
  - No shell execution. PB exposes `$os.exec` — we deliberately don't (RCE if a hook is ever served from a less-trusted source)

- [ ] **`$security`** — JWT + crypto helpers
  - `signJwt(payload, opts)` / `verifyJwt(token, opts)` — but **forbid `aud` of `admin`/`user`** (only custom audiences); prevents hook code from minting login tokens
  - `randomString(n)`, `randomBytes(n)`, `hmac(key, data, alg)`, `aes.encrypt/decrypt(key, plaintext)`
  - `bcrypt`/`argon2` re-exports of `Bun.password`

- [ ] **`$template`** — text + HTML rendering
  - Mustache-style or eta — pick one with explicit auto-escaping for HTML
  - Sandbox: no `eval`, no template-injection of arbitrary expressions
  - Rate-limit on render path (DoS via huge templates)

- [ ] **`$http`** — outbound fetch with safety rails
  - Wrapper around `globalThis.fetch`
  - **Egress allowlist** in settings (`security.allowed_egress_hosts` — defaults to `*` but production guides recommend tightening)
  - **SSRF blocklist**: refuses `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16` (cloud metadata), `::1`, `fc00::/7` unless explicitly allowed

- [ ] **`cronAdd(name, schedule, fn)` / `cronRemove(name)`** programmatic cron
  - Backed by existing scheduler
  - Removed on hook re-deploy
  - Per-hook concurrency cap

  **Security checklist (Phase 2 overall):**
  - Each module's API surface documented; everything else is hidden
  - All filesystem/network operations sandboxed by default
  - Hook execution time-limited (configurable, default 5s) to prevent runaway loops
  - Hook memory limit (best-effort via Bun's worker isolation; document the limitation)
  - Egress allowlist + SSRF blocklist tested with: localhost, AWS metadata IP, link-local, IPv6 loopback
  - JWT signing API forbids audience values that would mint login tokens

---

## Phase 3 — Field-level API ergonomics (week 3, ~3 days)

PB's `+`/`-` modifiers + atomic ops + hidden fields.

- [ ] **Atomic number ops: `{ "+counter": 1 }` / `{ "-counter": 1 }`**
  - Parsed at request body level
  - Compile to `UPDATE ... SET counter = counter + ?`
  - Rule eval still runs on the **resulting** value (not the delta)

  **Security checklist:**
  - Counter overflow guarded by SQLite's INTEGER limits + a per-collection optional `max` constraint
  - Negative deltas can't underflow past 0 if `min: 0` is set
  - Rate-limit on atomic ops per (collection, record) to prevent counter-spam

- [ ] **Array append/prepend/remove: `{ "+tags": "x" }`, `{ "tags+": ["x", "y"] }`, `{ "tags-": "x" }`**
  - Same parser hook
  - Tags array clamped to a per-field `maxItems` (default 1000)
  - Dedup option per field (admin-configurable)

  **Security checklist:**
  - Array element type validated against the field schema (no `<script>` smuggled into a relation array)
  - Relation-array updates check the joined collection's view_rule per added id (can't add a relation to a record you can't see)
  - File-array `+` rejects until the file row exists (no orphan link)

- [ ] **`:autogenerate` on text fields with `autogeneratePattern`**
  - Pattern syntax: `[a-z0-9]{8}` / `[A-Z]{4}-[0-9]{4}` / etc.
  - Generated server-side via `crypto.getRandomValues`

  **Security checklist:**
  - Pattern complexity bounded (max 64 chars output, max 256 ops to expand)
  - No user-supplied seeds — always crypto-random
  - Collision retry up to 5 attempts; 422 on exhaustion

- [ ] **Hidden fields**
  - Per-field `hidden: true` flag
  - Stripped from REST responses, kept in admin UI
  - Still readable by hooks + rules

  **Security checklist:**
  - Hidden fields excluded from `expand`, `fields`, list responses, and CSV export by default
  - Audit log entry on every hidden-field READ (so leaks can be traced)
  - Hidden field cannot be renamed without admin re-confirmation

- [ ] **Field help text + admin UI surface**
  - `options.help: string` on every field def
  - Rendered next to label in schema editor + form
  - Sanitized as plain text (no Markdown — prevent stored-XSS in admin)

  **Security checklist:**
  - Help text length capped at 500 chars
  - HTML stripped before storage and on render

---

## Phase 4 — Auth catch-up (week 4, ~5 days)

- [ ] **Configurable identity field for password auth**
  - Setting `auth.<collection>.identity_field` defaults to `email`
  - Login accepts `{ identity, password }`; validates against the configured field
  - Field must be unique-indexed; refuse to enable if not

  **Security checklist:**
  - Username vs email vs phone — same dummy-hash timing fix as the audit
  - Phone field requires E.164 validation
  - Username collision policy (case-insensitive unique)

- [ ] **`emailVisibility` per record**
  - Hidden by default for non-owners + non-admins
  - View-rule predicate: `emailVisibility = true || @request.auth.id = id || @request.auth.type = "admin"`
  - Toggleable by user themselves on their record

  **Security checklist:**
  - Default is hidden (privacy-by-default)
  - Bulk-list responses scrub email when policy denies — even in error responses
  - CSV export respects the same gate

- [ ] **MFA-via-any-two-methods**
  - Currently TOTP-only as second factor; extend to: password + OTP, password + WebAuthn (future), OTP + TOTP, etc.
  - Settings: `mfa.required_methods: 2` and `mfa.accepted_factors: [password, otp, totp, recovery]`

  **Security checklist:**
  - Each factor independently rate-limited (no all-in-one bypass)
  - Recovery codes only count as a factor once per session
  - Same-factor-twice does NOT count as 2-factor

- [ ] **Auth-refresh non-renewable token mode**
  - Current refresh re-signs forever
  - Add `?renewable=0` (or auto-mark impersonation tokens as non-renewable already implicit)
  - Track via a dedicated claim `nbr` (non-renewable) — refresh path rejects if set

- [ ] **Random-password helper in JSVM**
  - `$security.randomPassword(length=16, opts?)` — alphanumeric + symbols
  - Used in scripts that auto-create users

  **Security checklist:**
  - Defaults pass NIST SP 800-63B-4 (≥12 chars, mixed)
  - No `Math.random` — `crypto.getRandomValues` only

- [ ] **Auth alerts mail (`{ALERT_INFO}` placeholder)**
  - Triggered by suspicious login (new IP, new UA, new device-fingerprint hash)
  - Email template with action links
  - Per-user toggle to disable

  **Security checklist:**
  - Device fingerprinting via UA + IP only (no canvas / hardware fingerprinting — privacy)
  - Rate-limit alert mails per user (1 per 10 min)
  - Action links carry one-time tokens

- [ ] **More OAuth providers** — Linear, WakaTime, Notion, monday.com, Instagram, Trakt, Lark, Box.com, X/Twitter (PKCE-required)
  - Each gets a row in the OAuth providers config
  - PKCE required where the provider mandates it
  - id_token JWT validation via `jose` for OIDC providers

  **Security checklist:**
  - Provider client_secrets stored encrypted (settings encryption)
  - Issuer / audience / kid checks on every id_token
  - Redirect-URI allowlist already shipped (audit fix M-7) — applies here

---

## Phase 5 — File / DB / backup polish (week 5, ~3 days)

- [ ] **`?download=1` query param** — forces `Content-Disposition: attachment` regardless of MIME
  - One-line change to `src/api/files.ts`

- [ ] **`store.SetFunc()`-style atomic settings update**
  - Reads → mutates → writes inside a transaction, retries on conflict
  - JSVM exposes `$app.settings.update(fn)`

- [ ] **SQLite cache_size = 32 MB** + WAL checkpoint tuning
  - One PRAGMA at boot

- [ ] **DISTINCT → GROUP BY query optimizer pass**
  - Records list with relation-expand currently uses DISTINCT in the SELECT — convert to GROUP BY for SQLite query-planner friendliness

- [ ] **Full ZIP backup of `vaultbase_data/`** via `/api/admin/backup/snapshot`
  - Streams a ZIP including DB + uploads + settings + logs (configurable)
  - Read-only mode while generating (locks writes via a global semaphore)

  **Security checklist:**
  - Backup endpoint is admin-only (already true)
  - Read-only-mode lock has a 5-min hard timeout (no stuck DB)
  - Stream uses `Bun.file(...)` for memory-bounded transfer
  - ZIP entries' filenames sanitized (no `..` smuggled into archive)

- [ ] **Scheduled backups** via cron + S3 destination
  - Settings: `backup.schedule = "0 3 * * *"`, `backup.destination = "s3://..."`
  - Retains N most-recent (default 7)

  **Security checklist:**
  - S3 creds stored encrypted in settings
  - Backup objects keyed `vaultbase-<host>-<utc-stamp>.zip` (no info leakage)
  - Pre-existing key collision → refuse, don't overwrite

- [ ] **Settings-table encryption at rest**
  - All `vaultbase_settings` values encrypted with `VAULTBASE_ENCRYPTION_KEY` if set
  - Migrate existing plain rows on first start with a key set

  **Security checklist:**
  - Same AES-GCM as the existing encrypted-fields path
  - IV per row, 96-bit
  - Key rotation procedure: new env, restart with `--rotate-encryption=<old-key>`

- [ ] **System collections (`_systemCollections`)** with locked schemas
  - `_admins`, `_users`, `_files`, `_workers`, `_jobs`, etc.
  - Visible in admin under a separate "System" tab
  - Schema not editable — settings yes, but no field changes

---

## Phase 6 — Admin UI rebuild (week 6, ~5 days)

- [ ] **Light/dark theme toggle** — CSS custom properties already token-based; just need a top-level class swap
- [ ] **Mobile-responsive layouts** — flexbox/grid the schema editor + records table
- [ ] **ERD visualization** — render collection graph from snapshot data; SVG + react-flow-style
- [ ] **Search history in records filter bar** — persist to localStorage (per user, last 20)
- [ ] **Bulk JSON export** — sibling to CSV; streaming response
- [ ] **Field help-text rendering** — schema editor + form view
- [ ] **`no_ui` build tag** — `bun build --define=NO_UI=true` skips the embedded admin

  **Security checklist:**
  - LocalStorage-stored search history scrubbed on logout
  - JSON export respects same rule + hidden-field gates as CSV
  - `no_ui` builds still serve `/api/health`; everything else under `/_/` returns 404

---

## Phase 7 — Tier S differentiators (weeks 7-9)

### 7.1 Typed-SDK lead extension (~3 days)

- [ ] **`vb.q\`...\`` filter tag helper** — codegen-aware, autocomplete on field names
- [ ] **Typed expand inference** — template literal type parser, depth cap = 2
- [ ] **Typed batch result tuples** — each `.create/.update/.delete/.get/.list` adds to a tuple type
- [ ] **`vb migrate apply --to=<env>`** — uses the snapshot+diff endpoints

  **Security checklist:**
  - `vb.q` escapes binds via prepared-statement style; never inlines
  - Migrate CLI requires admin token; refuses to overwrite locked fields (settings flag)
  - CLI prints diff and prompts for confirmation by default

### 7.2 Record history / time-travel (~4 days)

- [ ] **`_history` system table** — `id, collection, record_id, snapshot, op, actor_id, actor_type, at`
- [ ] **Per-write trigger** in `core/records.ts` create/update/delete
- [ ] **Per-collection `history_enabled` + `history_ttl_days` settings**
- [ ] **`GET /api/:collection/:id/history?limit=&before=`** — paginated change log
- [ ] **`POST /api/:collection/:id/restore?at=<unix>`** — admin-only rewrite to past snapshot
- [ ] **Admin UI timeline widget** on the record edit page

  **Security checklist:**
  - History reads gated by the same view_rule as the record itself
  - Restore is admin-only AND audit-logged
  - History rows for deleted records are kept (separate retention setting `history_keep_after_delete`)
  - Snapshot column is JSON (no encrypted-field decryption — encrypted values stored as ciphertext in history; restoring requires the encryption key)
  - PII purge: `DELETE /api/admin/history/purge?actor_id=<id>` for GDPR right-to-be-forgotten

### 7.3 ETag + If-Match concurrency (~2 days)

- [ ] **`ETag: "<updated_at>:<rev>"`** on every record GET
- [ ] **`If-Match` on PATCH/DELETE** → 412 Precondition Failed on mismatch
- [ ] **SDK auto-attaches** the cached ETag on update

  **Security checklist:**
  - ETag value is non-secret (just timestamp + counter)
  - 412 response body identical to 404 from a non-existent record (no enumeration via ETag)

### 7.4 Vector search via `sqlite-vec` (~7 days)

- [ ] **Field type `vector`** with `dimensions: 1..4096` option
- [ ] **Loader for the `sqlite-vec` extension** — bundled WASM build, no external compile step
- [ ] **`?nearVector=<json>&nearVectorField=embedding&limit=10`** query param on records list
- [ ] **`helpers.embed(text, model?)`** in JSVM — calls a configured provider (Anthropic/OpenAI/local)
- [ ] **Embedding-on-write** — admin opt-in per field (`auto_embed: { source: "title", model: "..." }`)

  **Security checklist:**
  - Vector field is a binary blob — sanitize length (reject > 4096 dims)
  - Provider API keys encrypted in settings
  - Egress allowlist enforced for embedding API calls (Phase 2 `$http`)
  - Embed-on-write rate-limited per collection (provider quotas)
  - Vector-distance compute capped per query (max scan = 100k records; offer ANN index later)

---

## Phase 8 — Tier A SaaS table-stakes (weeks 10-12)

### 8.1 Outbound webhooks (~3 days)

- [ ] **`_webhooks` collection** — `name, url, events, filter, secret, retries, enabled`
- [ ] **Trigger on record create/update/delete** matching the `events` and `filter`
- [ ] **HMAC `X-Vaultbase-Signature: sha256=<hex>`** with the `secret`
- [ ] **Replay queue** using existing job infra; exponential backoff
- [ ] **Admin UI: webhook log + replay button**

  **Security checklist:**
  - URL allowlist enforcement (same SSRF rules as Phase 2 `$http`)
  - HMAC secret never returned via API after creation (write-only)
  - Replay only by admin; idempotency key generated per delivery
  - Failed deliveries dead-lettered after N retries — visible in admin

### 8.2 Feature flags (~5 days)

- [ ] **`_flags` collection** with `name, type (bool|variant|percentage|segment), default, audience_rule`
- [ ] **`POST /api/flags/evaluate`** body `{ user_id, attributes }`, returns resolved values
- [ ] **`vb.flags.get(name, ctx)`** SDK method with session caching
- [ ] **Admin UI**: rollout slider, kill-switch, per-flag audit log

  **Security checklist:**
  - Audience rule uses the existing rule engine (already hardened)
  - Per-flag audit log entries record old + new value + actor
  - Kill-switch latency < 60s (cache TTL bound)
  - Default value returned on rule-eval error (fail-safe to default, never to "true")

### 8.3 Multi-tenant primitive (~5 days)

- [ ] **Settings: `multi_tenant.enabled = true` + `multi_tenant.field = "tenant_id"`**
- [ ] **Auto-inject `tenant_id` field** on collections marked `tenant_scoped`
- [ ] **Auth tokens carry `tenant_id` claim**
- [ ] **Implicit rule prepend** `tenant_id = @request.auth.tenant_id` on tenant-scoped collections
- [ ] **File storage namespaced** `<tenant_id>/<collection>/<filename>`
- [ ] **Per-tenant backup + restore**

  **Security checklist:**
  - tenant_id field cannot be rewritten by user-level updates (server-set, server-validated)
  - Cross-tenant view via "global admin" role is audit-logged on every access
  - Backup-to-S3 paths include tenant prefix; cross-tenant restore explicitly forbidden via API
  - JWT issuance refuses to set `tenant_id` outside the requesting admin's allowed scope

### 8.4 GraphQL endpoint (~5 days)

- [ ] **Codegen-driven schema** from snapshot — emits SDL at boot
- [ ] **`POST /api/graphql`** — translates to existing REST handlers
- [ ] **Subscriptions over the existing realtime layer**
- [ ] **Introspection** — gated behind admin auth in production (configurable)

  **Security checklist:**
  - Query depth limit (max nesting = 5)
  - Query complexity limit (cost = field count × pagination)
  - Rate limit shared with REST per IP
  - Introspection off by default for unauth callers
  - Persisted-query mode supported (admin uploads a hash-allowlisted query bundle; runtime rejects ad-hoc queries)

---

## Phase 9 — Tier B & beyond (post-12 weeks, prioritize by demand)

- [ ] Audit log of admin actions (~3 days)
- [ ] `vb env push/pull` env-bundle CLI (~4 days)
- [ ] Saved queries / smart views in admin (~3 days)
- [ ] Rule debugger UI (~2 days)
- [ ] Schema versioning + rollback (~7 days)
- [ ] Edge / multi-region replication (~3 weeks; demand-gated)
- [ ] Realtime presence channels (~5 days)
- [ ] Notification fan-out (push/email/in-app) (~5 days)
- [ ] Event sourcing mode for opt-in collections (~10 days)
- [ ] Workflow / step-function primitive (~10 days)

---

## Cross-cutting security work

These run in parallel with every phase. Each has its own merge gate.

### CC.1 Continuous fuzzing

- [ ] **Rule-expression fuzzer** — random AST → render to string → re-parse → assert idempotent
- [ ] **Filter-compiler fuzzer** — random expressions → SQL → execute against in-memory DB → assert no errors / no schema corruption
- [ ] **JWT fuzzer** — random claims → sign → verify → assert never accepts forged tokens

### CC.2 Threat-modeling per phase

Before each phase begins, a 1-page threat model dropped in `docs/threat-models/<phase>.md`:
- Assets at risk
- Adversaries (anon, user, admin, hostile-admin, host-compromise)
- Attack vectors
- Mitigations + residual risk

Already-shipped phases need retroactive threat models. Track as standalone tasks.

### CC.3 Dependency hygiene

- [ ] **Weekly `bun audit` run** in CI; PRs blocked on critical advisories
- [ ] **Monthly upgrade window** for all `^x.y.z` ranges; pin `latest` tags
- [ ] **SBOM (CycloneDX) generation** on every release tag

### CC.4 Penetration test cadence

- [ ] **Shannon run after each phase** with the existing `shannon.config.yaml`
- [ ] **External pentest engagement quarterly**
- [ ] **Bug bounty program** — once user count justifies; documented disclosure policy

### CC.5 Per-PR security checklist (template)

Before merge, the PR description must answer:

```markdown
## Security checklist
- [ ] Authn: how does an unauthenticated user fail this code path?
- [ ] Authz: how does an authenticated non-admin fail this code path?
- [ ] Input validation: what happens with payload size > 10 MB? With nested depth > 100? With non-ASCII / control chars?
- [ ] Output encoding: any user-controlled data returned as HTML, SQL, shell, regex, or path?
- [ ] Rate limit: which rule covers this endpoint? Is the rule registered in `ratelimit.ts`?
- [ ] Logging: PII redacted? Tokens never logged? Audit trail for admin writes?
- [ ] Tests: at least one negative test per attack vector listed above
- [ ] Documentation: is the change visible in `SECURITY.md` if it expands the admin-trust surface?
```

---

## Effort summary

| Phase | Title | Days | Cum |
|---|---|---|---|
| 1 | Rule engine parity | 5 | 5 |
| 2 | JSVM expansion | 5 | 10 |
| 3 | Field ergonomics | 3 | 13 |
| 4 | Auth catch-up | 5 | 18 |
| 5 | File / DB / backup | 3 | 21 |
| 6 | Admin UI rebuild | 5 | 26 |
| 7 | Tier S (typed SDK + history + ETag + vector) | 16 | 42 |
| 8 | Tier A (webhooks + flags + tenant + GraphQL) | 18 | 60 |
| 9 | Tier B (gated by demand) | varies | — |

**~60 focused days to a "PocketBase + everything they refused to ship" release.**

If headcount is one full-time person, that's ~12 calendar weeks at sustainable pace. With one-week security-review buffers between phases, ~14 weeks. Phase 9 lands when the user base demands it.

After this list, the public pitch is honest:

> Vaultbase. PocketBase's API surface, plus typed end-to-end SDKs, record history, ETag concurrency, vector search, feature flags, webhooks, multi-tenant primitives, GraphQL, and a security audit you can read in 5 minutes.

That sentence wins the comparison page.
