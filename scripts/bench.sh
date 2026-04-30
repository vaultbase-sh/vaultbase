#!/usr/bin/env bash
# Benchmark regression guard.
#
# Wired into CI on every PR. Fails the build if RPS drops or p99 spikes.
#
# Assumes:
#   - Vaultbase is running on PORT (default 8091)
#   - ADMIN_TOKEN env var is set (admin JWT)
#   - The collection $COLLECTION already has ≥200 rows seeded
#
# Thresholds (override via env):
#   MIN_RPS         (default 3500)   — RPS below this fails the build
#   MAX_P99_MS      (default 30)     — p99 above this fails the build
#   MAX_ERRORS      (default 0)      — non-2xx requests above this fails
#
# Usage:
#   PORT=8091 ADMIN_TOKEN=$T COLLECTION=posts ./scripts/bench.sh
#   MIN_RPS=4000 MAX_P99_MS=25 ./scripts/bench.sh

set -euo pipefail

PORT="${PORT:-8091}"
COLLECTION="${COLLECTION:-posts}"
DURATION="${DURATION:-30s}"
CONCURRENCY="${CONCURRENCY:-50}"

MIN_RPS="${MIN_RPS:-3500}"
MAX_P99_MS="${MAX_P99_MS:-30}"
MAX_ERRORS="${MAX_ERRORS:-0}"

URL="http://127.0.0.1:${PORT}/api/${COLLECTION}"

if ! command -v oha >/dev/null 2>&1; then
  echo "ERROR: 'oha' not on PATH. cargo install oha" >&2
  exit 1
fi

# Probe — bail out immediately if the server isn't up.
if ! curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT}/api/health" | grep -q '^200$'; then
  echo "ERROR: server not responding at http://127.0.0.1:${PORT}/api/health" >&2
  exit 1
fi

OUT="$(mktemp)"
trap 'rm -f "${OUT}"' EXIT

echo "Benching: ${URL}  (-z ${DURATION} -c ${CONCURRENCY})"
oha -z "${DURATION}" -c "${CONCURRENCY}" "${URL}" \
  -H "accept-encoding: gzip" \
  --json \
  > "${OUT}"

# oha --json shape (selected fields):
#   summary.requestsPerSec
#   summary.successRate
#   latencyDistribution.p50 / .p99 / .p999  (seconds)
#   statusCodeDistribution.{2xx,3xx,4xx,5xx}
RPS=$(jq -r '.summary.requestsPerSec' "${OUT}")
P99_S=$(jq -r '.latencyPercentiles.p99' "${OUT}" 2>/dev/null || jq -r '.latencyDistribution.p99' "${OUT}")
P99_MS=$(awk "BEGIN { printf \"%.2f\", ${P99_S} * 1000 }")
ERR_5XX=$(jq -r '.statusCodeDistribution["500"] // 0' "${OUT}")
ERR_4XX=$(jq -r '[.statusCodeDistribution | to_entries[] | select(.key | startswith("4")) | .value] | add // 0' "${OUT}")
ERRORS=$((ERR_5XX + ERR_4XX))

echo
echo "── Results ──────────────────────────────"
echo "  RPS:     ${RPS}        (min ${MIN_RPS})"
echo "  p99:     ${P99_MS} ms   (max ${MAX_P99_MS} ms)"
echo "  Errors:  ${ERRORS}     (max ${MAX_ERRORS})"
echo

FAIL=0

# bash floats: use awk for comparison
if awk "BEGIN { exit !( ${RPS} < ${MIN_RPS} ) }"; then
  echo "FAIL: RPS ${RPS} < ${MIN_RPS}" >&2
  FAIL=1
fi
if awk "BEGIN { exit !( ${P99_MS} > ${MAX_P99_MS} ) }"; then
  echo "FAIL: p99 ${P99_MS} ms > ${MAX_P99_MS} ms" >&2
  FAIL=1
fi
if [ "${ERRORS}" -gt "${MAX_ERRORS}" ]; then
  echo "FAIL: ${ERRORS} non-2xx > ${MAX_ERRORS}" >&2
  FAIL=1
fi

if [ "${FAIL}" -ne 0 ]; then
  echo "Benchmark regressed. Bisect or fix before merging." >&2
  exit 1
fi

echo "PASS"
