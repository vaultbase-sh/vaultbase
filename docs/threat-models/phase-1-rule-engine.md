# Threat Model — Phase 1: Rule Engine Expansion

**Date:** 2026-04-29
**Scope:** Changes to `src/core/expression.ts`, `src/core/filter.ts`, `src/core/rules.ts`, `src/api/_rules.ts`.
**Authors:** initial draft.

## Assets

1. **Per-record data** — protected by `view_rule` / `list_rule` evaluation.
2. **JWT secret** — must never be readable from a rule.
3. **Authorization / Cookie / setup keys** — must never be readable from a rule.
4. **DB integrity** — rules compile to parameterized SQL only. No DDL, no unparameterized identifiers.

## Adversaries

| | Capability | Trust |
|---|---|---|
| Anonymous | Issue arbitrary HTTP requests; no auth header | None |
| Authenticated user | Holds a `user`-aud JWT; can read records subject to `view_rule` | Limited |
| Hostile admin | Holds an `admin`-aud JWT; can author rules + hooks + custom routes | Operator-equivalent (by design) |
| Host compromise | Reads `.secret`, `vaultbase_data/`, JWT signing key | Total |

The rule engine defends against the first two. The third is accepted-trust (admin = operator). The fourth is out of scope.

## Attack vectors and mitigations

### 1. SQL injection via field / collection / table identifier

**Vector:** A user-controlled name (collection rename, schema editor) flows into raw SQL via `quoteIdent()`.

**Mitigation:**
- `IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/` checked at compile time inside `filter.ts::compileToSql`, `compileFieldRef`, `compileCollectionRef`.
- Schema-editor write path validates names (Phase 0 audit fix M-10 + the new `assertSqlIdent`).
- `quoteIdent` doubles `"` characters even after validation (defense in depth).

**Residual risk:** Negligible. A failure here would require the validator to be bypassed AND `quoteIdent` to also be patched out.

### 2. Unparameterized values

**Vector:** Literal / auth / macro values reach the SQL string directly instead of the binds array.

**Mitigation:**
- All operand emit paths in `compileOperand` push to `ctx.params` and emit `?`. No path emits literal values into the SQL string (audit `git grep "ctx.params" src/core/filter.ts`).
- Functions (`geoDistance`, `strftime`) only embed compiled operand expressions, which themselves are `?` placeholders.

**Residual risk:** Low. Reviewed line-by-line; covered by the rule-fuzzer tests.

### 3. Sensitive header leak via `@request.headers.*`

**Vector:** Rule author writes `@request.headers.authorization = "Bearer X"` and uses it as an authorization side-channel.

**Mitigation:**
- `buildRequestContext` strips `authorization`, `cookie`, `set-cookie`, `x-setup-key`, `x-api-key`, `x-auth-token`, `proxy-authorization` headers entirely BEFORE the rule engine sees them.
- Rules referencing redacted headers see them as unset (`@request.headers.authorization = "X"` is always false).
- Test `Phase 1 — security: header redaction is caller's responsibility` documents the contract; this is enforced at the boundary.

**Residual risk:** A new sensitive header (e.g., `x-csrf-token`) added in the future may leak if `REDACTED_HEADERS` isn't updated. Mitigated by code-review checklist + a follow-up CI lint that flags new header lookups.

### 4. DoS via deeply nested or huge expressions

**Vector:** Attacker submits a rule (or filter param) with thousands of operands, deeply nested parens, or pathological backtracking.

**Mitigation:**
- `MAX_OPERANDS = 50` and `MAX_DEPTH = 32` enforced in `expression.ts`.
- Rule body capped at 4096 characters.
- `parseExpression` returns `null` on any exception, so failed parses deny by default.

**Residual risk:** A single 50-operand rule executed many times can still drive CPU. Mitigated by per-IP rate limiting + the SQLite `busy_timeout` already in place.

### 5. Cross-collection rule leak (`@collection.*`)

**Vector:** Rule on collection A reads records from collection B that the caller cannot see.

**Mitigation:**
- In-process eval (single-record `view_rule`) returns `null` for `@collection.*` references — denies conservatively.
- SQL filter compilation joins via `vb_<collection>` table directly. **Future hardening (Phase 1.x):** wrap the joined subquery with the joined collection's own `view_rule` so cross-collection joins respect target authz.

**Residual risk:** Currently the SQL path does NOT inherit the joined collection's view_rule. Tracked as a Phase 1.x follow-up. For now, document that `@collection.*` is admin-trust only (rules using it should not be authored without checking the joined view_rule manually).

### 6. `:isset` / `:changed` exposing internal state

**Vector:** A rule author uses `:isset` to fingerprint server internal headers or body keys not under the user's control.

**Mitigation:**
- `:isset` is only valid on `@request.headers.*`, `@request.query.*`, `@request.body.*` — all of which originate from the caller's own request.
- Header redaction (vector 3) prevents `:isset` from probing redacted keys (always returns false).
- `:changed` only sees `@request.body.*` and is bounded to the diff between caller-supplied body and the existing record. No internal state escapes.

**Residual risk:** Negligible.

### 7. Function injection via `geoDistance` / `strftime`

**Vector:** Attacker writes a rule with a malicious format string for `strftime` to coerce SQLite into unexpected behavior.

**Mitigation:**
- `ALLOWED_FUNCS` is a hard allowlist (`geoDistance`, `strftime`).
- All function arguments are compiled through `compileOperand` and bound as parameters.
- `strftime` format string is bound as a parameter, not concatenated into the SQL. SQLite's `strftime()` accepts only its documented format codes; unknown codes return null but cannot pivot to other SQL.

**Residual risk:** SQLite's `strftime` has surface area; we accept the upstream guarantees. No known SQLi via `strftime` format strings exists in current SQLite versions.

### 8. Macro evaluation injects volatile data

**Vector:** Attacker uses `@now` in a way that depends on server clock for replay. Or `@year` returning a value inconsistent with SQL evaluation.

**Mitigation:**
- All macros resolve to a parameter binding (not inline literal).
- Server clock is the trust boundary; the same `@now` value is used for both SQL and JS evaluation paths within a single rule eval.
- Rule fuzzer covers macro-roundtrip.

**Residual risk:** Negligible.

### 9. Array-prefix `?=` / `?~` exhaustion via huge arrays

**Vector:** Attacker submits a record with a 100k-element array, then uses `?=` to scan it.

**Mitigation:**
- Field-level `maxItems` cap (Phase 3 — `:length`-aware schema validator); for now, `noUncheckedIndexedAccess` + per-field schema enforcement at write time prevents pathological array sizes.
- SQLite's `json_each` is iterative; no quadratic explosion.

**Residual risk:** Until Phase 3 ships per-field array caps, an admin-misconfigured collection could allow huge arrays. Document in operator runbook.

## Assumptions

- Rule writers are admins (operator-trust). Non-admins never author rules; they only trigger evaluation.
- The host process runs in a dedicated UID with `0600` on `vaultbase_data/.secret`. Phase 0 audit fix.
- The DB is SQLite via `bun:sqlite`. Extension loading is disabled by default.

## Out of scope

- DoS at the network layer (Cloudflare / WAF)
- Side-channel timing attacks on rule evaluation (every rule path is short; we don't attempt constant-time)
- Hostile-admin attacks (admin = operator-equivalent — see `SECURITY.md`)

## Verification

- 26 new tests in `src/__tests__/rules-extended.test.ts` cover every operator + modifier + macro + DoS guard + redaction contract.
- 454/454 total tests passing after Phase 1 changes.
- TS strict mode with `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` enforced; no `any` introduced.

## Open follow-ups

- [x] Phase 1.x — `@collection.*` SQL path inherits the joined collection's view_rule via the `CollectionLookup` callback wired into the records list path. Non-admin callers without a lookup get a conservative `1=0` guard; with a lookup, the joined collection's `view_rule` is recursively compiled and ANDed into the subquery.
- [x] Phase 1.x — `_via_` back-relation expansion. `<targetCollection>_via_<refField>` parses to a dedicated `viaRelation` operand; SQL emits `(SELECT json_group_array(...) FROM vb_<target> WHERE <refField> = <self>.id [AND <inherited view_rule>] LIMIT 1000)`. The 1000-row cap is hard. Ref-field existence validated via the same `CollectionLookup`.
- [x] Phase 1.x — `:each` modifier full implementation. Compiles to `(json_array_length(<col>) > 0 AND NOT EXISTS (SELECT 1 FROM json_each(<col>) WHERE NOT (<cmp>)))` so empty arrays return false. JS evaluator uses `Array.every`.

### New attack vectors covered by Phase 1.x

#### `@collection.*` recursive view_rule expansion (DoS)

A malicious admin authoring `view_rule = "@collection.posts.title = 'x'"` on `posts` itself would create infinite recursion in the rule compiler. Mitigation: `MAX_JOIN_DEPTH = 4` in `filter.ts::compileToSql`. Exceeding it throws, which the parser catches and returns `null` (denies all).

Test: `Phase 1.x — @collection.* view_rule inheritance > max join depth enforced`.

#### `_via_` back-relation refField injection

`_via_` infix is detected by string `indexOf` on the parsed identifier head; if the parser allowed shell metacharacters the resulting `targetCollection` / `refField` would flow into raw SQL via `escapeIdent`. Mitigation: identifier-shape regex applied at `makeFieldOperand` AND `IDENT_RE` re-checked at SQL emit. Plus `escapeIdent` doubles `"` defensively.

Test: `Phase 1.x — _via_ > rejects identifiers with shell metacharacters`.

#### Cross-tenant leak via `_via_` ignoring view_rule

If the joined collection's `view_rule` were not inherited, `comments_via_post` would return every comment regardless of who posted them. Fixed: `compileViaRelationRef` calls back into `compileNode` to recursively compile the joined collection's view_rule and ANDs it into the WHERE clause.

Test: `Phase 1.x — _via_ > inherits the joined collection's view_rule (non-admin)`.
