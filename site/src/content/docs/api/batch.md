---
title: Batch API
description: Run up to 100 record operations atomically in a single request.
---

```http
POST /api/batch
Content-Type: application/json

{
  "requests": [
    { "method": "POST",   "url": "/api/posts",            "body": { "title": "a" } },
    { "method": "POST",   "url": "/api/posts",            "body": { "title": "b" } },
    { "method": "PATCH",  "url": "/api/posts/<id>",       "body": { "title": "x" } },
    { "method": "DELETE", "url": "/api/posts/<id>" }
  ]
}
```

## Atomicity

The server wraps the batch in a `BEGIN ... COMMIT` SQLite transaction. Any
operation failing rolls back **all** of them. Either every operation succeeds
or none do.

## Limits

- **100 operations per batch.** Larger batches return `400`.
- **Max 1 MB JSON body** (Bun's default).
- **Records-API methods only** — POST/GET/PATCH/PUT/DELETE on
  `/api/<collection>` or `/api/<collection>/<id>`. Other paths (admin,
  files, auth) are rejected with a per-op error.

## Response

```json
{
  "data": [
    { "status": 201, "body": { ...created record... } },
    { "status": 201, "body": { ...created record... } },
    { "status": 200, "body": { ...updated record... } },
    { "status": 200, "body": null }
  ]
}
```

On failure (rolled back):

```json
{
  "error": "Batch failed at request 2: ...",
  "code": 422,
  "details": { ...validation details from the failing op... }
}
```

`code` reflects the failure cause — `422` for `ValidationError`, `409` for
`RestrictError`, `405` for `ReadOnlyCollectionError`, `500` otherwise.

## Auth

The whole batch runs under a single Bearer token. Per-op rules **don't**
re-evaluate today — batch ops bypass per-collection rule checks. Treat batch
as an admin-only or trusted-server feature for now (this gap is tracked in
the parity doc's Follow-ups).

## Use cases

- **Bulk imports** — see [CSV import](/api/collections/) for a higher-level
  variant.
- **Bulk deletes** — the admin UI uses batch internally for the
  Records-page bulk-delete feature.
- **Multi-write transactions** — atomic create + update sequences (e.g.
  insert an order + update inventory in one go).
