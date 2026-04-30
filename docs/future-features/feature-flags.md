# Feature flags — design brainstorm

> Status: **brainstorm**. Not implemented. Review and decide before any code lands.

A think-out-loud on adding feature flags to Vaultbase. Goal: let admins gate
API behavior, hook execution, custom routes, and arbitrary client-side
features behind named flags evaluated at runtime — without redeploys.

---

## What we're building

A flag = `{ key, type, value, rules, enabled }` stored in DB, edited from the
admin UI, evaluated at request time, exposed via:

1. **Server-side**: middleware + `helpers.flag(key)` in hooks/routes/jobs.
2. **REST**: `GET /api/flags` returns the evaluated set for the calling auth
   context. Supports `If-None-Match` for cheap polling.
3. **Realtime**: flag changes broadcast as `{ type: "flag-update", … }` so
   open clients pick up overrides without a reconnect.
4. **Admin UI**: dedicated **Flags** page — list, create, edit, archive,
   per-flag eval preview ("what does user X see right now?").

Three flag shapes:

| Type     | Value            | Use cases                                   |
| -------- | ---------------- | ------------------------------------------- |
| `bool`   | `true` / `false` | kill switches, gating                       |
| `string` | one of N labels  | variant routing ("blue" / "green" / "red")  |
| `json`   | arbitrary        | config payloads, thresholds, feature tuples |

Targeting rules per flag (evaluated top-down, first match wins):

- **All users** (default)
- **Specific user ids** (admin pastes a list)
- **Auth type** (`admin` / `user` / anonymous)
- **Collection membership** (user belongs to collection X)
- **Email pattern / domain** (`*@vaultbase.dev`)
- **Percentage rollout** (deterministic hash of `flag.key + auth.id` → bucket;
  same user always lands in the same bucket)
- **Custom expression** (the same DSL used in `view_rule` etc. —
  `@request.auth.email ~ "@partner.com"`, `created_at > 1700000000`, …)

Default value when no rule matches.

---

## Use cases

### Vaultbase-internal

- **Roll out a new collections feature** to a single dev account before
  enabling for everyone.
- **Kill switch** for a misbehaving cron job ("pause `nightly-cleanup` if
  flag `cron.cleanup.enabled` is off").
- **Soft-disable expensive endpoints** during incidents
  (`api.batch.enabled = false` → returns 503).
- **A/B test rate-limit defaults** (variant A: 60/min, variant B: 120/min;
  rate-limit middleware reads `rate-limit.profile` flag).
- **Gate experimental features** like the upcoming JS/Dart/C# SDK
  metrics endpoint behind `metrics.collect.enabled`.
- **Per-environment differences without env vars** — a single binary, two
  envs, flags drive behavior. Combined with the snapshot CLI, every env can
  ship pre-seeded flags.

### App-developer-facing

- **Mobile app dark launch** — backend supports new fields but only sends
  them to clients with `feature.profile-v2 = true`.
- **Tenant-scoped features** in multi-tenant apps via per-collection rules
  — admin enables `analytics.enabled` only for users in `org_premium`.
- **Geographic rollouts** (combined with a hook that injects geoIP into
  request context — out of scope for v1).
- **Feature deprecation funnel** — flip default to `false`, watch usage
  drop in logs, then remove the code.

---

## Where it lives

### Storage

```sql
CREATE TABLE vaultbase_flags (
  key           TEXT PRIMARY KEY,        -- 'feature.search-v2'
  type          TEXT NOT NULL,           -- 'bool' | 'string' | 'json'
  default_value TEXT NOT NULL,           -- JSON-encoded
  rules         TEXT NOT NULL DEFAULT '[]',
  description   TEXT NOT NULL DEFAULT '',
  enabled       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
```

`rules` shape:

```ts
type FlagRule = {
  id: string;
  match: {
    audience?: "all" | "guest" | "user" | "admin";
    userIds?: string[];
    emailPattern?: string; // glob or regex
    expression?: string; // existing rule DSL
    percentage?: { bucket: number; of: 100 }; // 0..100
  };
  value: unknown; // JSON, must match flag type
};
```

### Cache

- In-process `Map<string, Flag>` populated on first read, invalidated on
  PATCH (same pattern as settings/rate-limit/email/storage).
- TTL: 30s as a backstop in case invalidation is missed.
- Evaluation is pure — a tight loop over rules. No DB hit at eval time.

### Eval surface

Server side:

```ts
import { flag } from "../core/flags.ts";

// Boolean flag
if (await flag("feature.search-v2", auth) === true) { … }

// Variant string
const variant = await flag("nav.layout", auth);

// JSON payload
const cfg = await flag("rate-limit.profile", auth);
```

Hooks:

```js
if (await ctx.helpers.flag("feature.welcome-email", true)) {
  await ctx.helpers.email({ to: ctx.record.email, … });
}
```

Custom routes / jobs: same `ctx.helpers.flag(key, defaultValue?)` shape.

### REST

```http
GET /api/flags
   → { "data": { "feature.search-v2": true, "nav.layout": "v3", … } }
```

- Bound to caller's auth (or anonymous).
- ETag based on flag table's `MAX(updated_at)` so polling is cheap.
- 30s `Cache-Control: private, max-age=30` for browsers without ETag.

### Realtime

A new system topic `__flags__` broadcasts on any flag PATCH — clients with an
active WS/SSE connection receive `{ type: "flag-update", key, value }` and
update local state without polling.

### Admin UI (Settings → Flags? or dedicated nav item)

Per flag:

- Key / type / description / enabled toggle
- Default value editor
- Rule list (drag to reorder, edit per-rule targeting)
- **Eval preview**: paste a user id or admin email → see the resolved value
  - which rule matched (for debugging "why is this user seeing X?")
- Audit trail (who changed what, when — could ride on the existing logs by
  emitting `kind: "flag-change"` JSONL entries)

---

## Gain

1. **Decoupled deploys + releases**. Ship code dark, flip a flag to release.
2. **Instant rollback** without redeploying.
3. **Targeted dogfooding** — Vaultbase devs run main with all in-progress
   features; everyone else sees only what's flagged on.
4. **A/B testing primitives** without a third-party (LaunchDarkly costs
   real money for small teams).
5. **Multi-tenant conditional features** without forking schemas.
6. **Better incident response** — kill the bad code path in seconds.
7. **Smaller release notes** — flagged work doesn't need to be in a
   changelog until enabled.
8. **Composability** — flags + hooks + custom routes give admins a tiny
   policy DSL without writing TypeScript.

## Loss / cost

1. **Eval overhead** on the hot path. Mitigated by in-memory cache, but
   still adds a Map lookup + rule iteration per request. Worst-case rules
   with expression DSL evaluate the same expression engine `view_rule` uses
   — fast but not free.
2. **Combinatorial complexity in tests**. Every feature behind a flag
   doubles the test matrix. Convention: tests assume the **default** value;
   integration tests cover the non-default by override hooks.
3. **Stale clients**. Without realtime, mobile apps can run on old flag
   values for minutes. Realtime broadcast helps but doesn't eliminate.
4. **"Forever flags"** — flags meant to be temporary that never get
   removed. Common LaunchDarkly anti-pattern. Mitigation: every flag has
   `created_at`; admin UI surfaces "this flag has been around 9 months,
   audit it."
5. **Audit-trail noise** — every flag change is a change to system
   behavior, must be logged. Adds noise to `vaultbase_logs`.
6. **Plain-text targeting in DB** — rules + values live in SQLite
   unencrypted. If you put production secrets in flag values (don't),
   they're DB-readable.
7. **Cluster sync** is non-trivial if Vaultbase ever supports multi-node.
   For single-binary today: not a problem. Note for future scaling.
8. **Auth coupling** — rules read `auth.id` / `auth.email` / `auth.type`,
   so unauthenticated polling requests get only the "anonymous + default"
   subset. Apps that conditionally render based on flags must re-fetch
   after login.

## Edge cases

- **Anonymous users**: rules with `userIds` / `emailPattern` skip; only
  `audience: "guest"` and `percentage` (hashed on session id?) apply.
  Or: anonymous always gets the default.
- **Default-value mismatch with type** — schema editor must validate
  (`bool` flags can't have `string` default, etc.).
- **Empty rules list** → always returns default.
- **Disabled flag** (`enabled = 0`) → returns default regardless of rules.
  Useful for "draft" flags.
- **Percentage bucketing for the same flag across two requests** —
  must be deterministic for the same `(flag.key, auth.id)`. Use SHA-256
  of that pair, mod 100. Stable across server restarts.
- **Rapid flag flapping** — admin toggles bool 10×/sec; cache TTL +
  realtime broadcast hits hard. Coalesce broadcasts (max 1/sec/flag).
- **Cyclical expressions** — flag rule references another flag. Disallow
  in v1 (rule expression DSL doesn't have a `flag()` helper). Revisit later.
- **Flag explosion**: 10k flags, each with 10 rules → 100k row-evals on
  cache miss. Realistic? No, but bound it: warn in admin UI past 500.
- **Migration imports**: `applySnapshot` should optionally include flags
  for stateless deploys. Same shape as collections.

---

## Why ship this

For a single-binary, opinionated, "pocketbase-class" backend, feature flags
hit a sweet spot: the cost is mostly DB rows + a small eval loop, the gain
is a tier of operational maturity that competitors charge real money for.

The killer combo with Vaultbase specifically:

- **Hooks already exist** → flag-aware hooks immediately
- **Realtime already exists** → instant propagation, free
- **Settings + cache pattern is reusable** → no new architecture
- **JS SDK is on the roadmap** → first-class `vb.flags.subscribe(...)` API
- **Rule expression engine already exists** → reuse for targeting

---

## Why not (yet)

- Without the JS SDK, the wire-side experience is OK but not great.
- Realtime broadcast topic for flags is new surface area to maintain.
- Admin UI polish takes time — eval preview is the high-value piece and
  doing it without it makes the feature feel half-finished.

Recommend ordering: **JS SDK → flags**. Then a flag changes from "API
exists" to "feels native in client code."

---

## Rough size

| Piece                                                         | Effort |
| ------------------------------------------------------------- | ------ |
| DB table + migration                                          | XS     |
| `core/flags.ts` (load, cache, evaluate, percentage hashing)   | S      |
| `api/flags.ts` (admin CRUD + GET /api/flags)                  | S      |
| Realtime broadcast on PATCH                                   | XS     |
| Hook helper `ctx.helpers.flag(key, default?)`                 | XS     |
| Admin UI: list + edit + rule editor                           | M      |
| Admin UI: eval preview ("simulate a user")                    | S      |
| Tests (expressions, percentage stability, cache invalidation) | S      |
| Docs page + roadmap.md                                        | XS     |

Estimate: **3–5 focused days** for v1, behind the JS SDK landing first.

---

## Open questions for review

1. **Variant types beyond bool/string/json?** Numeric thresholds are
   common — `int` flag for "max image size today" — but `json` covers it.
   Skip dedicated numeric type? [YES]
2. **Should rules be stored as JSON or as separate rows?**
   - JSON: simpler schema, lossy for indexing.
   - Rows: queryable ("which flags target user X?"), more migration churn.
     Lean JSON for v1. [ROWS]
3. **Per-flag audit log or piggyback on request log?**
   - Piggyback wins for now (one less subsystem). [piggyback]
4. **Admin-only API or expose to authed users?**
   - Both — `GET /api/flags` is public-with-auth-context (for client apps);
     CRUD is admin-only. [OK]
5. **Should we expose `getFlagForUser(key, userId)` for impersonation
   debugging?** Useful for the eval preview UI; admin-only. [YES]
6. **Naming convention enforcement** — block flag keys that don't match
   `[a-z][a-z0-9._-]*`? Strong yes; loose keys age badly. [YES]
7. **Allow numeric values in `string` flags** ("variant 2") or coerce to
   actual `string` ("v2")? Coerce.
8. **Built-in flag for the admin UI itself** — e.g. `admin.experimental.enabled`
   that gates new admin pages? Probably yes. Eat our own dog food. [NO]

---

## What this would NOT do

- **Not** a full LaunchDarkly clone (event tracking, experiments,
  conversion analysis, prerequisite flags, segment management UI).
- **Not** a way to deploy code — flags gate runtime behavior, not file
  contents.
- **Not** a replacement for env vars at boot time. Flags are runtime,
  admin-editable. Boot config stays in env.
- **Not** a secret management system. Don't put API keys in flag values.

---

## Recommendation

Ship feature flags as a **post-SDK** project (so the SDK provides
`vb.flags.subscribe(key)` from day one). Stage:

1. Backend: table + core eval + REST + realtime broadcast (hidden behind
   `?include_flags=experimental` or just an env var until UI lands).
2. Hook helper.
3. Admin UI (basic CRUD).
4. Eval preview (the killer admin feature).
5. SDK integration.

If you want it sooner, skip step 4 + the realtime broadcast and call it a
v0.5 — still useful, ships in 2 days.
