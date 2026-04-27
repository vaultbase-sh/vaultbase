---
title: Fields & validation
description: The 13 field types Vaultbase supports, their options, and how validation runs server-side.
---

A field is one column on a collection. Vaultbase has 13 types, all with
server-side validation, type-aware encoding, and per-field options.

## Field types

| Type | SQL storage | API shape | Notes |
|---|---|---|---|
| `text` | TEXT | `string` | min/max length, regex pattern, unique |
| `number` | REAL | `number` | min/max value, unique |
| `bool` | INTEGER (0/1) | `boolean` | — |
| `email` | TEXT | `string` | format-validated |
| `url` | TEXT | `string` | http(s) only |
| `date` | INTEGER (unix seconds) | `number` or ISO string on input | always returns number |
| `autodate` | INTEGER | `number` | server-managed; opt-in onCreate / onUpdate |
| `select` | TEXT (single) / TEXT JSON (multi) | `string` or `string[]` | values whitelist required, multi flag |
| `relation` | TEXT (target id) | `string` | target collection name; cascade behavior |
| `file` | TEXT (filename) / TEXT JSON (multi) | `string` or `string[]` | maxSize, mimeTypes, multiple, protected |
| `json` | TEXT (stringified) | `any` | round-tripped via `JSON.parse` |
| `password` | TEXT (Argon2 hash) | write-only | hashed via `Bun.password.hash`; never returned |
| `editor` | TEXT (HTML) | `string` | Quill rich text in admin |
| `geoPoint` | TEXT JSON `{lat,lng}` | `{lat,lng}` | lat ∈ [-90,90], lng ∈ [-180,180] |

## Field options

All types accept these via the schema editor's options panel:

- `required: bool` — non-empty on create; for update, only checked if the
  field is provided (allows partial updates).
- `unique: bool` — DB-side uniqueness check at validate time.

Type-specific options:

```ts
// FieldOptions
{
  // text / email / url / editor
  min?: number;
  max?: number;
  pattern?: string;       // regex; text only

  // select
  values?: string[];      // required allowlist
  multiple?: boolean;     // multi-select → string[]

  // file
  maxSize?: number;       // bytes
  mimeTypes?: string[];   // patterns; "image/*" supported
  multiple?: boolean;
  protected?: boolean;    // gates GET behind a token — see Files

  // relation
  cascade?: "setNull" | "cascade" | "restrict";

  // text / json (encryptable types)
  encrypted?: boolean;    // AES-GCM at rest, requires VAULTBASE_ENCRYPTION_KEY
}
```

## Validation flow

Every create/update goes through `validateRecord()`:

1. Skip system fields, implicit fields (auth `email`/`verified`), and
   `autodate` fields.
2. For each remaining field:
   - Required check (create only — empty allowed on update unless explicitly
     `required`).
   - Type check + per-type rules (length, range, pattern, format, allowed values).
   - Unique check (DB query against `vb_<col>`).
   - Relation existence check (DB query against the target table).
3. Aggregate all errors into a single `ValidationError` — the API returns
   `422` with `details: { fieldName: message }` so clients can surface
   per-field errors at once.

Multi-error response example:

```json
{
  "error": "Validation failed",
  "code": 422,
  "details": {
    "title": "title must be at least 3 characters",
    "age": "age must be at least 18"
  }
}
```

## Relation cascade

When you delete a record, Vaultbase finds every other collection with a
relation field pointing at this one and applies the configured behavior:

- **`setNull`** (default) — bulk `UPDATE` clearing the foreign key column.
- **`cascade`** — recursively delete referencing records (chains through
  multiple levels; cycle-protected).
- **`restrict`** — refuse the delete with `409` while references exist.

## Encrypted fields

For text/email/url/json fields, set `encrypted: true` in the options. Values
are encrypted with AES-GCM before insert (using `VAULTBASE_ENCRYPTION_KEY`)
and decrypted on read. Set the key once and persist it — losing it makes
encrypted values unreadable.

```bash
# Generate a 32-byte key (base64)
openssl rand -base64 32
export VAULTBASE_ENCRYPTION_KEY="<output>"
```

## System fields

These are auto-generated and read-only:

- `id` — UUID, set on create
- `created_at` (returned as `created`) — unix seconds, set on create
- `updated_at` (returned as `updated`) — unix seconds, refreshed on every update

Don't define your own fields with these names.
