#!/usr/bin/env bash
# Seed N rows into a `posts` collection for the bench harness.
#
# Usage:
#   PORT=8091 ADMIN_TOKEN=$T ROWS=200 ./scripts/seed-bench-collection.sh

set -euo pipefail

PORT="${PORT:-8091}"
ROWS="${ROWS:-200}"
COLLECTION="${COLLECTION:-posts}"

if [ -z "${ADMIN_TOKEN:-}" ]; then
  echo "ERROR: ADMIN_TOKEN env var is required" >&2
  exit 1
fi

# Create the collection (idempotent — 400 if exists, swallow).
curl -s -X POST "http://127.0.0.1:${PORT}/api/collections" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"${COLLECTION}\",
    \"fields\": [
      { \"name\": \"title\", \"type\": \"text\", \"required\": true },
      { \"name\": \"body\",  \"type\": \"text\" }
    ],
    \"list_rule\": null,
    \"view_rule\": null
  }" > /dev/null || true

echo "Seeding ${ROWS} rows into ${COLLECTION}..."
for i in $(seq 1 "${ROWS}"); do
  curl -s -o /dev/null -X POST "http://127.0.0.1:${PORT}/api/${COLLECTION}" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"title\": \"post-${i}\", \"body\": \"Body of post number ${i} — long enough to make the response a few KiB after 30 of them.\"}"
done

COUNT=$(curl -s "http://127.0.0.1:${PORT}/api/${COLLECTION}?perPage=1" | jq -r '.totalItems // 0')
echo "Done. ${COLLECTION} totalItems=${COUNT}"
