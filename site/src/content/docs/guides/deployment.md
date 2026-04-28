---
title: Deployment
description: Run Vaultbase in production — bare metal, Docker, behind a reverse proxy, with TLS and persistent storage.
---

Vaultbase is a single binary plus a `<dataDir>` folder. That's the whole
deployment artifact. Treat it like SQLite + a small Node service.

## What you ship

- The binary for your target (`vaultbase-linux-x64`, `vaultbase-macos-arm64`, etc.)
- An empty data directory — Vaultbase creates the DB and folders on first run

## Bare metal

```bash
# On the server
mkdir -p /srv/vaultbase
cp vaultbase-linux-x64 /usr/local/bin/vaultbase
chmod +x /usr/local/bin/vaultbase

# systemd unit at /etc/systemd/system/vaultbase.service
[Unit]
Description=Vaultbase
After=network.target

[Service]
Type=simple
User=vaultbase
WorkingDirectory=/srv/vaultbase
Environment=VAULTBASE_DATA_DIR=/srv/vaultbase/data
Environment=VAULTBASE_PORT=8091
ExecStart=/usr/local/bin/vaultbase
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target

# Then
systemctl daemon-reload
systemctl enable --now vaultbase
```

Logs go to journald (`journalctl -u vaultbase -f`) plus the structured JSONL
logs in `<dataDir>/logs/`.

## Docker

```dockerfile
# Dockerfile
FROM debian:bookworm-slim
COPY releases/vaultbase-linux-x64 /usr/local/bin/vaultbase
RUN chmod +x /usr/local/bin/vaultbase

ENV VAULTBASE_DATA_DIR=/data
ENV VAULTBASE_PORT=8091
EXPOSE 8091
VOLUME ["/data"]

CMD ["vaultbase"]
```

```bash
docker build -t vaultbase .
docker run -d --name vaultbase \
  -p 8091:8091 \
  -v vaultbase-data:/data \
  -e VAULTBASE_JWT_SECRET="$(openssl rand -base64 32)" \
  vaultbase
```

`docker-compose.yml`:

```yaml
services:
  vaultbase:
    build: .
    restart: unless-stopped
    ports:
      - "8091:8091"
    volumes:
      - vaultbase-data:/data
    environment:
      VAULTBASE_DATA_DIR: /data
      VAULTBASE_JWT_SECRET: ${VAULTBASE_JWT_SECRET}
      VAULTBASE_ENCRYPTION_KEY: ${VAULTBASE_ENCRYPTION_KEY}

volumes:
  vaultbase-data:
```

The `linux-x64-musl` build is the right pick for Alpine-based images.

## Behind a reverse proxy

Vaultbase reads `X-Forwarded-For` for the client IP — set it on your proxy.

### Caddy

```text
# Caddyfile
api.example.com {
  reverse_proxy localhost:8091 {
    header_up X-Forwarded-For {remote_host}
    transport http {
      versions h1 h2
    }
  }
}
```

Caddy handles TLS automatically.

### Nginx

```nginx
server {
  listen 443 ssl http2;
  server_name api.example.com;

  ssl_certificate     /etc/letsencrypt/live/api.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/api.example.com/privkey.pem;

  client_max_body_size 100M;

  # WebSocket needs Upgrade headers
  location /realtime {
    proxy_pass         http://127.0.0.1:8091;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade    $http_upgrade;
    proxy_set_header   Connection "upgrade";
    proxy_set_header   X-Forwarded-For $remote_addr;
    proxy_read_timeout 86400;     # keep WS open
  }

  location / {
    proxy_pass       http://127.0.0.1:8091;
    proxy_set_header X-Forwarded-For $remote_addr;
  }
}
```

## Required env vars in production

| Var | Recommended |
|---|---|
| `VAULTBASE_JWT_SECRET` | 32+ bytes from `openssl rand -base64 32`. Persist; rotating invalidates every existing JWT. |
| `VAULTBASE_ENCRYPTION_KEY` | 32 bytes from `openssl rand -base64 32`. Required for encrypted fields. **Don't lose it** — losing it makes encrypted values unreadable. |
| `VAULTBASE_DATA_DIR` | A persistent volume — never `/tmp`. |
| `VAULTBASE_PORT` | If proxying, you can keep `:8091` and not expose it publicly. |

Auto-generated values land in `<dataDir>/.secret` if you don't set them — but
in containers/ephemeral hosts that volume might not survive restarts, so set
both explicitly.

## Health check

```http
GET /api/health
   → { "data": { "status": "ok" } }
```

Use this for k8s liveness/readiness or load-balancer health.

## Settings & data live in the DB

OAuth credentials, SMTP config, rate-limit rules, email templates, auth
feature flags — everything you'd typically configure via env vars in other
backends — live in the `vaultbase_settings` table and are edited from the
admin UI. So your deployment config is just env vars + the data directory.

To pre-seed settings (e.g. CI seeding OAuth creds), you have three options:

1. Apply a [migration snapshot](/guides/backups/) on startup that includes
   the settings.
2. Restore a backed-up `data.db` that contains them.
3. Pass a snapshot file at startup via the CLI flag (next section).

## Apply a snapshot on startup

For stateless deploys (immutable images, ephemeral containers, fresh dev
environments), pass a schema snapshot directly to the binary:

```bash
./vaultbase --apply-snapshot=schema.json --snapshot-mode=additive
```

- `--snapshot-mode=additive` (default) — creates collections that don't exist;
  leaves existing ones alone.
- `--snapshot-mode=sync` — also updates existing collections so they match.
- Both equals (`--flag=value`) and space (`--flag value`) forms work.
- Idempotent — re-running with the same file is a no-op.

On success, the binary prints `applied snapshot: N created, M updated, K
unchanged` and continues to listen normally.

On failure (missing file, invalid JSON, unknown mode, malformed snapshot, or
any per-collection error), the message is written to stderr and the process
exits with code `1` — **the server never starts**, so a broken snapshot
won't silently boot a half-applied DB.

```bash
# Typical container entrypoint
./vaultbase --apply-snapshot=/etc/vaultbase/schema.json --snapshot-mode=sync
```
