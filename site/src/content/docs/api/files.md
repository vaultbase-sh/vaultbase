---
title: Files API
description: Upload, serve, thumbnail, and protect files.
---

## Upload

```http
POST /api/files/<col>/<recordId>/<field>
Content-Type: multipart/form-data

file: <binary>
file: <binary>          ← repeat for multi-file fields
```

Validates `maxSize` and `mimeTypes` per the field options before writing.
For multi-file fields, repeat the `file` form key to upload several at once.

Single-file response:

```json
{
  "data": {
    "id": "<uuid>",
    "filename": "<uuid>.png",
    "originalName": "avatar.png",
    "size": 12345,
    "mimeType": "image/png"
  }
}
```

Multi-file response: same shape under `data: [...]`.

Errors:

- `400` — no `file` form field, or single-file field with multiple uploads
- `404` — collection or field not found
- `422` — file too large or MIME type rejected (`details: { fieldName: hint }`)

## Serve

```http
GET /api/files/<filename>
GET /api/files/<filename>?thumb=200x200
GET /api/files/<filename>?thumb=400x300&fit=cover
GET /api/files/<filename>?thumb=400x300_cover         ← shorthand
GET /api/files/<filename>?token=<jwt>
```

Returns the binary stream. Headers:

- `Content-Type` — original MIME for non-thumbs. For thumbs, the format is
  preserved end-to-end: PNG → `image/png`, JPEG → `image/jpeg`, GIF →
  `image/gif`, WebP → `image/webp`, AVIF → `image/avif`.

Query params:

| Param | Notes |
|---|---|
| `thumb` | `WIDTHxHEIGHT`, 1–4096 each axis. PNG / JPEG / GIF (animated frames preserved) / WebP / AVIF. Non-images served unchanged. Optional `_<mode>` suffix selects the fit mode. Output stays in the source format. |
| `fit` | `contain` (default) · `cover` · `crop` (alias of `cover`). `cover` center-crops the source to the target aspect, then resizes to exactly `WxH`. Cache key includes mode. |
| `token` | Required when the file's field has `protected: true`. |

## Issue a protected-file token

```http
POST /api/files/<col>/<recordId>/<field>/<filename>/token
Authorization: Bearer <admin-or-user-jwt>
```

Returns:

```json
{ "data": { "token": "<jwt>", "expires_at": 1730003600 } }
```

1-hour TTL. The token is a JWT with `audience: "file"` and a `filename`
claim; the claim is checked at GET time — a token issued for `a.png`
cannot unlock `b.png`.

**Who can issue a token:** admins always pass. Authenticated users pass
iff the collection's `view_rule` would let them read the parent record:
`null` → public, `""` → admin only, expression → evaluated.

```bash
curl -X POST \
  -H "Authorization: Bearer $JWT" \
  https://api.example.com/api/files/posts/$ID/cover/$FN/token
# → { "data": { "token": "<jwt>", "expires_at": 1730003600 } }
```

## Delete

```http
# All files for a record's field
DELETE /api/files/<col>/<recordId>/<field>

# A specific file (multi-file fields)
DELETE /api/files/<col>/<recordId>/<field>/<filename>
```

Returns `{ data: { deleted: <count> } }` or `{ data: null }`. Sweeps cached
thumbnails for the deleted file as a side effect.

## Storage layout

```
<dataDir>/uploads/
  <uuid>.png                       ← uploaded files
  <uuid>.pdf
  .thumbs/                         ← generated thumbnail cache
    <uuid>.png__200x200
    <uuid>.png__64x64
```

Vaultbase doesn't auto-delete files when the owning record is removed —
issue the DELETE explicitly. Thumb cache is auto-invalidated on file delete.

## Field options that affect files

```json
{ "name": "avatar", "type": "file", "options": {
  "maxSize": 5242880,
  "mimeTypes": ["image/*"],
  "multiple": false,
  "protected": false
} }
```

| Option | Effect |
|---|---|
| `maxSize` | Bytes, enforced at upload time. `0` or unset = unlimited. |
| `mimeTypes` | Patterns; `"image/*"` matches any `image/*` MIME. Empty = any. |
| `multiple` | Field stores a JSON array of filenames. |
| `protected` | GET requires `?token=<jwt>` from the token-issue endpoint. |
