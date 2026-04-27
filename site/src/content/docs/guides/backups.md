---
title: Backups & migrations
description: Two complementary tools — full SQLite backup for data, JSON snapshot for schema sync across environments.
---

Vaultbase ships two distinct mechanisms for persistence portability:

- **Backup & restore** — full database snapshot (data + schema). Settings →
  Backup & restore. For disaster recovery and DB-level rollback.
- **Migrations** — JSON snapshot of the schema (no data). Settings →
  Migrations. For shipping schemas between environments.

## Backup & restore (data + schema)

```http
GET  /api/admin/backup     ← downloads the live data.db
POST /api/admin/restore    ← multipart upload, replaces data.db
```

The download is a binary `.db` file — copy it to your backup target. Restore
**replaces all current data**; the JWT signing key is unchanged so existing
tokens stay valid.

What's NOT included:

- `<dataDir>/uploads/` (file uploads — back up the filesystem separately)
- `<dataDir>/logs/` (rotate via your usual log infrastructure)
- `<dataDir>/.secret` (don't restore across hosts unless you mean to)

### Automating backups

Cron the GET endpoint with an admin token:

```bash
#!/usr/bin/env bash
set -euo pipefail
DATE=$(date -u +%Y-%m-%dT%H-%M-%SZ)
TOKEN="$ADMIN_JWT"

curl -fsS -o "/backups/vaultbase-$DATE.db" \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:8091/api/admin/backup

# Keep last 30
ls -1t /backups/vaultbase-*.db | tail -n +31 | xargs -r rm
```

For uploads, snapshot the filesystem with `restic` / `borgbackup` /
`rsync` — they're just files.

## Schema migrations (no data)

Designed for: dev → staging → prod schema sync. Round-tripping schemas via git.

### Export

**Settings → Migrations → Download snapshot** in the admin, or:

```http
GET /api/admin/migrations/snapshot
   → JSON body, downloads as vaultbase-snapshot-YYYY-MM-DD.json
```

Snapshot shape:

```json
{
  "generated_at": "2026-04-27T12:34:56.000Z",
  "version": 1,
  "collections": [
    {
      "name": "posts",
      "type": "base",
      "fields": [
        { "name": "title", "type": "text", "required": true },
        { "name": "body",  "type": "text" }
      ],
      "list_rule": null,
      "view_rule": null,
      "create_rule": "@request.auth.id != \"\""
    },
    ...
  ]
}
```

Drops the DB-only fields (`id`, `created_at`, `updated_at`) since `name` is
the cross-environment identifier.

### Apply

**Settings → Migrations → Upload & apply** with mode selector, or:

```http
POST /api/admin/migrations/apply
{
  "snapshot": { ...JSON snapshot... },
  "mode": "additive"             // default; "sync" updates existing too
}
```

Modes:

| Mode | What it does |
|---|---|
| `additive` (default, safe) | Creates missing collections. Skips existing ones — never modifies them. |
| `sync` | Also updates existing collections to match the snapshot (fields, rules, view query). **Removed fields drop their column and data.** Confirm before running. |

**Neither mode ever deletes a collection.** Drop manually if needed.

Response:

```json
{
  "data": {
    "created": ["posts", "users"],
    "updated": [],
    "skipped": ["existing_collection"],
    "errors": []
  }
}
```

### Recommended workflow

1. Build your schema in dev via the admin UI.
2. **Download snapshot** → commit `schema.json` to git.
3. CI / deploy script:
   - Spin up prod with empty `<dataDir>` (or existing).
   - Apply the snapshot (additive on first deploy, sync on follow-ups
     — gated by manual confirm).
4. App data flows in via the records API — no schema work in prod.

### Limitations

- **Type changes** within a field are blocked (would require data
  conversion). Drop + re-add the field to change a type.
- **Collection type changes** (e.g. base → auth) are blocked in sync mode —
  drop the collection manually first.
- **No diff viewer** today — you can't preview what `sync` will change before
  applying. This is on the [Follow-ups list](https://github.com/vaultbase/vaultbase/blob/main/docs/pocketbase-parity.md).

## CSV import / export (data, base collections)

For bulk data, not schemas:

- **Records page → Export** — downloads all rows of a base collection as CSV.
  Excludes password fields. Object/array values JSON-encoded into a single
  cell.
- **Records page → Import** — upload a CSV; rows go through validation; per-row
  errors returned in the response summary.

```http
GET  /api/admin/export/<collection>
POST /api/admin/import/<collection>      ← Content-Type: text/csv
```
