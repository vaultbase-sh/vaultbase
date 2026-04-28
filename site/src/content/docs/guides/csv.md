---
title: CSV import / export
description: Bulk-load records into a base collection from a CSV, or export every row as CSV — one click in the admin or one HTTP call.
---

For schema portability use [migration snapshots](/guides/backups/). For
**data** portability — moving records between environments, importing seed
data, exporting a snapshot to a spreadsheet — use CSV.

Available on **base** collections only (auth and view collections aren't
exposed). Open the Records page for a collection and look at the toolbar.

## Export

```http
GET /api/admin/export/<collection>     ← admin auth
   → text/csv response, served as a download
```

Or click **Export CSV** on the Records page. The downloaded file:

- Includes every column except `password` fields (always stripped — they're
  Argon2 hashes, never exportable).
- JSON-encodes object/array values (e.g. multi-select `["a","b"]`, file
  fields with `multiple: true`, `geoPoint`, `json` fields) into a single
  cell — round-trippable on import.
- Uses the system column names (`id`, `created_at`, `updated_at`) — same
  header line you'd write back when re-importing.

```csv
id,title,body,published,tags,created_at,updated_at
abc123,Hello,World,true,"[""a"",""b""]",1730000000,1730000123
```

Excel / Google Sheets / `xsv` / `pandas.read_csv` all open this without
issue. CSV escaping follows RFC 4180 (double-quote everything containing
commas, quotes, or newlines; double-up quote chars inside).

## Import

```http
POST /api/admin/import/<collection>     ← admin auth
Content-Type: text/csv

<csv body>
   → { "data": { "imported": 42, "errors": [ { "row": 7, "error": "..." } ] } }
```

Or use **Import CSV** on the Records page (file picker → preview →
confirm).

### What happens per row

1. Parse the CSV row into a record-shaped object using the header line.
2. Run it through the standard `validateRecord()` pipeline — same
   [validation rules](/concepts/fields/) as the records API.
3. Insert into `vb_<collection>` with a fresh UUID (or the supplied `id`,
   if the column is present and non-empty).
4. On error, push `{ row: <index>, error: <message> }` into `errors` and
   continue with the next row.

The whole import runs in one transaction — if any row throws an error
that isn't validation (e.g. SQL constraint violation), the whole batch
rolls back.

### Headers Vaultbase recognizes

| Header | Effect |
|---|---|
| `id` | Use this as the record id (UUID-format). Skip / leave empty for auto. |
| `created_at` / `updated_at` | Restored verbatim. Useful for round-trips. |
| Any field name | Mapped to the field by exact match. |
| Unknown column | Ignored with a warning per row in the response. |

For multi-value or JSON columns, supply the JSON-encoded form just like
export produces:

```csv
id,tags,metadata
,"[""a"",""b""]","{""color"":""blue""}"
```

### Common errors

```json
{ "row": 3, "error": "title must be at least 3 characters" }
{ "row": 7, "error": "duplicate value for unique field email" }
{ "row": 11, "error": "relation author: no record with id u_xxx" }
```

These are the same `details` strings the records API returns on `422` —
fix them in the spreadsheet and re-upload the failed rows.

## Limits

- **No row limit** — but very large imports lock the SQLite writer; chunk
  to ~1k rows per request if you're loading hundreds of thousands.
- **Export is streamed**: the response body is a `ReadableStream` that pages
  through `listRecords` in batches of 500. Memory stays bounded regardless
  of collection size; client disconnects stop paging via `cancel()`.
- **Import is buffered**: `POST /api/admin/import/:collection` parses the
  whole file into memory before processing. Chunk huge imports manually if
  you're loading hundreds of thousands of rows.
- **Files aren't included**: file-type fields hold the *filename* only;
  the actual bytes need to be uploaded separately via the Files API.

## Round-trip workflow

A common use case — export from prod, edit in a spreadsheet, re-import:

```bash
# 1. Export
curl -H "Authorization: Bearer $ADMIN" \
  http://prod.example.com/api/admin/export/posts > posts.csv

# 2. Edit posts.csv in Excel / Sheets / vim

# 3. Re-import (creates new records — id column is empty, so UUIDs are minted)
curl -X POST -H "Authorization: Bearer $ADMIN" \
  -H "Content-Type: text/csv" \
  --data-binary @posts.csv \
  http://staging.example.com/api/admin/import/posts
```

To **update** existing records via CSV instead of inserting new ones, keep
the `id` column populated — Vaultbase recognizes pre-existing ids and
issues `PATCH` semantics for those rows. New ids → `POST`. Mix both in one
file if you like.

## See also

- [Backups & migrations](/guides/backups/) — schema-only snapshots.
- [Batch API](/api/batch/) — atomic multi-op transactions for programmatic
  bulk writes.
