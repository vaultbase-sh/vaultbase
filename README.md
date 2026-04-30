# Vaultbase

Self-hosted backend in a single binary — collections, REST API, auth, realtime, file uploads, server-side hooks. TypeScript on Bun.

## Quick start

```bash
# Build
bun install
bun run build           # compiles admin + binary → ./vaultbase[.exe]

# Run
./vaultbase             # serves on :8091
# Visit http://localhost:8091/_/  → setup wizard
```

## Features

- **Collections** with typed fields: `text`, `number`, `bool`, `email`, `url`, `date`, `file` (multi), `relation`, `select` (multi), `json`, `autodate`, `password` (bcrypt), `editor` (rich text), `geoPoint`
- **Per-collection real SQL tables** (not JSON blobs) — fast queries, native indexes
- **REST API** — list/get/create/update/delete with filter, sort, expand (nested), field projection, skipTotal, batch
- **Auth** — email + password, JWT (admin + user), token refresh, multi-admin
- **Realtime** — WebSocket subscribe per collection, broadcast on CRUD
- **Files** — local FS, size + MIME validation, multi-file fields
- **Hooks page** — record event hooks (before/after × Create/Update/Delete), custom HTTP routes (`/api/custom/*`), cron jobs (UTC, with cronstrue + crontab.guru link). Monaco editor with ctx IntelliSense
- **Logs** — JSONL files per UTC day, never deleted. JSONPath search
- **Rate limiting** — per-IP token bucket, per-rule (path + action + audience). Editable from Settings
- **SMTP** — full config + test button. `helpers.email()` available in hooks/routes/jobs
- **Encrypted fields** — AES-GCM via `VAULTBASE_ENCRYPTION_KEY`
- **Backup / restore** — SQLite snapshot download/upload
- **Single binary** — no native deps. Embedded admin UI (gzip+base64 via Bun macro)

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

### Cluster mode (multi-process)

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
`Bun.serve({ reusePort: true })`. The kernel load-balances incoming
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
- **macOS:** SO_REUSEPORT works since macOS 10.10. Same scaling as Linux.
- **Windows:** SO_REUSEPORT semantics differ — connections aren't
  distributed by the kernel; one worker tends to win all accepts. Cluster
  mode runs but does not multiply throughput on Windows. Use it for
  fault-tolerance (worker auto-restart) only; deploy on Linux for
  performance.

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

## License

MIT.
