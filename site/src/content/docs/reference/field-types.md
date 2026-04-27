---
title: Field types reference
description: Every field type with its options, validation, encoding, and API shape.
---

| Type | Storage | Options | API in/out |
|---|---|---|---|
| [text](#text) | `TEXT` | `min`, `max`, `pattern`, `unique`, `encrypted` | `string` |
| [number](#number) | `REAL` | `min`, `max`, `unique` | `number` |
| [bool](#bool) | `INTEGER` (0/1) | — | `boolean` |
| [email](#email) | `TEXT` | `min`, `max`, `unique`, `encrypted` | `string` (validated) |
| [url](#url) | `TEXT` | `min`, `max`, `unique`, `encrypted` | `string` (http/https) |
| [date](#date) | `INTEGER` (unix sec) | — | in: `number` or ISO; out: `number` |
| [autodate](#autodate) | `INTEGER` | `onCreate`, `onUpdate` | server-managed |
| [select](#select) | `TEXT` (single) / `TEXT JSON` (multi) | `values` (req'd), `multiple` | `string` or `string[]` |
| [relation](#relation) | `TEXT` (target id) | `cascade` | `string` (id) |
| [file](#file) | `TEXT` (filename) / `TEXT JSON` (multi) | `maxSize`, `mimeTypes`, `multiple`, `protected` | `string` or `string[]` |
| [json](#json) | `TEXT` (JSON) | `encrypted` | any |
| [password](#password) | `TEXT` (Argon2 hash) | `min`, `max` | write-only; never returned |
| [editor](#editor) | `TEXT` (HTML) | `max` | `string` (HTML) |
| [geoPoint](#geopoint) | `TEXT JSON {lat,lng}` | — | `{lat,lng}` |

Common to all: `required`, `system` (read-only flag).

---

## text

```json
{ "name": "title", "type": "text", "required": true,
  "options": { "min": 3, "max": 200, "pattern": "^[a-z0-9-]+$", "unique": true } }
```

- `min` / `max` — character count
- `pattern` — JS regex (string)
- `unique` — DB-side check at validate time
- `encrypted` — AES-GCM at rest

## number

```json
{ "name": "age", "type": "number",
  "options": { "min": 0, "max": 120 } }
```

Stored as SQLite `REAL` — handles floats. `min`/`max` are value bounds.

## bool

```json
{ "name": "published", "type": "bool" }
```

Stored as `0`/`1` integer. API in/out is `boolean`.

## email

```json
{ "name": "email", "type": "email",
  "options": { "unique": true } }
```

Format check: `^[^\s@]+@[^\s@]+\.[^\s@]+$`. Otherwise like `text`.

## url

```json
{ "name": "site", "type": "url" }
```

Format check: must start with `http://` or `https://`.

## date

```json
{ "name": "starts_at", "type": "date" }
```

Accepts on input: unix seconds (number) or any `Date.parse`-able string.
Always returns unix seconds.

## autodate

```json
{ "name": "published_at", "type": "autodate", "onCreate": false, "onUpdate": true }
```

Server-managed. `onCreate: true` sets it on insert; `onUpdate: true`
refreshes it on every PATCH. The system fields `created` and `updated`
are autodate fields with both flags on — you can't redefine them.

## select

```json
// single
{ "name": "status", "type": "select",
  "options": { "values": ["draft", "live", "archived"] } }

// multi
{ "name": "tags", "type": "select",
  "options": { "values": ["a", "b", "c"], "multiple": true } }
```

`values` is required — empty rejects everything. Multi stored as a JSON
array; UI uses PrimeReact's MultiSelect with chips.

## relation

```json
{ "name": "author", "type": "relation",
  "collection": "users",
  "options": { "cascade": "setNull" } }
```

`collection` = target collection name (string). The record stores the
target's id.

`cascade` modes (when the referenced record is deleted):

- `"setNull"` (default) — bulk SQL update clearing the FK column.
- `"cascade"` — recursively delete referencing records (cycle-protected).
- `"restrict"` — refuse the delete with `409` while references exist.

Existence is checked at write time — pointing at a non-existent record
returns `422`.

## file

```json
{ "name": "avatar", "type": "file",
  "options": {
    "maxSize": 5242880,
    "mimeTypes": ["image/*"],
    "multiple": false,
    "protected": false
  } }
```

- `maxSize` — bytes; `0` = unlimited
- `mimeTypes` — patterns; `image/*` matches any `image/*`
- `multiple` — store an array of filenames (JSON)
- `protected` — gates GET behind a `?token=<jwt>`; see [Files](/concepts/files/)

The record stores filenames; the bytes live in `<dataDir>/uploads/`.

## json

```json
{ "name": "metadata", "type": "json",
  "options": { "encrypted": true } }
```

Any JSON-serializable value. Stored as `JSON.stringify`'d text. `encrypted`
puts the stringified value through AES-GCM at rest.

## password

```json
{ "name": "secret", "type": "password",
  "options": { "min": 8 } }
```

Hashed via `Bun.password.hash` (Argon2 by default) on write. **Never returned
from the API.** The records API automatically strips password fields from
all responses.

## editor

```json
{ "name": "body", "type": "editor", "options": { "max": 100000 } }
```

Stored as HTML string. Admin UI uses Quill for editing.

## geoPoint

```json
{ "name": "location", "type": "geoPoint" }
```

`{ lat: number, lng: number }` with `lat ∈ [-90, 90]` and `lng ∈ [-180, 180]`.
Stored as JSON.

## Implicit fields (auth collections only)

Auto-injected on auth-collection create:

- `email` — type `email`, required, unique, marked `implicit: true`
- `verified` — type `bool`, default false, marked `implicit: true`

You can edit their options but not their names or types. They're stored on
`vaultbase_users`, not the per-collection table.

## System fields

Always present, never editable, never declarable as user fields:

- `id` — text, UUID, set on create
- `created_at` (returned as `created`) — autodate onCreate
- `updated_at` (returned as `updated`) — autodate onUpdate
