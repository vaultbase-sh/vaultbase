---
title: API rules
description: The expression language Vaultbase uses to gate the records API per collection.
---

Every base/auth collection has five rule slots: `list_rule`, `view_rule`,
`create_rule`, `update_rule`, `delete_rule`. View collections have only `list_rule` and `view_rule`. Each slot is one of:

- `null` — public; anyone can perform this action.
- `""` (empty string) — admin only.
- An **expression** evaluated against the record + auth context.

**Admins always bypass expression rules.**

## Expression language

```
expr   := operand op operand        single comparison
        | expr "&&" expr            logical AND
        | expr "||" expr            logical OR
        | "(" expr ")"              grouping

op     := "="  | "!="  | ">"  | ">="  | "<"  | "<="  | "~"

operand:= literal | field | "@request.auth." prop
literal:= "string" | 123 | true | null
field  := bareName       (record's column)
prop   := id | email | type
```

- `~` is substring match (case-sensitive).
- `=` and `!=` use loose equality with bool↔number coercion (matches SQL behavior).
- `@request.auth.id` is `""` when unauthenticated.
- `@request.auth.type` is `"user"` or `"admin"`.

## How rules apply

| Slot | When evaluated | Against |
|---|---|---|
| `list_rule` | `GET /api/<col>` | **Compiled into SQL filter** — applied as a `WHERE` so non-matching rows never load. |
| `view_rule` | `GET /api/<col>/:id` | The fetched record. |
| `create_rule` | `POST /api/<col>` | The incoming body. |
| `update_rule` | `PATCH /api/<col>/:id` | The existing record (pre-update). |
| `delete_rule` | `DELETE /api/<col>/:id` | The existing record. |

Failure → `403 Forbidden`.

## Examples

### Public read, admin write

```
list_rule:    null         (public)
view_rule:    null         (public)
create_rule:  ""           (admin only — empty string)
update_rule:  ""
delete_rule:  ""
```

### Owner-only read

Records have an `author` relation field. Logged-in users see only their own:

```
list_rule:  @request.auth.id = author
view_rule:  @request.auth.id = author
```

The `list_rule` becomes `WHERE author = ?` with the user's id bound at query
time. Non-matching rows never reach the application.

### Authenticated create, owner update/delete

```
create_rule:  @request.auth.id != ""
update_rule:  @request.auth.id = author
delete_rule:  @request.auth.id = author
```

### Published-or-mine

Show published posts to everyone; let authors see their drafts too:

```
list_rule:  published = true || @request.auth.id = author
```

### Admins only for everything

```
list_rule:    ""
view_rule:    ""
create_rule:  ""
update_rule:  ""
delete_rule:  ""
```

## Field references

A bare name in an expression refers to the record's column. Special aliases:

- `id` → record id
- `created` / `created_at` → created_at column
- `updated` / `updated_at` → updated_at column

Unknown fields evaluate to `undefined` — comparisons with `undefined` are
"equal to empty string / null" via the loose-equality rule.

## Authoring rules in the admin

The schema editor includes a typed autocomplete for rules — start typing
`@request.` and the popup lists `auth.id`, `auth.email`, `auth.type`. Bare
names autocomplete against the collection's actual fields. Operators are
suggested on `Tab` / `Enter`.

## Logging rule outcomes

Every records-API request records which rules evaluated and what they
returned. The admin **Logs** page surfaces:

- Rule name (`list_rule`, `view_rule`, etc.) and collection
- Expression text (or `(public)` / `(admin only)`)
- Outcome: `allow`, `deny`, or `filter` (list rule applied as SQL filter)
- Reason: `public`, `admin only`, `admin bypass`, `rule passed`, `rule failed`,
  `applied as SQL filter`

Invaluable for debugging "why am I getting 403 on this collection".
