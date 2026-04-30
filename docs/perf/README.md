# Vaultbase performance docs

Per-phase profile + benchmark snapshots for the perf sprint. Each phase
commits its before/after numbers here so regressions are bisectable.

## Layout

- `baseline-<date>.md` — Phase 0 baseline. Run `scripts/profile.sh`
  + `scripts/bench.sh` to capture.
- `baseline-<date>.cpuprofile` — V8 CPU profile from Chrome DevTools
  (open in DevTools → Profiler).
- `metrics-<date>.json` — `/metrics` snapshot at capture time.
- `post-phase<N>-<date>.md` — re-runs after each phase.
- `final-<date>.md` — sprint conclusion.

## Capture flow

```bash
# 1. Boot the server
bun --inspect=9229 src/index.ts

# 2. In another terminal — seed + capture
ADMIN_TOKEN=<your-jwt> ROWS=200 bash scripts/seed-bench-collection.sh
ADMIN_TOKEN=<your-jwt> bash scripts/profile.sh
ADMIN_TOKEN=<your-jwt> bash scripts/bench.sh
```

Save the resulting `cpuprofile` from Chrome DevTools as
`docs/perf/baseline-<YYYYMMDD>.cpuprofile`.

## Reading the metrics

`/metrics` is admin-only. Sample query:

```bash
curl -s -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  http://127.0.0.1:8091/_/metrics | jq
```

The `steps` block buckets each request's lifecycle into nine spans:
`route_match`, `auth_verify`, `collection_load`, `rule_compile`, `db_exec`,
`row_decode`, `serialize`, `compress`, `log_write`. Histograms are bucketed
(4 sub-buckets per power of two) — quantiles are interpolated within the
target bucket so accuracy is ±~19% on the percentile value, plenty for
steering optimization decisions.

`POST /_/metrics/reset` zeros all histograms — useful between runs.
