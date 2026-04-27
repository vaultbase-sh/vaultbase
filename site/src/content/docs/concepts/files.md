---
title: Files
description: Upload, validation, multi-file fields, on-the-fly thumbnails, and protected URLs.
---

Files attach to records via fields of type `file`. Storage is on the local
filesystem at `<dataDir>/uploads/`.

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

Add `?thumb=WIDTHxHEIGHT` to the GET — Vaultbase generates a fit-within
thumbnail (preserving aspect ratio), caches it on disk, and serves the cache
on subsequent hits.

```http
GET /api/files/<filename>?thumb=200x200
GET /api/files/<filename>?thumb=64x64
```

- **Supported source formats**: PNG, JPEG, GIF (animated GIFs render as a
  static frame).
- **Output**: JPEG (quality 85) for JPEG sources, PNG otherwise.
- **Cache**: `<dataDir>/uploads/.thumbs/<filename>__<W>x<H>` — invalidated on
  file delete.
- **Non-image files**: served unchanged (the `?thumb=` is silently ignored).

Range bounds: 1×1 to 4096×4096.

## Protected files

Set `protected: true` on the field's options. `GET /api/files/<filename>`
then requires `?token=<jwt>`. Issue tokens via:

```http
POST /api/files/<col>/<recordId>/<field>/<filename>/token
Authorization: Bearer <admin-jwt>
```

Response:

```json
{ "data": { "token": "<jwt>", "expires_at": 1730003600 } }
```

Then:

```http
GET /api/files/<filename>?token=<jwt>
```

The token's `filename` claim is checked against the requested path — a token
for `a.png` can't unlock `b.png`. 1-hour TTL. Admin-only for v1.

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

Local FS only for now. S3-compatible storage is on the roadmap — see the
**Follow-ups** section in `docs/pocketbase-parity.md`.
