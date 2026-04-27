---
title: Collections
description: The three collection types (base, auth, view), how they differ, and when to use each.
---

A **collection** is a schema for a kind of record — like a table in a database
or a model in an ORM. Vaultbase has three collection types: `base`, `auth`,
and `view`. Each has its own storage shape and API surface.

## Quick reference

| Type | Storage | Records API | Used for |
|---|---|---|---|
| `base` | `vb_<name>` real SQL table | full CRUD | normal records (posts, products, comments...) |
| `auth` | `vaultbase_users` (shared, keyed by `collection_id`) | admin list/edit/delete; users via `/api/auth/<col>/...` | sign-in identities |
| `view` | SQLite `VIEW vb_<name>` | read-only — writes return 405 | derived/joined data |

You set the type when creating a collection from the admin UI. It can't be
changed after creation (would re-create storage and lose data).

## `base` collections

The default. Each base collection gets its own SQL table named
`vb_<collection_name>` with one column per field, plus `id`, `created_at`,
`updated_at`.

```sql
-- collection: posts with text "title" + text "body"
CREATE TABLE vb_posts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

Editing the schema runs `ALTER TABLE` to add/drop columns. **Type changes on
an existing field are blocked** — drop the field and re-add it instead.

## `auth` collections

For sign-in identities. The records *don't* live in `vb_<name>`; they live in
the shared `vaultbase_users` table with `collection_id` foreign-keying back to
the collection. Per-collection user data goes in a JSON `data` blob.

When you mark a collection as `auth`, Vaultbase auto-injects two implicit
fields you can't redefine:

- **`email`** (validated email, unique within the collection)
- **`verified`** (bool, mapped to `email_verified`)

Plus reserved names you can't use for your own fields: `email`, `password`,
`verified`, `tokenKey`, `password_hash`, `email_verified`.

User-facing endpoints live under `/api/auth/<collection>/...`:

- `POST .../register` — sign up with email + password
- `POST .../login` — sign in (returns `{token, record}` or `{mfa_required, mfa_token}`)
- `POST .../request-verify` + `.../verify-email` — email verification
- `POST .../request-password-reset` + `.../confirm-password-reset` — password reset
- `POST .../otp/request` + `.../otp/auth` — magic link / 6-digit code
- `POST .../totp/setup` + `.../confirm` + `.../disable` — TOTP MFA
- `POST .../oauth2/authorize` + `.../exchange` — OAuth2
- `POST .../anonymous` — guest sessions

Admins manage users via `GET /api/admin/users/:collection`,
`PATCH .../:id`, `DELETE .../:id`.

[Authentication →](/concepts/authentication/)

## `view` collections

Backed by a SQLite `VIEW` whose body you supply as a SQL `SELECT`. Read-only —
writes return `405 Method Not Allowed`. Useful for joins, aggregates, or
projecting subsets of other collections.

```sql
-- view collection "post_titles" with this SELECT:
SELECT id, title, created_at AS created
FROM vb_posts
WHERE published = 1
```

The schema editor renders the SELECT in a Monaco editor with autocomplete
for `vb_*` tables and their columns. A "Validate & refresh columns" button
re-runs the query at `LIMIT 0` to derive field names — defaults to `text`
type for each, which you can override afterwards.

Defaults for view collections lean **safe** — `list_rule` and `view_rule`
default to `""` (admin-only) since arbitrary SQL can read anything in the
database. Open them up explicitly via the admin UI or the API.

## Records meta

Every record returned by the API includes:

```json
{
  "id": "...",                  // text primary key (UUID)
  "collectionId": "...",        // collection's id
  "collectionName": "posts",
  "created": 1730000000,        // unix seconds
  "updated": 1730000000,
  // ...your fields
}
```

Field values follow the type encoding rules — see
[Fields & validation](/concepts/fields/).
