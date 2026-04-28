---
title: Files
description: Upload, validation, multi-file fields, on-the-fly thumbnails, and protected URLs.
---

Files attach to records via fields of type `file`. By default they live on
the local filesystem at `<dataDir>/uploads/`; switch to S3 / Cloudflare R2
from **Settings → File storage** — see [Storage](/concepts/storage/).

## Schema

```json
{ "name": "avatar", "type": "file", "options": {
  "maxSize": 5242880,           // 5 MB
  "mimeTypes": ["image/*"],     // patterns; "image/*" supported
  "multiple": false,
  "protected": false
} }
```

The record stores the filename (or a JSON array of filenames if `multiple`).
The actual file lives at `<dataDir>/uploads/<id>.<ext>`.

## Upload

```http
POST /api/files/<collection>/<recordId>/<field>
Content-Type: multipart/form-data
file: <binary>
```

Server validates `maxSize` and `mimeTypes` before writing anything. Single-file
fields reject more than one upload; multi-file fields accept any count.

Response:

```json
{
  "data": {
    "id": "...",
    "filename": "...uuid....png",
    "originalName": "avatar.png",
    "size": 12345,
    "mimeType": "image/png"
  }
}
```

For multi-file uploads, `data` is an array.

## Serve

```http
GET /api/files/<filename>
```

Public by default; binary stream with the original Content-Type.

## Thumbnails

Add `?thumb=WIDTHxHEIGHT` to the GET — Vaultbase generates a thumbnail,
caches it on disk, and serves the cache on subsequent hits.

```http
GET /api/files/<filename>?thumb=200x200
GET /api/files/<filename>?thumb=64x64&fit=cover
GET /api/files/<filename>?thumb=400x300_crop          ← shorthand
```

### Fit modes

| Mode | Behavior |
|---|---|
| `contain` (default) | Fit-within: preserve aspect ratio, the longest axis matches `W` or `H`. Output may be smaller than the requested box. |
| `cover` | Center-crop the source to the target aspect ratio, then resize to exactly `WxH`. No letterboxing, no distortion. |
| `crop` | Alias for `cover`. |

Two ways to pick a mode:

```http
GET /api/files/<filename>?thumb=400x300&fit=cover
GET /api/files/<filename>?thumb=400x300_cover     ← shorthand suffix
```

The cache key includes the mode, so `contain` and `cover` thumbnails for
the same file co-exist without colliding.

- **Supported source formats**: PNG, JPEG, GIF (animated → animated thumb),
  WebP, AVIF.
- **Output**: same format as input. JPEG → JPEG (q85), PNG → PNG, GIF →
  GIF (frames preserved with original delays, disposal modes, and loop
  count; single-frame GIFs downgraded to PNG), WebP → WebP, AVIF → AVIF.
  `Content-Type` always matches what's on disk (sniffed at serve time).
- **Cache**: `<dataDir>/uploads/.thumbs/<filename>__<W>x<H>_<mode>` —
  invalidated on file delete.
- **Non-image files**: served unchanged (the `?thumb=` is silently ignored).

Range bounds: 1×1 to 4096×4096.

```bash
# Hero image, exact 1200x400, center-cropped
curl -o hero.jpg "https://api.example.com/api/files/$FN?thumb=1200x400&fit=cover"

# Avatar, 64x64 fit-within (default)
curl -o avatar.png "https://api.example.com/api/files/$FN?thumb=64x64"
```

## Protected files

Set `protected: true` on the field's options. `GET /api/files/<filename>`
then requires `?token=<jwt>`. Issue tokens via:

```http
POST /api/files/<col>/<recordId>/<field>/<filename>/token
Authorization: Bearer <admin-or-user-jwt>
```

Response:

```json
{ "data": { "token": "<jwt>", "expires_at": 1730003600 } }
```

Then:

```http
GET /api/files/<filename>?token=<jwt>
```

The token's `filename` claim is checked against the requested path — a
token for `a.png` can't unlock `b.png`. Tokens are 1-hour JWTs with
`audience: "file"`.

### Who can issue a token

Admins always pass. Authenticated users pass iff the collection's
`view_rule` would let them read the parent record:

| `view_rule` | Behavior |
|---|---|
| `null` | Public — any authenticated user can mint a token |
| `""` | Admin only — non-admins get `403` |
| Expression (e.g. `@request.auth.id = owner`) | Evaluated against the record + caller. Pass → token; fail → `403`. |

So the same rules that gate **reading** the record gate **minting a file
token** — no new policy surface to maintain.

### Admin UI auto-tokens

The bundled admin records page handles protected file previews
automatically — it mints tokens behind the scenes when rendering thumbnails
and download links, so you don't need to plumb tokens through manually
when working in the UI.

## Multi-file fields

Set `multiple: true` to store an array. The record's field is JSON-encoded:

```json
{ "attachments": ["uuid-a.pdf", "uuid-b.pdf"] }
```

Delete a single file from a multi-file field:

```http
DELETE /api/files/<col>/<recordId>/<field>/<filename>
```

Delete all files for a record's field:

```http
DELETE /api/files/<col>/<recordId>/<field>
```

## Cleanup

Vaultbase doesn't auto-delete files when their owning record is removed —
this is intentional (files might be referenced from elsewhere). Call the
DELETE endpoint explicitly when you want to free space.

Thumbnails are cleaned automatically when their source file is deleted.

## Storage backends

Two drivers ship: `local` (default, `<dataDir>/uploads/`) and `s3`
(AWS S3, Cloudflare R2, MinIO, B2 — anything S3-compatible, no SDK
required). Switch in the admin at **Settings → File storage**.

[Storage drivers →](/concepts/storage/)
