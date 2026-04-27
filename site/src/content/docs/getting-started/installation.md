---
title: Installation
description: Build Vaultbase from source for your platform, or cross-compile for every target.
---

Vaultbase is distributed as source for now — `bun build --compile` produces the
target binary. Pre-built releases are on the roadmap.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.3
- A C compiler is **not** required — Bun ships its own SQLite via `bun:sqlite`.

## Local build

```bash
git clone https://github.com/vaultbase/vaultbase
cd vaultbase
bun install
bun run build           # → ./vaultbase  (or vaultbase.exe on Windows)
./vaultbase
```

This compiles the React admin (`/admin`) and embeds it into the binary via a
Bun macro that gzips and base64-encodes every static asset at compile time.
The resulting binary is ~125 MB uncompressed.

## Cross-compile

Five build targets ship with the repo:

```bash
bun run build:linux-x64          # → releases/vaultbase-linux-x64
bun run build:linux-arm64        # → releases/vaultbase-linux-arm64
bun run build:linux-x64-musl     # → releases/vaultbase-linux-x64-musl
bun run build:macos-x64          # → releases/vaultbase-macos-x64
bun run build:macos-arm64        # → releases/vaultbase-macos-arm64
bun run build:windows-x64        # → releases/vaultbase-windows-x64.exe

bun run build:all                # all five
```

You can run `bun run build:linux-x64` from a Mac — Bun cross-compiles natively.

## Compress with UPX (Linux/Windows)

```bash
brew install upx                                                       # macOS
upx --best --lzma releases/vaultbase-linux-x64                          # ~50% smaller
```

UPX runs on macOS but **does not support Mach-O for modern macOS** (codesigning
+ notarization make it unreliable). Distribute macOS binaries as `.tar.gz`
instead:

```bash
tar -C releases -czf releases/vaultbase-macos-arm64.tar.gz vaultbase-macos-arm64
```

## First run

```bash
./vaultbase                              # listens on :8091
VAULTBASE_PORT=3000 ./vaultbase          # custom port
VAULTBASE_DATA_DIR=/srv/vb ./vaultbase   # data + uploads + secrets dir
```

On first launch, Vaultbase creates `<dataDir>/` with:

- `data.db` — SQLite database
- `uploads/` — file uploads (and `.thumbs/` cache)
- `logs/YYYY-MM-DD.jsonl` — append-only request logs
- `.secret` — auto-generated JWT secret if you didn't set `VAULTBASE_JWT_SECRET`

Open <http://localhost:8091/_/> for the setup wizard.

## Run via Docker

```dockerfile
FROM debian:bookworm-slim
COPY releases/vaultbase-linux-x64 /usr/local/bin/vaultbase
EXPOSE 8091
ENV VAULTBASE_DATA_DIR=/data
VOLUME ["/data"]
CMD ["vaultbase"]
```

```bash
docker build -t vaultbase .
docker run -p 8091:8091 -v vaultbase-data:/data vaultbase
```

The single-binary story means the Dockerfile is essentially `COPY` + `CMD`.

## Configuration (env vars)

| Var | Default | Notes |
|---|---|---|
| `VAULTBASE_PORT` | `8091` | Listen port |
| `VAULTBASE_DATA_DIR` | `./vaultbase_data` | Database, uploads, logs, secrets |
| `VAULTBASE_JWT_SECRET` | auto-generated | Persisted in `<dataDir>/.secret` |
| `VAULTBASE_ENCRYPTION_KEY` | none | Required for encrypted fields. Base64 / hex / 32-char string (32 bytes) |

Runtime settings (rate limits, SMTP, OAuth credentials, email templates,
auth feature flags) live in the `vaultbase_settings` table and are edited
from the admin **Settings** page.
