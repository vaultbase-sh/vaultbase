#!/usr/bin/env bash
# Capture a CPU profile of the running server under sustained load.
#
# Outputs:
#   docs/perf/profile-<stamp>.cpuprofile  — V8 CPU profile (open in Chrome DevTools)
#   docs/perf/profile-<stamp>.txt          — flat summary (top hot functions)
#
# Usage:
#   PORT=8091 ADMIN_TOKEN=$T COLLECTION=posts ./scripts/profile.sh
#   PORT=8091 ADMIN_TOKEN=$T COLLECTION=posts DURATION=30s CONCURRENCY=50 ./scripts/profile.sh
#
# Requires:
#   - bun (running the server)
#   - oha (https://github.com/hatoo/oha) for sustained load
#   - chrome / chromium (for opening the profile)
#
# Strategy:
#   Bun supports `--inspect=<port>` exposing the V8 inspector. We start the
#   server with the inspector enabled, attach a profiler script that begins
#   recording, hammer it with `oha`, then stop the profiler and dump the
#   captured profile to disk.
#
#   For the first cut this script documents the manual capture flow and
#   provides the bench harness used to populate the rest of the perf docs.

set -euo pipefail

PORT="${PORT:-8091}"
DURATION="${DURATION:-30s}"
CONCURRENCY="${CONCURRENCY:-50}"
COLLECTION="${COLLECTION:-posts}"
URL="http://127.0.0.1:${PORT}/api/${COLLECTION}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PERF_DIR="${REPO_ROOT}/docs/perf"
mkdir -p "${PERF_DIR}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_PROFILE="${PERF_DIR}/profile-${STAMP}.cpuprofile"
OUT_SUMMARY="${PERF_DIR}/profile-${STAMP}.txt"

if ! command -v oha >/dev/null 2>&1; then
  echo "ERROR: 'oha' not found on PATH. Install:" >&2
  echo "  cargo install oha   # macOS / Linux" >&2
  echo "  scoop install oha   # Windows" >&2
  exit 1
fi

echo "── Vaultbase profile capture ──────────────────────────────────────"
echo "URL:          ${URL}"
echo "Duration:     ${DURATION}"
echo "Concurrency:  ${CONCURRENCY}"
echo "Output:       ${OUT_PROFILE}"
echo

cat <<EOF
Manual steps (Bun does not currently expose programmatic CPU-profile dump):

  1. In a separate terminal, start the server with the V8 inspector:

       cd vaultbase
       bun --inspect=9229 src/index.ts

  2. Open chrome://inspect in Chrome / Chromium → 'Inspect' the bun target.
     Switch to the Profiler tab → 'Start'.

  3. Press <Enter> here when the profiler is recording.
EOF

read -r -p "Press <Enter> when the V8 profiler is recording > " _

echo
echo "Running oha for ${DURATION} at concurrency ${CONCURRENCY}..."
oha -z "${DURATION}" -c "${CONCURRENCY}" "${URL}" \
  -H "accept-encoding: gzip" \
  | tee "${OUT_SUMMARY}"

echo
cat <<EOF
  4. In Chrome DevTools, click 'Stop' on the profiler.
  5. Right-click the captured profile → 'Save profile…'.
  6. Save to:  ${OUT_PROFILE}

When the file is in place, also fetch the live /metrics snapshot:

  curl -s -H "Authorization: Bearer \${ADMIN_TOKEN}" \\
    "http://127.0.0.1:${PORT}/_/metrics" \\
    > "${PERF_DIR}/metrics-${STAMP}.json"

EOF
