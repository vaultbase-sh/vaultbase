# PocketBase Gap Analysis & Roadmap-Beating Plan

**Date:** 2026-04-29
**Sources:** PocketBase docs (pocketbase.io), CHANGELOG v0.22→v0.37, JSVM reference, public roadmap board (project #2 — items live, board itself not directly scrapeable; signals derived from changelog cadence + label `roadmap` + recent merge patterns).

This document lists three things:

1. **Gaps**: features PocketBase ships that Vaultbase doesn't.
2. **PocketBase forward signals**: the patterns of what's landing in `master` and what their next minor releases consistently bring.
3. **My suggestions**: features neither product has that, if Vaultbase ships first, become the deal-closing differentiators.

The structure is "what would make a PocketBase user switch" — not parity-for-parity's-sake.

---

## Section 1 — Gaps (PocketBase has, Vaultbase doesn't)

### 1.1 Rule engine — **CLOSED (2026-04-29)**

All listed items shipped in `src/core/expression.ts`. Phase 1 complete.

| Feature | PocketBase | Vaultbase | Effort | Priority |
|---|---|---|---|---|
| `!~` (NOT LIKE) operator | ✅ | ✅ | XS | **High** |
| Array prefix operators `?=`, `?!=`, `?>`, `?>=`, `?<`, `?<=`, `?~`, `?!~` for multi-value fields (any-of matching) | ✅ | ✅ | S | **High** |
| `:isset` modifier (was-the-field-submitted check) | ✅ | ✅ | XS | High |
| `:changed` modifier (`@request.body.field:changed` — diff vs existing record) | ✅ | ✅ | S | **High** |
| `:length` modifier (count items in file/select/relation arrays) | ✅ | ✅ | XS | Med |
| `:each` modifier (apply condition to every item in array field) | ✅ | ✅ | S | Med |
| `:lower` modifier (case-insensitive string compare) | ✅ | ✅ | XS | Med |
| `@request.method` access | ✅ | ✅ | XS | Med |
| `@request.headers.*` access (lowercased, hyphens→underscores) | ✅ | ✅ | XS | Med |
| `@request.query.*` access | ✅ | ✅ | XS | Med |
| `@request.body.*` access (already submitted form/JSON values inside the rule) | ✅ | ✅ | S | **High** |
| `@request.context` (default / oauth2 / otp / password / realtime / protectedFile) | ✅ | ✅ | S | Med |
| `@collection.*` cross-collection rule joins with `:alias` syntax | ✅ | ✅ | M | **High** |
| Datetime macros `@now`, `@yesterday`, `@tomorrow`, `@todayStart`, `@todayEnd`, `@monthStart`, `@monthEnd`, `@yearStart`, `@yearEnd`, `@hour`, `@day`, `@month`, `@year`, `@weekday`, `@second`, `@minute` | ✅ | ✅ | S | High |
| `geoDistance(lonA, latA, lonB, latB)` filter function | ✅ | ✅ | XS | Med |
| `strftime(format, time, [modifiers...])` SQLite-compatible date formatting in filters | ✅ | ✅ | XS | Low |
| Nested-relation field paths in filters (`someRel.status != "pending"`) | ✅ | ✅ | M | **High** |
| Back-relation reference `comments_via_post` in filters/expand | ✅ | ✅ | M | **High** |

### 1.2 Auth

| Feature | PocketBase | Vaultbase | Effort |
|---|---|---|---|
| Configurable identity field (login by `username`, `phone`, any unique field — not just email) | ✅ | ❌ (email-only) | M |
| OAuth2 all-in-one popup flow on the JS SDK side (single call, no manual redirect handler) | ✅ | ❌ (manual exchange only) | S (SDK-side) |
| OAuth2 providers: Linear, WakaTime, Notion, monday.com, Instagram, Trakt, Lark, Box.com, X/Twitter (with PKCE), Ed25519 OIDC | ✅ many | ✅ Google, GitHub, Apple (PKCE), GitLab, Microsoft, Discord, Twitch, Spotify, LinkedIn, generic OIDC | S each |
| `emailVisibility` per record (toggle email exposure to non-owners) | ✅ | ❌ | S |
| MFA-via-any-two-methods (vs. Vaultbase's TOTP-only second factor) | ✅ | ❌ | M |
| Auth alerts mail with `{ALERT_INFO}` template var | ✅ | ❌ | S |
| Random-password helper exposed in JSVM | ✅ | ❌ | XS |
| Auth refresh nonrenewable-token support (token that refreshes once and never again) | ✅ | ❌ | XS |
| Per-record manageRule (admin-only-but-not-superuser write surface for auth collections) | ✅ | ❌ | S |

### 1.3 Field types & schema

| Feature | PocketBase | Vaultbase | Effort |
|---|---|---|---|
| `:autogenerate` text-field modifier with configurable AutogeneratePattern | ✅ | ❌ | S |
| Field-level `+` / `-` modifiers in API payload (`'+tags': 'TAG_ID'`, `'tags-': 'TAG_ID'`) for in-place mutation of array fields | ✅ | ❌ | M |
| Number field `+` / `-` modifiers (atomic increment/decrement) | ✅ | ❌ | S |
| Hidden fields (admin-visible only, never returned via REST) | ✅ | ❌ | S |
| Help text per field (admin UI) | ✅ | ❌ | XS |
| Indirect-back-references with up to 6-level deep nesting in expand/filter/sort | ✅ | Partial | M |

### 1.4 Files

| Feature | PocketBase | Vaultbase | Effort |
|---|---|---|---|
| `?download=1` query param to force `Content-Disposition: attachment` | ✅ | ❌ | XS |
| Filename sanitization with random 10-char suffix appended | ✅ | Already UUID-prefixed | — |
| `:length` filter on file fields (count) | ✅ | ❌ (covered by 1.1 `:length`) | — |
| Reuploadable-file handle (`filesystem.GetReuploadableFile()` — let hooks edit + re-store) | ✅ | ❌ | S |

### 1.5 Realtime

| Feature | PocketBase | Vaultbase | Effort |
|---|---|---|---|
| Pure SSE since v0.23 (no WS — simpler corp-firewall story) | ✅ SSE-only | ✅ both | We win on transport |
| Realtime context propagation into rule eval (`@request.context = "realtime"`) | ✅ | ❌ | S |

### 1.6 Database / queries

| Feature | PocketBase | Vaultbase | Effort |
|---|---|---|---|
| Raw SQL routing for write queries (`$dbx`-style: hooks can issue arbitrary SQL with auto-routing to writer) | ✅ | Partial (we expose `client.exec` only) | S |
| `store.SetFunc()` concurrent-safe atomic update | ✅ | ❌ | XS |
| SQLite cache_size = 32 MB default | ✅ | ✅ (`db/client.ts` PRAGMA cache_size = -32000) | XS |
| DISTINCT → GROUP BY query optimizer pass | ✅ | ❌ | S |

### 1.7 Backups & operations

| Feature | PocketBase | Vaultbase | Effort |
|---|---|---|---|
| ZIP-archive snapshot of entire `pb_data` (DB + uploads + logs) | ✅ | ❌ (DB-only restore) | M |
| Scheduled backups (cron-driven) | ✅ | ❌ | S |
| Read-only mode while backup is generating | ✅ | ❌ | S |
| Backup to S3-compatible bucket | ✅ | ❌ | S |
| `PB_ENCRYPTION_KEY` for **settings table at rest** (not just encrypted fields) | ✅ | Partial (only encrypted fields) | S |
| `_systemCollections` (`_superusers`, `_mfas`, `_externalAuths`, `_otps`) shown in admin with locked schemas | ✅ | ❌ | M |

### 1.8 Admin UI

PocketBase v0.37 was a complete rewrite. Specific features:

| Feature | PocketBase | Vaultbase | Effort |
|---|---|---|---|
| Dark mode + light mode toggle | ✅ | ❌ (dark only) | S |
| Mobile-responsive layouts | ✅ | Partial | M |
| ERD (entity-relationship diagram) visualization for collections | ✅ | ❌ | M |
| Search history in admin filters | ✅ | ❌ | S |
| Bulk JSON export from records list | ✅ | CSV only | S |
| Live view-query preview with sample data | ✅ | Already shipped | — |
| Help text rendered next to field labels | ✅ | ❌ | XS |
| Inline OAuth2 SVG logos for provider buttons | ✅ | ✅ (`admin/src/components/ProviderLogo.tsx`) | S |
| `no_ui` build tag (compile a binary without admin SPA — server-only deploy) | ✅ | ❌ | S |

### 1.9 JSVM (server-side scripting) parity

PocketBase exposes a much wider JS API surface than Vaultbase's `helpers`.

| Module | PocketBase | Vaultbase equivalent |
|---|---|---|
| `$app` | App lifecycle, services | We have implicit module-global state |
| `$apis` | Route registration, middleware | `routerAdd` ≈ our `/api/custom` routes |
| `$dbx` | Direct DB query builder | ✅ `helpers.db` (query / queryOne / exec / execMulti — bun:sqlite-backed, parameterised) |
| `$filepath` | Path utilities | ✅ `helpers.path` |
| `$filesystem` | Read/write/list, content-type sniffing | ✅ `helpers.fs` (read / readBytes / write / append / exists / stat / list / mkdir / remove / copy / mimeOf) |
| `$http` | Outbound HTTP with retries, headers, body | ✅ `helpers.http` (retries + timeout + JSON convenience); raw `helpers.fetch` still available |
| `$mails` | Compose + send emails with templates, attachments | ✅ `helpers.mails.send` (cc / bcc / replyTo / from / attachments); legacy `helpers.email` retained |
| `$os` | `exec`, `read`, `stat`, `mkdir`, env vars | ✅ `helpers.os` (env / cwd / platform / arch / hostname); fs ops covered by `helpers.fs`; `exec` deliberately omitted |
| `$security` | JWT helpers, random strings, AES, HMAC | ✅ `helpers.security` (hash, hmac, randomString, randomBytes, jwtSign/Verify HS256, AES-GCM, constantTimeEqual) |
| `$template` | Server-side templating (text/html) | ✅ `helpers.template` (`{{var}}` + `{{#if}}…{{/if}}`, `escapeHtml`) |
| `cronAdd` / `cronRemove` | Programmatic cron control | ✅ `helpers.cron.add` / `.remove` / `.list` (writes to `vaultbase_jobs`, invalidates compile cache) |
| `routerUse` | Middleware | Out of scope (admin-managed routes) |
| `sleep`, `unmarshal`, `readerToString` | Utility primitives | ✅ `helpers.util` |
| `$os.exec` | Shell command execution | Deliberately omitted — easy footgun even for admins. Revisit if a concrete need emerges. |

**Effort to close: ~1 week.** Phase 2 closed 2026-04-29 across two shipments
(s1: security / path / template / http / util · s2: db / fs / os / mails / cron).
All in `src/core/hook-helpers-extra.ts` + Monaco TS decl in `admin/src/components/CodeEditor.tsx`. Most of these are wrappers around Bun primitives.

### 1.10 SDKs

| SDK | PocketBase | Vaultbase |
|---|---|---|
| JS / TS | ✅ official (npm `pocketbase`) | ✅ (just shipped — `vaultbase`) |
| Dart | ✅ official | ❌ |
| Swift | Community | ❌ |
| Kotlin / Android | Community | ❌ |
| C# / .NET | Community | ❌ |
| Go | ✅ (it's literally the host) | ❌ (not applicable — Bun host) |
| Python | Community | ❌ |
| Rust | Community | ❌ |

---

## Section 2 — PocketBase forward signals

The roadmap board (`github.com/orgs/pocketbase/projects/2`) doesn't expose its column data via raw HTML, but the changelog cadence + `roadmap` label patterns + recent merged PRs give a clear picture of where v0.38 → v1.0 is heading. Confidence ranges from "shipped in current main" to "publicly announced direction."

### 2.1 High confidence (already in master / pre-release)

These are functionally landed; v0.38 will likely cut them.

- More OAuth2 providers (the cadence is ~2-4 new providers per minor)
- More datetime macros / filter functions (`strftime`, `geoDistance` extensions)
- More JSVM bindings (matching Go-side additions 1:1)
- Continued query optimizer work (the GROUP BY / DISTINCT pass pattern)
- Admin UI polish (mobile fixes, accessibility, theme tokens)
- SQLite version bumps (currently 3.50+; pattern is "follow upstream within a quarter")

### 2.2 Medium confidence (implied by recent PRs)

- **Streaming responses** for large queries (mirroring our streaming CSV)
- **Better record-projection support** via API parameters (record proxies generalized)
- **More auth-collection signals** (sign-up funnel hooks, post-verify hooks)
- **Improved migration UX** (the snapshot-diff pattern we already shipped)
- **Index management improvements** in admin UI
- **Backup encryption** at rest (extending PB_ENCRYPTION_KEY)
- **Per-collection field validation hooks** (custom JS validators beyond schema)

### 2.3 Lower confidence (community asks, not explicitly committed)

- **Plugin / extension marketplace** (often requested in discussions)
- **First-class GraphQL** (community mods exist, no official sign)
- **Multi-tenant / workspace primitives** (heavy ask, no PR signal)
- **Hosted offering** ("PocketBase Cloud") — periodically surfaces, never committed
- **Built-in feature flags** (community plugins exist)
- **Built-in user groups / RBAC matrix** (frequent ask)

### 2.4 What PB has explicitly declined to add

(useful for differentiation)

- **No GraphQL** (Gani has stated REST-only direction)
- **No Redis dependency** (the binary stays single-file)
- **No microservice splitting**
- **No auto-generated types** (PB ships hand-written .d.ts)

---

## Section 3 — Suggestions: where Vaultbase can lap PocketBase

Each item below is something **neither product ships today** and that I think becomes a deal-closer if Vaultbase ships first. Ranked by external-value × build-cost.

### 3.1 Tier S (ship next)

#### Codegen-driven typed SDK (already shipped — keep going)

Vaultbase's `vb-types` snapshot-mode codegen is stronger than anything PB has. Push this further:

- **Typed filter strings**: ✅ shipped 2026-04-29. `vb.q\`title ~ ${q} && status = ${"published"}\`` returns a `Filter`-branded string with values escaped per the server's filter-expression grammar. `field("status")` escape hatch for bare identifiers; rejects undefined / non-finite numbers / unsupported types at runtime. (`sdk-js/src/filter.ts`.) Codegen-aware autocomplete *inside* the tag is deferred — it requires recursive template-literal parsing and adds ~150 LOC of conditional types.
- **Typed expand inference**: still TODO. Defer to next pass — high LOC of recursive conditional types.
- **Typed batch results**: ✅ shipped 2026-04-29. `Batch<S, R>` accumulates a tuple `R` of `BatchOpResult<...>` entries via overloads; `.run()` returns `Promise<R>`. Untyped batches still work via `DefaultSchema` fallback. (`sdk-js/src/batch.ts`.)
- **CLI `vb-migrate`**: ✅ shipped 2026-04-29. Three subcommands — `pull` / `diff` / `apply`. Hits existing `/api/admin/migrations/{snapshot,diff,apply}`. `apply` always diffs first; refuses without `--yes` (CI-safe), supports `--dry-run` and `--mode=additive|sync`. Programmatic API at `vaultbase/migrate`. (`sdk-js/src/migrate/`, bin in package.json.)

#### Time-travel / record history (PB does not have this) — ✅ shipped 2026-04-29

Every record write produces a row in `vaultbase_record_history` for collections with `history_enabled=1`:
- columns: `id, collection, record_id, op, snapshot (JSON), actor_id, actor_type, at`.
- API: ✅ `GET /api/:collection/:id/history` (paged; gated by parent record's `view_rule`).
- Restore: ✅ `POST /api/:collection/:id/restore?at=<unix-seconds>` (admin-only; v1 only restores live records — restoring deleted records returns 409 because `createRecord` mints its own id).
- Per-collection toggle: ✅ `history_enabled` column on `vaultbase_collections` plus exposure on `POST/PATCH /api/collections/...`.
- TTL: ✅ programmatic via `pruneHistoryOlderThan(cutoffUnixSec)` (callable from a cron job — admin schedules retention to taste).
- Admin UI timeline: ⏳ deferred (backend-only this pass).

**Files:** `src/core/record-history.ts`, schema additions in `src/db/schema.ts` + `src/db/migrate.ts`, hook-in points in `src/core/records.ts` (createRecord / updateRecord / deleteRecord), endpoints in `src/api/records.ts`, settings exposure in `src/api/collections.ts`. Tests: `src/__tests__/record-history.test.ts` (8) + `src/__tests__/record-history-api.test.ts` (7).

#### Conflict-aware optimistic concurrency — ✅ shipped 2026-04-29

- `GET /api/:collection/:id` emits `ETag: W/"<updated_at>"` (weak — different projections share a tag).
- `PATCH` / `DELETE` honour `If-Match` (with both weak `W/"…"` and bare `"…"` forms accepted under RFC 7232 weak compare); mismatch → `412 Precondition Failed` with the current ETag echoed back.
- `If-Match: *` matches any existing record.
- `If-None-Match` on `GET` returns `304 Not Modified` for matching tags.
- SDK auto-attaches `If-Match` from a per-record cache (`client.etags`) on `update` / `delete`. `{ ifMatch: false }` opts out; an explicit string overrides the cache. 412 surfaces as `VaultbaseError(kind: "precondition_failed", currentEtag)`.

**Files:** `src/api/records.ts` (recordEtag, parseIfMatch, ifMatchFails); SDK: `sdk-js/src/client.ts` (EtagCache, capture hook), `sdk-js/src/collection.ts` (auto-attach), `sdk-js/src/errors.ts` (new error kind). Tests: `src/__tests__/etag-concurrency.test.ts` (9), `sdk-js/tests/etag.test.ts` (10).

#### Native vector search — ✅ shipped (v1, pure-JS)

- ✅ `vector` field type with `options.dimensions` (1-4096); validated as `number[]` of exact length, rejects non-finite values.
- ✅ Stored as JSON-encoded array via the existing `isJsonField` storage path (no schema change beyond TEXT column).
- ✅ List API accepts `?nearVector=<json>&nearVectorField=<name>&nearLimit=<n>&nearMinScore=<f>`. Honors existing `filter` / list_rule scoping (no leaking rows the caller can't see). Response carries a `_score` field per row in [-1, 1].
- ✅ Pure-JS cosine similarity (`src/core/vector.ts`); good up to ~50K candidates per collection.
- ⏳ Deferred to v2: `sqlite-vec` extension load (constant-time ANN), `helpers.embed()` (admin can invoke any HTTP embed provider via the existing `helpers.http` for now).

**Files:** `src/core/vector.ts` (cosineSimilarity / topK / parseVectorParam), schema/types in `src/core/collections.ts`, validation in `src/core/validate.ts`, JSON-storage flag in `src/core/records.ts`, list-API integration in `src/api/records.ts`. Tests: `src/__tests__/vector.test.ts` (22).

### 3.2 Tier A (ship within the quarter)

#### Workflow / step-function primitive

A new collection-shape called `workflow`:
- Defines steps (each a JS function), branches (conditions), retries, timeouts.
- Runs on the queue infra Vaultbase already has.
- Admin UI shows the running graph + per-step logs.
- Hookable: `onWorkflowStarted`, `onWorkflowFailed`, `onStepCompleted`.

**Why it wins**: replaces Temporal / Inngest for 80% of apps. PB has cron + jobs but no workflow primitive. ~1.5 weeks.

#### Multi-tenant / workspace primitive

Built into the rule engine, not a separate concept:
- A `tenant_id` field auto-injected into every collection (opt-in, settings-driven).
- Auth tokens carry `tenant_id`; rules auto-apply `tenant_id = @request.auth.tenant_id`.
- Admin can see "across tenants" via a separate role.
- File storage namespaced under `<tenant>/` prefix.
- Backups per-tenant.

**Why it wins**: every B2B SaaS that picks PB ends up reinventing multi-tenancy. Shipping it as a flag is huge. ~1 week.

#### First-class GraphQL endpoint (auto-generated)

- Codegen reads the snapshot and generates a complete GraphQL schema (types, queries, mutations, subscriptions for realtime).
- No separate runtime — translate at request time to existing REST handlers.
- `POST /api/graphql` plus a docs introspection endpoint.

**Why it wins**: PB has explicitly declined GraphQL (community asks for it constantly). Vaultbase shipping it makes it the only "no-compromise" option for shops standardizing on GraphQL. ~1.5 weeks.

#### Built-in feature flags

(Already on Vaultbase's roadmap — `docs/future-features/feature-flags.md`.)

Worth pulling forward: most apps have a flag system. Bake it in:
- A `_flags` system collection.
- Per-flag: name, type (bool / variant / percentage / segment), default, audience rules (use the existing rule engine).
- API: `GET /api/flags/evaluate?user=<id>&flags=foo,bar`.
- SDK: `vb.flags.get("new-checkout", { user })` returns the resolved value, cached per session.
- Admin: rollout slider, kill-switch, audit log of flag changes.

**Why it wins**: removes LaunchDarkly / Unleash dependency for the long tail. PB has nothing equivalent. ~1 week.

#### Webhooks (outbound)

- Per-collection webhook config: URL, events (create/update/delete), filter expression.
- Retries with exponential backoff using the queue infra.
- HMAC signature header (`X-Vaultbase-Signature`).
- Admin UI: webhook log + replay button.

**Why it wins**: PB requires hooks-as-code. Webhooks-as-config is what every Zapier-shaped integration actually wants. ~3 days.

### 3.3 Tier B (worthwhile, lower urgency)

#### Built-in audit log

Beyond the existing request log: every admin write (settings change, schema change, user create, hook deploy) → append-only `_audit_log`.
- Filterable by actor / target / action.
- Retention configurable, exportable to S3.

**Why it wins**: SOC2-curious shops can't ship without one. PB has nothing. ~3 days.

#### Per-environment config bundles

`vb env push staging` / `vb env pull prod` — moves schema + settings + hooks + custom routes between environments via signed JSON bundles.
- Codegen integration: same snapshot format.
- Diff before apply (already exists).
- Locked-fields list (don't overwrite production secrets).

**Why it wins**: PB users do this with `pb_data` cp + scripts. Shipping it native makes promotion painless. ~4 days.

#### Saved query / "smart view" UI

Beyond view collections: persist filter-bar state as a named query in the admin (`my-team-active`), shareable URL, embeddable as iframe.

**Why it wins**: makes admin a real ops console, not just a CRUD form. PB has search history (recent addition); we go further. ~3 days.

#### Rule debugger

In admin, on any record: "explain why this rule passed/denied" — shows the parse tree, each operand's resolved value, and the final boolean. Built on the existing `rule_outcome` log.

**Why it wins**: PB rules debugging is "edit rule, save, retry, look at logs." Vaultbase already logs the eval; surface it as a UI view. ~2 days.

#### Schema versioning + rollback

Every collection schema change creates a versioned snapshot in the migration table. Admin: "roll back posts collection to 3 versions ago" → ALTER reverses applied. Risky for type changes; safe for additive.

**Why it wins**: schema mistakes today require manual SQL. ~1 week.

#### Edge / multi-region (deferred forever in PB)

Vaultbase's stack is Bun + SQLite. Litestream-style replication to a follower node + read-only replica selection in front of the rule engine. Single-writer, multi-reader.

**Why it wins**: PB is staunchly single-binary. Vaultbase can stay single-binary AND offer global reads. Stretch goal — only do this if the user base demands it. ~3 weeks.

### 3.4 Tier C (cool but possibly out of scope)

- **Realtime presence channels** (who's-online / cursor-sharing primitives — Liveblocks-style)
- **Built-in notification fan-out** (push / email / in-app from a single API call)
- **Event sourcing mode** for collections that opt in (every write is an event; reads are projections)
- **Geo-fencing rule modifier** (pre-built `geoIn(polygon)` filter using SpatiaLite)
- **Form-builder admin UI** (admin defines a public form → generates the public endpoint + schema validation)

---

## Section 4 — Recommendation

Build order over the next ~6 weeks (one focused person):

| Week | Focus | Why | Status |
|---|---|---|---|
| 1 | **Rule-engine gap closure** (Section 1.1, all "High" + "Med") | Cheap parity win; every PB convert tries `?=` on day 1 and finds it missing. | ✅ Done 2026-04-29 |
| 2 | **JSVM gap closure** (Section 1.9 — `$dbx`, `$filesystem`, `$os`, `$security`, `$template`) | Hooks story instantly matches PB's. | ✅ Done 2026-04-29 |
| 3 | **SDK ergonomics** — `vb.q` typed filter tag · typed batch results · `vb-migrate` CLI | Headline differentiators on the typed-end-to-end pitch. | ✅ Done 2026-04-29 (typed expand inference deferred) |
| 4 | **Record history** + **ETag concurrency** | Beats PB on data stewardship. | ✅ Done 2026-04-29 / 2026-04-30 |
| 5 | **Vector search** (v1 pure-JS) | AI-app deal-closer; PB has nothing. | ✅ Done 2026-04-30 |
| 6 | Webhooks + feature flags (Section 3.2) | SaaS table-stakes. PB lacks them. | ⏭ next |
| 3 | **Section 3.1 / Tier S** kick-off — typed filter helpers + record history | Headline differentiators. |
| 4 | **Record history + ETag concurrency** (Section 3.1) | Beat PB on data stewardship. |
| 5 | **Vector search** (Section 3.1) | AI-app deal-closer. |
| 6 | **Webhooks + feature flags** (Section 3.2) | SaaS table-stakes. PB lacks them. |

After 6 weeks Vaultbase has:
- 100% of PB's rule expressiveness.
- 100% of PB's JSVM surface.
- 4-5 things PB explicitly does not have (typed SDK, record history, ETags, vector search, webhooks, feature flags).
- An honest pitch: "everything PocketBase does, plus the things you'd otherwise leave PB to build."

The combined story to put on `vaultbase.dev`:

> "PocketBase, but typed end-to-end, with record history, vector search, and feature flags built in. Same single-binary deploy. No microservices, no Postgres."

That's the version of the README that gets clicked, starred, and shared.

---

## Appendix — Effort sizing legend

- **XS** — < 4 hours (one-line additions, a regex extension, a config flag)
- **S** — 1 day
- **M** — 2-4 days
- (no XL/XXL needed in this list)

All effort sizes assume one experienced engineer with full context on the existing Vaultbase codebase. They include implementation, tests, admin-UI surfacing where applicable, and docs. Multiply by 1.5x for a fresh contributor.

---

## Appendix — Sources

- PocketBase docs: https://pocketbase.io/docs/
- Authentication: https://pocketbase.io/docs/authentication/
- Collections: https://pocketbase.io/docs/collections/
- API rules: https://pocketbase.io/docs/api-rules-and-filters/
- Files: https://pocketbase.io/docs/files-handling/
- Relations: https://pocketbase.io/docs/working-with-relations/
- Production: https://pocketbase.io/docs/going-to-production/
- JSVM reference: https://pocketbase.io/jsvm/index.html
- Use as framework: https://pocketbase.io/docs/use-as-framework/
- Changelog (v0.22 → v0.37): https://github.com/pocketbase/pocketbase/blob/master/CHANGELOG.md
- Roadmap board: https://github.com/orgs/pocketbase/projects/2 — board itself is JS-rendered and not directly scrapeable from raw HTML; signals derived from changelog cadence + recent PR labels.
