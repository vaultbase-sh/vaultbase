---
title: Encrypted fields
description: AES-GCM at rest for individual field values — opt-in per field, key from env.
---

Vaultbase can encrypt the value of individual fields at rest in SQLite,
without requiring full-database encryption. Useful for storing API keys,
PII, secrets, or anything that should be protected even if `data.db` leaks.

## How it works

- **Algorithm**: AES-256-GCM (authenticated encryption — tamper-evident).
- **Key**: 32 bytes, supplied via the `VAULTBASE_ENCRYPTION_KEY` env var.
- **Format**: each value is stored as `<base64 iv>:<base64 ciphertext>:<base64 tag>`.
- **Scope**: opt-in per field via `encrypted: true` in the field's options.
- **Transparent**: the API returns plaintext on read, encrypts on write —
  clients don't see the difference.

## 1. Generate a key

```bash
openssl rand -base64 32
# → e.g. "Kx2Zb...lots-of-random-bytes...="
```

Set it as `VAULTBASE_ENCRYPTION_KEY`. The value can be:

- a base64 string (recommended; auto-decoded to 32 bytes), or
- a hex string (64 chars), or
- any 32-character ASCII string

## 2. Persist the key

Add it to your env file / systemd unit / Docker compose / k8s secret. **Never
lose this key** — there's no recovery. Vaultbase doesn't store it; if you
restart with a different key, every encrypted value becomes unreadable
ciphertext.

```bash
# .env
VAULTBASE_ENCRYPTION_KEY=Kx2Zb...random-bytes...=
```

```yaml
# docker-compose.yml
environment:
  VAULTBASE_ENCRYPTION_KEY: ${VAULTBASE_ENCRYPTION_KEY}
```

If the key is missing and you try to write to an encrypted field, the
record fails validation with a clear message — no silent fallback to
plaintext.

## 3. Mark fields encrypted

In the schema editor, expand the field options panel and toggle
**Encrypted**. Or via the API:

```http
PATCH /api/collections/<id>
{
  "fields": [
    { "name": "stripe_secret_key", "type": "text",
      "options": { "encrypted": true } },
    { "name": "metadata", "type": "json",
      "options": { "encrypted": true } }
  ]
}
```

Encryptable types: `text`, `email`, `url`, `json`. Other types either don't
make sense (`bool`, `number`, `date`) or have their own protection (`password`
is Argon2-hashed).

## What you see in the API

```http
POST /api/secrets
{ "name": "stripe", "stripe_secret_key": "sk_live_..." }
   → { "data": { "id": "...", "stripe_secret_key": "sk_live_..." } }    ← plaintext

GET /api/secrets/<id>
   → { "data": { "id": "...", "stripe_secret_key": "sk_live_..." } }    ← plaintext
```

## What's actually in `data.db`

```sql
SELECT stripe_secret_key FROM vb_secrets;
-- a3F2k...:fJk2Z...:9kL3p...    (iv:ciphertext:auth-tag, base64-encoded)
```

A SQLite dump or filesystem leak yields ciphertext only. With AES-GCM, an
attacker can't:

- decrypt without the key,
- tamper undetected (auth-tag mismatch fails the read with an error),
- correlate two ciphertexts of the same plaintext (random IV per write).

## Filtering on encrypted fields

Equality and substring filters on encrypted columns **don't work** — the
ciphertext is randomized per write, so the same plaintext won't compare
equal in SQL. If you need to filter, store a hash in a separate non-encrypted
field (e.g. SHA-256 of the email for lookup, plus the encrypted email for
display).

## Key rotation

There's no built-in rotation today. To rotate:

1. Read every encrypted record via the API (decrypts with old key).
2. Restart with the new `VAULTBASE_ENCRYPTION_KEY`.
3. Write each record back (encrypts with new key).

Tracked as a follow-up. For high-stakes deploys, accept this manual step or
roll your own re-encrypt script via [Hooks](/concepts/hooks/).

## Backups

Backed-up `data.db` files contain ciphertext. To restore on a new host you
need both:

- The DB snapshot, and
- The `VAULTBASE_ENCRYPTION_KEY` that was active when those values were written.

Treat the key like a TLS private key — back it up *separately* from the
database. Losing the key = losing the data.

## Performance

AES-GCM is ~1 GB/s on a modern CPU; for typical record sizes the overhead is
negligible (microseconds per row). Decryption happens once per row read; if
you have a hot, large table where most fields don't need encryption, leave
them unencrypted and only flag the sensitive columns.
