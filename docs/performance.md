# Performance — what just landed and what's next

**Baseline (oha, 200 concurrent, 1m):** 4 461 req/s, p50 44ms, p99 58ms, p99.99 106ms.

That's a list endpoint returning ~6 KiB JSON per response. CPU-bound on the host process, not the network. The easy wins below are now in `master`.

---

## What just shipped

### 1. SQLite pragmas — file DB only

`src/db/client.ts::initDb`. WAL + reduced fsync + 32 MB page cache + 256 MB mmap + in-memory temp store + 5s busy timeout.

```sql
PRAGMA journal_mode  = WAL;        -- concurrent readers, single writer
PRAGMA synchronous   = NORMAL;     -- WAL-safe; orders of magnitude faster than FULL
PRAGMA cache_size    = -32000;     -- 32 MB page cache
PRAGMA mmap_size     = 268435456;  -- 256 MB OS mmap (skip read() syscalls)
PRAGMA temp_store    = MEMORY;
PRAGMA busy_timeout  = 5000;
```

Skipped on `:memory:` databases — they trigger `SQLITE_NOMEM` for `mmap_size` and gain nothing from WAL.

**Expected impact:** 30-50% lower p50 on read-heavy load. Slightly higher write throughput. WAL also unblocks concurrent reads while a write is in flight (PB-style).

### 2. Filter / rule AST cache

`src/core/filter-cache.ts`. LRU map of compiled `Expr` ASTs keyed by the rule string.

Cap: 512 entries. Eviction: oldest-first. Hit rate on a steady workload: 100% (every request reuses the same `list_rule`).

The caller still binds parameters per request — only the parse step is cached. No security regression: the AST is immutable.

**Expected impact:** -1 to -3 ms per request. Savings scale with rule complexity.

### 3. Prepared-statement cache

`src/core/records.ts::getCachedStmt`. `bun:sqlite` reparses SQL on every `prepare()` call; under 4 k req/s that's a measurable share of CPU.

Map keyed by SQL string. LRU at 256 entries. Cleared on:
- Collection schema change (`invalidatePreparedStatements()` from `core/collections.ts::cache.clear()`).
- DB close (so test isolation + future schema swaps don't reuse statements bound to a closed connection).

**Expected impact:** -2 to -5 ms per request. The list endpoint now reuses the same compiled statement across thousands of calls.

### 4. Opportunistic gzip on JSON responses

`src/server.ts::onAfterHandle`. Only API responses, only when `Accept-Encoding: gzip`, only when payload ≥ 1 KiB. Streamed `Response` objects (file downloads, SSE) bypass.

**Expected impact:** 6 KiB → ~1.5 KiB wire = lower transfer time, lower bandwidth bill, lower p99 (bigger payloads benefit more).

---

## Re-run the benchmark

```bash
oha http://127.0.0.1:8091/api/posts -z 1m -c 200 -H "accept-encoding: gzip"
```

Expected new numbers (rough — depends on disk + CPU):
- **req/s: 7 000 - 10 000** (50-120% gain from rule + stmt cache + WAL).
- **p50: ~20-25 ms**.
- **p99: ~35-50 ms**.
- **wire bytes/sec: similar despite higher req/s** because gzip cuts 6 KiB → ~1.5 KiB.

Ask `oha` for `-H "accept-encoding: gzip"` so the gzip path actually fires.

---

## Where the next gains are

In rough order of bang-for-buck.

### A. Skip auth verification on anonymous-only endpoints (-2 ms p50)

`getAuthContext` runs `verifyAuthToken` (jose JWT verify + revocation-table lookup) on every request, even when there's no `Authorization` header. The current code already short-circuits on missing header → `null`. **Already done.** What's NOT done: when a `view_rule` is `null` (public), we still call `getAuthContext` for the log entry.

Fix: pass `auth` lazily; only verify when the rule actually references it.

**Estimate:** -1-2 ms on truly-anonymous reads.

### B. JSON serialization with `Bun.write` / `Response(stream)`

For very large list responses, building a 6 KiB JS object per request and JSON.stringifying it is hot. A streamed `JSON.stringify` chunked into a `ReadableStream` removes the peak memory + lets gzip start before the whole array is built.

**Estimate:** -3-5 ms on `perPage=100`-style queries; less on the default `perPage=30`.

### C. Brotli for static files, gzip stays for dynamic

Bun has `Bun.deflateSync` but no native brotli. For the admin SPA assets, ship pre-compressed `.br` files via `bun build` and serve them with `Content-Encoding: br` when accepted. Dynamic JSON stays gzip (brotli is slow at compress-time per request).

**Estimate:** -50 to -200 KB on first paint of `/_/`.

### D. HTTP/2

Bun.serve supports HTTP/2 via TLS. For a single large client (e.g., admin SPA hammering the API on page load) HTTP/2 multiplexing eliminates the head-of-line blocking that HTTP/1.1 hits at high concurrency. Most relevant for low-latency LANs where TCP overhead dominates.

**Estimate:** marginal at single-client; meaningful at 10k+ concurrent connections.

### E. Skip the rate-limiter when `enabled = false`

`makeRateLimitPlugin` runs `loadConfig` (cached for 5s) then iterates rules even when disabled. One early-return at the top of the handler skips the work entirely.

**Estimate:** -0.2 ms (small).

### F. Reduce the per-request log work

Every request writes to `vaultbase_logs` JSONL files via `appendHookLog`. If file logging is enabled, this is a synchronous `fs.appendFileSync` shaped call. Wrap in a per-process buffer that flushes every 50 ms.

**Estimate:** -1-3 ms on file-system-bound hosts.

### G. Skip `getCollection`'s async wrapper

`getCollection(name)` is `async` even on cache hit (returns `Promise.resolve(cached)`). The hot path could synchronously return the cached value. Already exposed via `getCollectionCached` for the rule compiler — extend to records / files / batch.

**Estimate:** -0.3 ms (microbenchmark territory).

### H. Index review

Add indices for the patterns you actually query:
- `(created_at DESC)` on every collection table — the default sort.
- Per-collection composite indices on common filter shapes (`(author, published, created_at)` etc.). Surface in admin UI.

**Estimate:** unbounded — depends on query shape and row count.

### I. Compile-time inlining of rule for "list_rule = null" public collections

When the rule is `null`, the records list path still runs the rule-eval code path that decides "public → no WHERE filter." Push the decision earlier so the SQL is fully prepared at collection-load time and just rebound per request.

**Estimate:** -1 ms.

### J. Cluster mode (multi-process)

Bun is single-threaded. To use all cores, run N worker processes behind nginx / haproxy with port reuse. Keep SQLite as the single source of truth (one process owns the writer; others are read-only).

**Estimate:** ~Nx throughput on N-core hosts. Configuration cost: medium.

---

## What NOT to do

- **Don't drop `synchronous = NORMAL` to `OFF`.** The WAL guarantee is what makes SQLite safe under crash; `OFF` corrupts on power loss.
- **Don't bypass the rule engine.** Every "performance" PR that suggests "skip rule eval for trusted callers" is a future audit finding.
- **Don't switch to a connection pool.** SQLite is a file lock; one process = one writer. Adding a pool just trades CPU for contention.
- **Don't enable `mmap_size` over RAM size.** Linux paging will thrash. 256 MB is conservative.
- **Don't cache responses globally.** Per-request rule eval + per-user authz means responses are user-specific. Edge caching needs `Vary: Authorization` and bounded TTL.

---

## Reproducing the benchmark

```bash
# Server in one terminal
cd D:/projects/mine/vaultbase-sh/vaultbase
bun run dev

# Bench in another
oha http://127.0.0.1:8091/api/posts \
  -z 1m \
  -c 200 \
  -H "accept-encoding: gzip"
```

For an apples-to-apples comparison, seed a few hundred rows first via the admin or:

```bash
for i in $(seq 1 200); do
  curl -X POST http://127.0.0.1:8091/api/posts \
    -H "authorization: Bearer $ADMIN" \
    -H "content-type: application/json" \
    -d "{\"title\": \"post-$i\"}" >/dev/null
done
```

---

## Sanity check

After merging these changes:
- 468/468 unit tests pass.
- TS strict typecheck clean.
- Existing rule semantics unchanged (cache is transparent).
- Gzip skips streamed responses — file downloads + SSE unaffected.

Re-run `oha` and post the numbers; the next round of optimizations gets prioritized by what's still slow.
