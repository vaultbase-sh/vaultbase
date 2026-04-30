# Redis integration — design brainstorm

> Status: **brainstorm**. Scope narrowed to **selective cache + background-job
> queue**. No multi-instance / pub-sub / clustering ambitions.

Vaultbase stays single-binary, single-process by design. Redis is **not**
about scaling out. It's about plugging in two specific upgrades for power
users:

1. **A selective cache layer in front of SQLite** — opt-in per query, with
   easy admin management and full programmatic control via hooks.
2. **A durable, out-of-runtime background job queue + scheduler** — heavy
   work leaves the request path; crashes don't take the server down.

Both are **optional**. Vaultbase still works perfectly without Redis. When
Redis is configured, each subsystem can be enabled independently.

---

## What we're building

```
redis.enabled    = "1"
redis.url        = "redis://default:pw@host:6379/0"
redis.tls        = "0"
redis.key_prefix = "vb:"
redis.use_for    = "cache,queue"   # CSV; default empty
```

Settings UI tab **Settings → Redis** with: URL, TLS, prefix, per-subsystem
checkboxes (cache / queue), connection-test button, status badge in topbar.

Client lib: **Bun's native `Bun.redis`** — zero deps, RESP3.

Cache and queue use a shared `KV` abstraction (`src/core/kv.ts`):

```ts
interface KV {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, opts?: { ttl?: number; tags?: string[] }): Promise<void>;
  del(key: string): Promise<void>;
  delByTag(tag: string): Promise<number>;
  incr(key: string, amount?: number): Promise<number>;
  // queue primitives
  rpush(key: string, value: string): Promise<number>;
  blpop(key: string, timeoutSec: number): Promise<string | null>;
  zadd(key: string, score: number, member: string): Promise<number>;
}
```

Two implementations: `memoryKV` (default, single-process Maps) and `redisKV`
(when configured). Each subsystem reads `getKV("cache")` / `getKV("queue")`,
falling back to memory if Redis isn't enabled or the subsystem isn't in
`use_for`.

---

## Pillar 1 — Selective cache layer

**Default: cache OFF for everything.** Vaultbase's stance: "nothing is
cached unless you say so." Auto-caching SQLite reads would be a correctness
footgun — too many write paths (records HTTP, hooks, batch, cascade,
custom routes, file ops).

### Three places to declare a cache rule

**1. Admin Settings → Cache rules** — central rule table for ops-driven setups:

| Pattern | TTL | Auto-bust on writes | Tags |
|---|---|---|---|
| `posts:list` | 60s | yes (writes to `posts`) | — |
| `posts:get:*` | 300s | yes | — |
| `users:list filter=verified=true` | 120s | yes | — |
| `tags:list` | 24h | yes | `taxonomy` |

Each rule has:
- Pattern: `<collection>:<op>` plus optional filter expression
- TTL (max 24h, bounded so stale data can't live forever)
- "Auto-bust on writes": when a record in the matched collection is
  created/updated/deleted, drop matching cache entries
- Tag list (optional, for fan invalidation)

**2. Per-collection knob in the schema editor** — quick toggles next to
`list_rule` / `view_rule`:

- Cache list reads: [ ] off / [ ] N seconds
- Cache view reads: [ ] off / [ ] N seconds

Convenience layer over the rule table. Saving toggles writes/updates the
matching rule.

**3. Hooks** — full programmatic control:

```js
// Stale-while-revalidate read-through
const data = await ctx.helpers.cache.swr("expensive-query", 300, async () => {
  return ctx.helpers.query("orders", { filter: "..." });
});

// Manual set with tag for fan invalidation
await ctx.helpers.cache.set("user-feed:42", payload, {
  ttl: 60,
  tags: ["user:42"],
});

// Invalidate by tag (fans across many keys)
await ctx.helpers.cache.invalidateTag("user:42");

// Invalidate by glob
await ctx.helpers.cache.invalidate("posts:*");
```

### Cache key shape

```
vb:cache:<collection>:<op>:<auth_bucket>:<hash(query)>
```

`auth_bucket` ∈ {`admin`, `user:<id>`, `guest`}. Per-user views never bleed
across accounts. Rules with `@request.auth.*` references automatically
include the auth bucket.

### What never gets cached, even when matched

- Anything with `@request.auth.*` referenced in a way that can't be bucketed
  (rare — most cases are auth.id or auth.email which bucket cleanly)
- File response bodies (let the browser / CDN do that)
- Encrypted-fields' decrypted form (correctness + security)
- Any list with `skipTotal=false` AND total > 100k (pagination math
  re-derives totals from cached chunks differently — not worth it for v1)

### Auto-invalidation on mutation

Every successful mutation in the records HTTP layer (and batch, hooks
calling helpers, custom routes) emits a cache-bust signal. The cache
subsystem's pattern matcher checks the rule table:

- `posts.create` → drops keys matching `posts:list:*` and `posts:get:*`
  for any rule with `auto-bust` enabled

Hooks bypass this if they want; explicit `cache.invalidate(...)` for
non-record mutations (e.g. external API state changes).

### Admin Cache page (new top-level nav item)

- Hit / miss / total counts per rule (with sparkline, last 24h)
- Memory usage estimate (Redis `MEMORY USAGE` per key sampled)
- Manual flush buttons: per rule, per collection, all
- Top 10 hottest keys (most reads)
- Recent invalidations feed (debug "why is the cache busting so often")
- "Disable all caching" big red button

### Why bother in single-process

Even one process benefits when:
- A `list` query joins 5 collections via expand
- A custom route does heavy aggregation
- A hook calls `helpers.fetch(externalApi)` and external rate limits cap you
- The same dashboard query is hit by 50 admin users in the same minute

Memory KV (no Redis) is the perf win for in-process workloads. Redis adds
durability (cache survives restart) and capacity (off-process memory).

### Loss / correctness footgun

The single biggest risk: operator caches `posts:list` for 5min, edits a
post in the admin, doesn't see the change. Mitigations:

- Auto-bust-on-writes is **on by default** in the rule table.
- Admin records list shows a small banner: "Showing cached results (Xs old). Refresh."
- The cache page shows recent invalidations so debugging "why is this stale"
  is straightforward.

---

## Pillar 2 — Background job queue + scheduler offload

This is the bigger value. Today `startScheduler` runs cron jobs in-process
on the request runtime. Long-running jobs hold up neighbors; crashes ripple.

### Shape

- **Queues** — named lanes (`emails`, `webhook-out`, `report-gen`, etc.).
  `helpers.enqueue(queue, payload, opts?)` from anywhere.
- **Workers** — out-of-process consumers that pull from queues and run
  user-defined JS. Run as `bun run worker` or as the same binary in
  `--worker` mode.
- **Scheduler** — existing cron tick. Each cron gains a "Run as worker"
  toggle: when on, the cron enqueues a job instead of executing inline.

### Memory mode (Redis off)

In-memory queue, single process. Workers run as goroutines... err, as
async loops in the same process. Loss on crash. Acceptable default — no
worse than today's inline cron, and crash-isolated from request handlers.

### Redis mode (Redis on, `queue` in `use_for`)

Durable queue via Redis lists (`LPUSH` + `BRPOP`) or sorted sets for
delayed/scheduled jobs (`ZADD` + `ZRANGEBYSCORE`). Workers poll Redis;
multiple worker processes can run side-by-side on the same machine.
Failures retry with exponential backoff. Dead-letter queue for jobs that
exhaust retries.

### API

```js
// Enqueue
await ctx.helpers.enqueue("emails", { to, subject, body });

// Delayed
await ctx.helpers.enqueue("reminders", { userId }, {
  delay: 24 * 3600,           // run in 24h
});

// Retry policy
await ctx.helpers.enqueue("webhook-out", payload, {
  retries: 5,
  backoff: "exponential",     // base 1s, doubles, max 5min
  uniqueKey: `webhook:${id}`, // dedup if already enqueued
});

// Define a worker — admin UI, Hooks page, "Workers" tab
async function emailWorker(ctx) {
  // ctx.payload   — the enqueued data
  // ctx.attempt   — 1-indexed
  // ctx.queue     — "emails"
  // ctx.helpers   — same as record hooks (find, query, fetch, log, recordRule, cache)
  await ctx.helpers.email(ctx.payload);
}
```

### DB tables (memory mode mirrors these in-memory)

```sql
CREATE TABLE vaultbase_workers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  queue         TEXT NOT NULL,
  code          TEXT NOT NULL DEFAULT '',
  enabled       INTEGER NOT NULL DEFAULT 1,
  concurrency   INTEGER NOT NULL DEFAULT 1,
  retry_max     INTEGER NOT NULL DEFAULT 3,
  retry_backoff TEXT NOT NULL DEFAULT 'exponential',
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at    INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE vaultbase_jobs_log (
  id           TEXT PRIMARY KEY,
  queue        TEXT NOT NULL,
  worker_id    TEXT,
  payload      TEXT NOT NULL,             -- JSON
  attempt      INTEGER NOT NULL,
  status       TEXT NOT NULL,             -- queued | running | succeeded | failed | dead
  error        TEXT,
  enqueued_at  INTEGER NOT NULL,
  started_at   INTEGER,
  finished_at  INTEGER
);
```

`vaultbase_jobs_log` provides the admin "Jobs" dashboard regardless of
which queue backend is in use. The actual queueing primitives live in
Redis (or in-memory) — the SQLite log is just history.

### Scheduler integration

Existing cron jobs (`vaultbase_jobs` table from the cron feature) gain a
new `mode` column: `inline` (current behavior) or `worker:<queue>`. When
`worker:emails`, the cron tick enqueues `{cron: cron_id, ...}` to the
`emails` queue instead of executing the JS inline.

This unlocks: a 10-minute weekly report doesn't block the request server.

### Admin UI

New tab in Hooks page alongside Record hooks / Custom routes / Cron jobs:

- **Workers** tab — list workers, edit code (Monaco), tune concurrency
  + retry policy
- **Jobs dashboard** (separate top-level page or sub-tab) — pending /
  running / succeeded / failed / dead per queue, click into a job to see
  payload + last error + manual retry / discard

### Worker process

Two run modes:

1. **In-server** (default for `memory` mode, optional for Redis): worker
   loops run alongside the request handlers. Crash-isolation is at the
   async-task level (`try/catch` per job).
2. **Separate process**: `bun run worker` (or `./vaultbase --worker`)
   reads the same DB + the same Redis, runs only the queue loops, no HTTP
   server. Operators can run any number of these. **This is the way to
   actually offload heavy work** — when one of those crashes, the request
   server keeps serving.

### Why this is the killer feature

- Vaultbase + workers replaces "BullMQ + a separate Node service" for
  most apps. One config, one log stream, one admin UI.
- Long-running tasks (image processing, third-party API ingestion,
  weekly reports, big email blasts) leave the request path entirely.
- Crash isolation: a runaway hook in a worker doesn't take down the
  request server.
- The cron + worker combo handles 95% of "I need a small backend job"
  use cases without an external scheduler.

---

## What this would NOT do (per scope)

- **Not** for multi-node deployments. Vaultbase still runs as one
  request server. Redis isn't there to share state between two
  Vaultbase processes — it's there to give one process durable
  cache + queue.
- **Not** a realtime pub/sub bridge. Realtime broadcasting stays
  in-process (WS + SSE).
- **Not** a token revocation list, settings sync channel, distributed
  cron lock, or rate-limit clustering. All of that assumes
  multi-instance and we're not building for that.
- **Not** auto-caching. Operator/admin/hook explicitly opts in per query.
- **Not** a replacement for SQLite. SQLite is the source of truth.
  Cache is a read accelerator. Queue is durable but the canonical
  "what happened" is in `vaultbase_jobs_log`.

---

## Failure modes

| Subsystem | Redis up | Redis down |
|---|---|---|
| Cache | Read-through, fan-invalidation works | Silent miss, recompute every call. Admin badge red. |
| Queue (Redis mode) | Durable, retries, dead-letter | Falls back to in-memory queue. Existing in-flight jobs continue; new enqueues land in memory. **Document: "for production durability, ensure Redis stays up."** |
| Queue (memory mode, Redis-not-configured) | n/a | always in-memory; jobs lost on crash |

Each subsystem decides its policy. **No subsystem hard-fails the request
when Redis is unavailable** — that turns Redis into a soft dependency that
the request path can ignore.

---

## Operator burden

You raised it. Honest answer:

**Cache:** very low. Set the URL once, declare a few rules, never look at
it again. The KV is dormant when not in use. If the operator ever decides
"this is too much," they flip the toggle and Vaultbase reverts to no-cache
behavior — no data migration, nothing to clean up.

**Queue:** moderate. Redis becomes load-bearing for queue durability. If
Redis dies, the in-memory fallback kicks in but jobs vanish on a process
crash. Operators who run heavy jobs need to monitor Redis. Mitigation:
ship the in-memory queue as the **default** (no Redis required); document
"for production durability, configure Redis."

**Net:** the operator who turns Redis on is signing up for "I now have
two things to monitor instead of one." That's fair given the upside —
heavy work moves out of the request path, cache survives restarts, jobs
don't get lost on crashes.

---

## Rough size

| Piece | Effort |
|---|---|
| `core/kv.ts` abstraction (memory + Redis impls) | M |
| Cache module: rule table + key generation + auto-bust hooks + per-collection knobs in schema editor | M |
| Hook helpers: `cache.get/set/swr/invalidate/invalidateTag` | S |
| Cache admin page: stats + manual flush + recent invalidations | M |
| Queue module: enqueue + worker loop + retry + dead-letter | M |
| Scheduler integration (cron `mode` column) | XS |
| Worker JS code editor + workers tab | S |
| Jobs dashboard | S |
| `--worker` startup mode | XS |
| Settings → Redis tab + connection test | S |
| Tests (gated on `REDIS_URL`) for both subsystems | M |
| Docs page (concepts + setup guide) | S |

Estimate: **6–8 focused days** for v1 covering both pillars.

Phased so each phase ships value:

1. **Phase 1** (~2d): KV abstraction + queue with memory backend +
   workers tab + jobs dashboard + scheduler integration. **Useful even
   without Redis** — crash-isolated workers, retry semantics.
2. **Phase 2** (~2d): Redis backend for queue. Operators who want
   durability turn it on.
3. **Phase 3** (~3d): Cache subsystem. Rule table + per-collection
   knobs + hook helpers + admin page.
4. **Phase 4** (~1d): Polish, docs, integration tests.

Total: ~8 days.

---

## Open questions for review

1. **Cache rule pattern syntax** — full filter-DSL parse for matching
   list queries, or just `<collection>:<op>` + optional verbatim filter
   string match? Lean: just collection+op+filter string match in v1;
   "smart" matching is a v2.
2. **Default TTL bound** — 24h ceiling on every rule? Or unbounded with
   a warning past 24h? Lean: hard 24h cap. Stale longer than that is
   almost always a bug.
3. **Cache the records-API SQL execution itself**, or cache the API
   response shape? Lean: response shape (after expand, after auth-bucket,
   after field projection). Closer to "what the client sees."
4. **Queue retry persistence in-memory mode** — if a job fails 3 times
   in memory mode, dead-letter goes where? Lean: SQLite
   `vaultbase_jobs_log` table tracks history regardless of backend.
5. **Worker concurrency model** — N workers sharing a queue, or N
   queues? Lean: per-worker concurrency knob; multiple workers per
   queue allowed.
6. **Should `--worker` mode ship in the same binary or as a separate
   binary?** Lean: same binary, different mode flag. One artifact to
   distribute.
7. **Cache-key fingerprinting — hash the full query string or the
   parsed filter AST?** Lean: full query string with sorted query
   params. Cheap, avoids semantic equivalence drift.
8. **Should we expose `helpers.cache` even when caching is off**
   (memory KV always available)? Lean: yes. Hooks-driven caching is
   useful per-hook even when the rule-table cache is disabled.
9. **Per-rule cache flush API endpoint** — `POST /api/admin/cache/flush`
   `{ rule, pattern }` for CI / deploy hooks? Lean: yes, ship it.

---

## Recommendation

Ship the **queue first** (Phase 1), even before Redis. The in-memory
queue with crash-isolated workers + scheduler integration is genuinely
useful on its own — solves the "long jobs block requests" problem we
already have today. Phase 2 (Redis durability) is a low-effort follow-up
that turns "useful" into "production-grade."

Then ship the **cache** (Phase 3). It's the bigger UI surface and needs
the rule-table polish.

If we never want to ship this, the workaround is in-process cron stays
inline + apps cache in their client layer (or live without it). Defensible
for tiny deployments. Operators who outgrow that have a clean upgrade path.
