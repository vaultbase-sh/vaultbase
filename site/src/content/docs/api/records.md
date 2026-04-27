---
title: Records API
description: Full reference for /api/<collection> — list, get, create, update, delete, with filter, sort, expand, projection, batch.
---

The records API is the main surface for client apps. Every base/auth/view
collection exposes the same shape under `/api/<collection_name>`.

## List

```http
GET /api/<col>
```

Query params:

| Param | Type | Default | Notes |
|---|---|---|---|
| `page` | int | 1 | 1-based |
| `perPage` | int | 30 | max enforced server-side |
| `filter` | expr | — | [Rule expression language](/concepts/rules/) |
| `sort` | string | `-created_at` | comma-sep; `-` prefix = DESC; aliases `created`/`updated` |
| `expand` | string | — | comma-sep relation field paths; nested via `.` |
| `fields` | string | — | comma-sep field whitelist for the response |
| `skipTotal` | `1`/`true` | false | omit count for faster paging |

Response:

```json
{
  "data": [ { "id": "...", ... } ],
  "page": 1,
  "perPage": 30,
  "totalItems": 42,           // -1 if skipTotal
  "totalPages": 2             // -1 if skipTotal
}
```

### Filter examples

```bash
?filter=published=true
?filter=author.id=u1 || author.id=u2
?filter=title~"hello" && created>1730000000
```

Quote string literals with double-quotes. Operators: `= != > >= < <= ~`
(substring), `&&`, `||`, parentheses.

### Sort

```bash
?sort=-created                    # newest first
?sort=author,-created             # by author asc, then newest first
?sort=-updated                    # last-modified first
```

### Expand

Inline relation targets nested in the response under `expand`:

```bash
?expand=author                       # one hop
?expand=author.profile               # two hops
?expand=author,comments              # multiple
```

```json
{
  "id": "p1", "title": "...", "author": "u1",
  "expand": {
    "author": { "id": "u1", "email": "...", "expand": { "profile": { ... } } }
  }
}
```

### Field projection

```bash
?fields=id,title
```

Returns only `id` and `title` for each row. `id` is always included.

## Get one

```http
GET /api/<col>/<id>
```

Returns `{ data: {...} }` or `404`.

## Create

```http
POST /api/<col>
Content-Type: application/json

{ "title": "hello", "body": "world" }
```

Returns the created record (with id, created, updated). Validation errors
return `422` with `details: { fieldName: message }`.

`view` collections return `405`.

## Update

```http
PATCH /api/<col>/<id>
Content-Type: application/json

{ "title": "new title" }
```

Partial update — fields not in the body stay unchanged. `view` collections
return `405`.

## Delete

```http
DELETE /api/<col>/<id>
```

Returns `{ data: null }`. View collections → `405`. Records referenced by
`restrict`-mode relations → `409` with `details` listing the blockers.

## Auth

Pass a Bearer token (user or admin):

```http
Authorization: Bearer <jwt>
```

`@request.auth.id`, `@request.auth.email`, `@request.auth.type` are then
available in API rules.

## Status codes

| Code | When |
|---|---|
| 200 | OK (list, get, update, delete) |
| 201 | Created — `POST` only |
| 400 | Malformed request |
| 401 | Unauthorized (missing/invalid token where required) |
| 403 | Forbidden (rule failed) |
| 404 | Collection or record not found |
| 405 | Write attempted on a `view` collection |
| 409 | Delete blocked by a `restrict` cascade |
| 422 | Validation failed (`details` per field) |
| 429 | Rate limit exceeded |

## See also

- [Rules](/concepts/rules/) — gating list/view/create/update/delete
- [Files](/concepts/files/) — uploads attached to records
- [Realtime](/concepts/realtime/) — live updates over WebSocket
- [Batch API](/api/batch/) — atomic multi-op transactions
