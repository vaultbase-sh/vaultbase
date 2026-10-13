<p align="center">
  <a href="https://vaultbase.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/vaultbase-wordmark.svg">
      <img src="assets/vaultbase-wordmark-light.svg" alt="Vaultbase" width="340">
    </picture>
  </a>
</p>

<p align="center">
  <strong>Your whole backend. One file.</strong><br>
  Self-hosted backend in a single binary: collections, REST, auth, realtime, files, hooks, queues and MCP for AI agents.
</p>

<p align="center">
  <a href="https://github.com/vaultbase-sh/vaultbase/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/vaultbase-sh/vaultbase?style=flat-square&color=e85a4f&label=release"></a>
  <a href="https://github.com/vaultbase-sh/vaultbase/actions/workflows/release.yml"><img alt="Release build" src="https://img.shields.io/github/actions/workflow/status/vaultbase-sh/vaultbase/release.yml?style=flat-square&label=build"></a>
  <a href="https://github.com/vaultbase-sh/vaultbase/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/vaultbase-sh/vaultbase/total?style=flat-square&color=1b1a1a"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/github/license/vaultbase-sh/vaultbase?style=flat-square&color=1b1a1a"></a>
  <br>
  <a href="https://www.npmjs.com/package/@vaultbase/sdk"><img alt="@vaultbase/sdk" src="https://img.shields.io/npm/v/@vaultbase/sdk?style=flat-square&color=e85a4f&label=%40vaultbase%2Fsdk"></a>
  <a href="https://www.npmjs.com/package/@vaultbase/mcp"><img alt="@vaultbase/mcp" src="https://img.shields.io/npm/v/@vaultbase/mcp?style=flat-square&color=e85a4f&label=%40vaultbase%2Fmcp"></a>
  <img alt="Linux · macOS · Windows" src="https://img.shields.io/badge/platforms-linux%20%C2%B7%20macos%20%C2%B7%20windows-1b1a1a?style=flat-square">
  <a href="https://bun.sh"><img alt="Built with Bun" src="https://img.shields.io/badge/built%20with-bun-1b1a1a?style=flat-square&logo=bun&logoColor=white"></a>
</p>

<p align="center">
  <a href="https://vaultbase.dev">Website</a> ·
  <a href="https://docs.vaultbase.dev">Docs</a> ·
  <a href="https://github.com/vaultbase-sh/vaultbase/releases">Releases</a> ·
  <a href="https://github.com/vaultbase-sh/sdk">TypeScript SDK</a> ·
  <a href="https://github.com/vaultbase-sh/mcp">MCP bridge</a>
</p>

## Install

Linux or macOS (detects x64 / arm64, and glibc / musl on Linux):

```bash
curl -fsSL https://get.vaultbase.dev | sudo sh
```

Windows, in PowerShell:

```powershell
irm https://get.vaultbase.dev/install.ps1 | iex
```

On Linux it installs the latest release to `/usr/local/bin/vaultbase`, creates a `vaultbase` service user and a systemd unit, and starts it on `:8091`. On macOS it installs the binary to `/usr/local/bin` and you run `vaultbase` yourself. On Windows it installs to `%LOCALAPPDATA%\Programs\Vaultbase` and adds it to your `PATH`. Open `http://localhost:8091/_/` for the setup wizard.

- `sudo sh -s -- --verify-sig` checks the binary's cosign keyless signature first (needs `cosign` on PATH).
- `--version vX.Y.Z`, `--port N`, `--no-start`, `--no-systemd`, `--install-dir DIR` are also available.
- Or download a binary from [Releases](https://github.com/vaultbase-sh/vaultbase/releases/latest).

From source:

```bash
bun install
bun run build           # admin UI + binary → ./vaultbase[.exe]
./vaultbase             # serves on :8091
```

## Features

- **Collections + REST** — real SQLite tables per collection (`vb_<name>`), 15 field types, base / auth / view collections. Filter, sort, expand, field projection, batch, ETag concurrency
- **Auth** — email + password, OAuth2 with PKCE (Google, GitHub, Apple, Microsoft, Discord, GitLab and more, plus generic OIDC), OTP / magic links, MFA / TOTP, anonymous users, admin impersonation
- **Realtime** — WebSocket + SSE; subscribe to a collection, a record, its children or `*`, checked against your API rules
- **Files** — local disk, S3 or R2; thumbnails, MIME / size validation, protected files with one-time tokens
- **Server-side logic** — hooks, custom routes, cron, queue workers, webhooks, feature flags and push notifications, edited live in the admin UI with Monaco autocomplete, or kept as TypeScript files in a `vb_hooks/` folder (with imports and npm packages) that the admin UI edits too
- **MCP for AI agents** — built-in Model Context Protocol server; tools generated per collection, scope-gated tokens, every call audited
- **Operations** — request logs, admin audit log, record history with point-in-time restore, encrypted fields (AES-GCM), backups, Prometheus metrics
- **Security** — brute-force lockout, CORS allow-list, password policy with optional HIBP check, SSRF egress guard for hooks
- **One binary** — no native deps, admin UI embedded; releases are cosign-signed with CycloneDX SBOMs

## Stack

- **Runtime**: Bun
- **Framework**: Elysia
- **DB**: SQLite (`bun:sqlite`)
- **ORM**: Drizzle
- **Admin UI**: React 19 + Vite + React Router v7 + Zustand + PrimeReact + Monaco + Quill

## Configuration (env vars)

| Var | Default | Notes |
|---|---|---|
| `VAULTBASE_PORT` | `8091` | Listen port |
| `VAULTBASE_DATA_DIR` | `./vaultbase_data` | DB, uploads, logs, secrets |
| `VAULTBASE_JWT_SECRET` | auto-generated | Persisted in `<dataDir>/.secret` |
| `VAULTBASE_ENCRYPTION_KEY` | none | Required for encrypted fields. Base64 / hex / 32-char string (32 bytes) |
| `VAULTBASE_RATE_*` | rule-based | See Settings → Rate limiting |

## Production deployment

Vaultbase is single-process, single-threaded, and **does not terminate TLS or
compress responses in-process**. Both responsibilities belong to a reverse
proxy in front of the binary — nginx, Caddy, or Cloudflare. In-process
compression was tried and removed: it blocked the event loop on
`Bun.gzipSync`, regressed RPS by ~14%, and doubled p99.9.

### Recommended topology

```
Client ── HTTPS ──> nginx / Caddy / CF ── HTTP ──> Vaultbase :8091
                       │                              │
                       │ TLS termination              │ Bun + SQLite (WAL)
                       │ gzip / brotli                │ Single binary
                       │ HTTP/2                       │
                       │ Rate limit (defense)         │
                       └──────────────────────────────┘
```

### Sample nginx config

```nginx
upstream vaultbase {
    server 127.0.0.1:8091 keepalive 64;
    keepalive_timeout 60s;
}

server {
    listen 443 ssl http2;
    server_name api.example.com;

    ssl_certificate     /etc/letsencrypt/live/api.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;

    # Compression — handled here, not in Vaultbase.
    gzip on;
    gzip_types application/json text/plain;
    gzip_min_length 1024;
    gzip_proxied any;
    gzip_vary on;

    # WebSocket realtime
    location /realtime {
        proxy_pass http://vaultbase;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_read_timeout 86400s;
    }

    location / {
        proxy_pass http://vaultbase;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Sample Caddy config

```caddyfile
api.example.com {
    encode gzip

    @ws path /realtime
    reverse_proxy @ws localhost:8091

    reverse_proxy localhost:8091 {
        header_up X-Forwarded-For {client_ip}
        header_up X-Forwarded-Proto {scheme}
    }
}
```

### Backups

```bash
# Local file
vaultbase backup --to /var/backups/vaultbase-$(date +%F).db

# Gzip
vaultbase backup --to /var/backups/snap.db --gzip

# S3 / R2 / B2 (creds via env)
AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
  vaultbase backup --to s3://my-bucket/vb/snap.db

AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... R2_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com \
  vaultbase backup --to r2://my-bucket/vb/snap.db --gzip
```

Snapshots are atomic via SQLite's `VACUUM INTO` — concurrent writers are
serialised but not blocked, and the resulting `.db` file is self-contained
(no `*-wal` / `*-shm` sidecars to copy alongside). Cron-friendly:

```cron
30 3 * * * vaultbase /usr/local/bin/vaultbase backup --to s3://bucket/vb/snap-$(date +\%F).db --gzip --quiet
```

Restore via `POST /api/admin/restore` with the snapshot bytes (admin only)
or by replacing the running DB file while the service is stopped.

## Cluster mode (multi-process)

A single Bun process is single-threaded — caps at one CPU core. For higher
throughput on multi-core hosts, use the cluster orchestrator:

```bash
# Auto: one worker per available CPU core
bun src/cluster.ts

# Or explicit count
VAULTBASE_WORKERS=4 bun src/cluster.ts

# Same via npm script
bun run start:cluster
```

The parent process spawns N workers, all sharing port `VAULTBASE_PORT` via
`Bun.serve({ reusePort: true })`. On Linux the kernel load-balances incoming
connections across workers. Workers run identical code; SQLite WAL handles
concurrent readers natively.

**Health check:** `GET /_/health` returns the responding worker's id + pid +
uptime — useful to verify load balancing.

**Graceful shutdown:** `SIGTERM` / `SIGINT` to the parent broadcasts to
workers; each drains its log buffer and closes its DB handle. 30s timeout,
then SIGKILL.

**Crashed worker → automatic restart** with 1s backoff.

**Platform notes:**
- **Linux:** full SO_REUSEPORT load balancing. ~Nx throughput on N cores
  (real ~0.85x — some contention is unavoidable).
- **macOS and Windows:** the port can be shared, but the kernel doesn't
  distribute connections: one worker takes all of them and the rest sit idle
  (measured on macOS: 4 workers, one at 100% CPU, three at 0%). Cluster mode
  runs but does not multiply throughput there. Use it for fault-tolerance
  (worker auto-restart) only; deploy on Linux for performance.

**SQLite under cluster mode (Phase 6a — current):**
All workers open the same DB file. WAL allows concurrent readers; writes
serialize on the file lock. Read-heavy workloads scale near-linearly with
worker count. Write-heavy workloads may see lock contention — measure
before adopting the dedicated-writer-process pattern.

### Operational notes

- Run Vaultbase under a process supervisor (systemd, runit, pm2). It does
  not daemonize itself.
- Back up `<dataDir>/` periodically. The single-file SQLite DB is the
  source of truth — nothing else lives outside.
- Set `VAULTBASE_JWT_SECRET` explicitly in production. The auto-generated
  fallback is per-host and will rotate if `<dataDir>/.secret` is wiped,
  invalidating every issued token.
- Set `VAULTBASE_ENCRYPTION_KEY` if you use encrypted fields. Loss of the
  key permanently corrupts those columns.

## Cross-compile

```bash
bun run build:linux-x64
bun run build:macos-arm64
bun run build:windows-x64
# or all five
bun run build:all
```

Output: `releases/vaultbase-<target>[.exe]`

## Development

```bash
bun run dev         # backend on :8091
bun run dev:admin   # admin on :5173 (proxies /api → :8090)

bun test            # backend tests
bun run typecheck
```

### Note on local `bun run build`

The compile pipeline patches `node_modules/imagescript/codecs/node/index.js`
in place to stub the native encoder (Bun `--compile` cannot bundle
dlopen-able `.node` binaries — the patched stub keeps top-level imports
working in the single-file binary; JPEG/GIF *encode* paths fall through to
PNG / @jsquash codecs).

Side effect: after running any `bun run build:*`, the imagescript native
encoder is gone from `node_modules` and 2 GIF/JPEG-encode tests will fail
locally. Restore with:

```bash
bun install --force
```

CI is unaffected (every workflow run installs fresh).

## License

MIT.
