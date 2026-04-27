---
title: Collections API
description: Read, create, update, delete collections (admin-only).
---

All endpoints require an admin JWT.

## List

```http
GET /api/collections
   → { "data": [ {Collection}, ... ] }
```

## Get one

```http
GET /api/collections/<id_or_name>
   → { "data": {Collection} }
```

## Create

```http
POST /api/collections
{
  "name": "posts",
  "type": "base",                                  // "base" | "auth" | "view"
  "fields": [
    { "name": "title", "type": "text", "required": true },
    { "name": "body",  "type": "text" }
  ],
  "view_query": "...",                             // required for type=view
  "list_rule": null, "view_rule": null,            // null = public, "" = admin only
  "create_rule": null, "update_rule": null, "delete_rule": null
}
```

Returns the created collection. Errors:

- `400` — duplicate name (`UNIQUE constraint`)
- `422` — bad type, missing `view_query` for view, reserved field names on auth, malformed view query

For auth collections, `email` + `verified` implicit fields are auto-injected
if you don't supply them.

For view collections, `list_rule` and `view_rule` default to `""` (admin
only) when omitted — opt out by passing `null` explicitly.

## Update

```http
PATCH /api/collections/<id>
{
  "fields": [...],
  "view_query": "...",
  "list_rule": "...",
  // ...same shape as create, but partial — type can't change
}
```

Re-runs `ALTER TABLE` on field-list changes. Type changes within an existing
field are blocked — drop + re-add to change a type.

## Delete

```http
DELETE /api/collections/<id>
   → { "data": null }
```

Drops the underlying table or view. **Records are gone.** No undo.

## The `Collection` shape

```ts
interface Collection {
  id: string;
  name: string;
  type: "base" | "auth" | "view";
  fields: string;          // JSON-encoded array of FieldDef
  view_query: string | null;
  list_rule: string | null;
  view_rule: string | null;
  create_rule: string | null;
  update_rule: string | null;
  delete_rule: string | null;
  created_at: number;      // unix seconds
  updated_at: number;
}
```

## Schema migrations

Use the snapshot endpoints to ship schemas across environments:

```http
GET  /api/admin/migrations/snapshot
   → JSON file with every collection's full definition

POST /api/admin/migrations/apply
{
  "snapshot": { ...JSON snapshot... },
  "mode": "additive" | "sync"          // default "additive"
}
```

`additive` creates missing collections; `sync` also updates existing ones.
Neither deletes anything. See [Backups & migrations](/guides/backups/).

## DB indexes

Per-collection indexes are managed via:

```http
GET    /api/admin/collections/<name>/indexes
POST   /api/admin/collections/<name>/indexes  { name, columns: [], unique?: bool }
DELETE /api/admin/collections/<name>/indexes/<index_name>
```

Editable from **Schema editor → Indexes** in the admin UI.
