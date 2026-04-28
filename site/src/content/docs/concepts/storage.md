---
title: Storage (S3 / R2)
description: File storage backends — local filesystem (default) or S3-compatible object storage like AWS S3 or Cloudflare R2.
---

Vaultbase has a pluggable storage layer for uploaded files. Two drivers ship
out of the box:

| Driver | Where bytes live | Best for |
|---|---|---|
| `local` (default) | `<dataDir>/uploads/` on the same disk as `data.db` | small / single-server deploys |
| `s3` | Any S3-compatible bucket (AWS S3, Cloudflare R2, Backblaze B2, MinIO…) | multi-region, CDN-fronted, large-file workloads |

Driver and credentials live in the `vaultbase_settings` table — no env vars
needed. Switch from the admin UI at **Settings → File storage**.

## Local (default)

No setup — the binary writes files to `<dataDir>/uploads/<filename>` on first
upload. Same path layout used since v0.

```
<dataDir>/uploads/
  <uuid>.png
  <uuid>.pdf
  .thumbs/
    <uuid>.png__200x200
```

The `.thumbs/` cache always lives on local disk, even when the primary
storage is S3 — thumbnails are CPU-bound and tiny, no point round-tripping
them to S3.

## S3 / Cloudflare R2

Vaultbase talks to S3 via Bun's native `Bun.S3Client` — no `@aws-sdk/*`
dependency, no SDK to ship. Any S3-compatible service that speaks the v4
sigv4 protocol works.

### 1. Create the bucket

**Cloudflare R2** (recommended — zero egress fees):

1. Log into Cloudflare → R2 → **Create bucket** (e.g. `vaultbase-prod`).
2. Bucket → **Settings → R2.dev subdomain** if you want a public URL, or
   leave it private and let Vaultbase proxy bytes through `/api/files/...`.
3. Account → **R2 API tokens → Create token** with read/write scope on the
   bucket.

**AWS S3**:

1. S3 console → **Create bucket** (e.g. `vaultbase-prod`).
2. IAM → **Create user** with the `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`,
   and `s3:ListBucket` permissions on `arn:aws:s3:::vaultbase-prod/*`.
3. Generate an access key for that user.

### 2. Configure in Vaultbase

**Settings → File storage** in the admin:

| Field | Example |
|---|---|
| Driver | `s3` |
| Endpoint | R2: `https://<account-id>.r2.cloudflarestorage.com` · AWS: leave blank |
| Bucket | `vaultbase-prod` |
| Region | R2: `auto` · AWS: e.g. `us-east-1` |
| Access key ID | from the API token |
| Secret access key | from the API token |
| Public URL (optional) | CDN base, e.g. `https://files.example.com` |

Hit **Test connection** — Vaultbase does a put/get/delete round-trip against
a probe key and surfaces the error inline if anything's wrong.

### 3. Switch the driver

Save with `Driver = s3`. New uploads go to the bucket immediately. Existing
files in `<dataDir>/uploads/` stay on local disk and won't be served by the
new backend — migrate them with `aws s3 cp` / `rclone sync` before
flipping the switch.

The thumb cache invalidates automatically when you change drivers.

## Settings keys

| Key | Notes |
|---|---|
| `storage.driver` | `"local"` or `"s3"` (default `"local"`) |
| `s3.endpoint` | Empty for AWS S3 (uses default), required for R2/MinIO/B2 |
| `s3.bucket` | Bucket name |
| `s3.region` | `auto` for R2, `us-east-1` etc. for AWS |
| `s3.access_key_id` | API key |
| `s3.secret_access_key` | API secret |
| `s3.public_url` | Optional. CDN/public base; lets clients fetch directly from edge |

Reading and editing programmatically:

```http
GET   /api/admin/settings
PATCH /api/admin/settings
{ "storage.driver": "s3", "s3.endpoint": "https://...", ... }
```

The storage cache invalidates on every settings PATCH (30 s TTL otherwise).

## Public URL & CDN front

If you point a CDN / R2 public hostname at the bucket and set `s3.public_url`,
Vaultbase still validates uploads (size + MIME) and writes through the API,
but server-side helpers can build CDN URLs for clients who want to fetch
bytes directly without proxying through `/api/files/*`. Files marked
`protected: true` always require a token — they're not safe to expose at the
edge.

## What stays on local disk regardless

- `<dataDir>/data.db` — SQLite database
- `<dataDir>/.secret` — JWT signing key
- `<dataDir>/logs/` — daily JSONL logs
- `<dataDir>/uploads/.thumbs/` — generated thumbnail cache

Only the user-uploaded blobs are routed through the storage driver.

## Probe / test

Round-trip check used by the **Test connection** button:

```http
POST /api/admin/storage/test     ← admin auth
   → { "data": { "ok": true,  "driver": "s3" } }
   → { "data": { "ok": false, "driver": "s3", "error": "..." } }
```

Useful to wire into your CI / deploy smoke test.

## Limits & notes

- Bun's `S3Client` is bundled with the runtime — no extra binary, no native deps.
- Multipart upload is handled transparently for large files.
- Range requests / streaming GETs work for both drivers.
- `protected: true` file fields still issue tokens — Vaultbase reads bytes
  from S3 server-side and re-streams them.
- The `<dataDir>/uploads/` directory is still created (used by thumbnail
  cache + local mode), even when running pure S3.

See [Files](/concepts/files/) for the field-level options and upload API.
