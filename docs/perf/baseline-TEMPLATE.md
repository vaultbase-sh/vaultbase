# Baseline — Phase 0 capture

> Replace this template with `baseline-<YYYYMMDD>.md` after running the
> capture flow in `README.md`. Commit alongside the `.cpuprofile` and
> `metrics-*.json` files.

**Date:** YYYY-MM-DD
**Host:** (CPU model, core count, RAM, OS)
**Vaultbase version:** vX.Y.Z (commit `…`)
**SQLite:** version, journal_mode, page_size, cache_size

---

## Workload

- Endpoint: `GET /api/posts`
- Rows seeded: 200 (default 30/page → ~6 KiB JSON per response)
- Auth: anonymous (no Authorization header) / admin / user
- Compression: gzip enabled / disabled

---

## oha — c=50, 30s

```
(paste oha output here)
```

| | Value |
|---|---|
| RPS | |
| p50 | |
| p99 | |
| p99.9 | |
| Errors (4xx + 5xx) | |

## oha — c=200, 30s

```
(paste oha output here)
```

| | Value |
|---|---|
| RPS | |
| p50 | |
| p99 | |
| p99.9 | |

## oha — c=1000, 30s

```
(paste oha output here)
```

| | Value |
|---|---|
| RPS | |
| p50 | |
| p99 | |
| p99.9 | |
| Tail clusters > 500 ms | (count + ms — these mark sync I/O stalls) |

---

## /metrics snapshot

(paste `metrics-<date>.json` content here, or just the `steps` block)

| Step | p50 µs | p90 µs | p99 µs | p99.9 µs | max µs |
|---|---|---|---|---|---|
| route_match | | | | | |
| auth_verify | | | | | |
| collection_load | | | | | |
| rule_compile | | | | | |
| db_exec | | | | | |
| row_decode | | | | | |
| serialize | | | | | |
| compress | | | | | |
| log_write | | | | | |

---

## Flamegraph observations

> Where is time actually going? Top hot functions by self-time.

1.
2.
3.
4.
5.

Compare against the predicted budget in the sprint plan — note where
predictions were wrong. Predictions are wrong; the flamegraph is the
source of truth.

---

## Decisions for Phase 1 / Phase 4

> Which optimizations does the flamegraph justify? Which does it rule out?
> Sub-2% functions get skipped per the sprint rules.
