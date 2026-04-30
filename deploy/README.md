# Deploy

Drop-in templates for production deployment.

## One-shot install (Linux)

```bash
curl -fsSL https://get.vaultbase.dev | sh
```

What it does:
- Detects arch (x64 / arm64) + libc (glibc / musl).
- Downloads the matching binary from the latest GitHub release, verifies
  its SHA-256.
- Creates the `vaultbase` system user and `/var/lib/vaultbase` data dir.
- Generates a JWT secret in `/etc/vaultbase/vaultbase.env`.
- Drops a hardened systemd unit at `/etc/systemd/system/vaultbase.service`.
- Enables + starts the service.

Re-run any time to upgrade — data, config, JWT secret, admin accounts
are preserved.

Flags:

```bash
sh -s -- --version v0.1.8     # pin a specific release
sh -s -- --port 9000          # listen on a non-default port
sh -s -- --no-start           # install but don't start (configure proxy first)
sh -s -- --no-systemd         # skip unit install (containers, runit, ...)
```

## Bootstrap admin (no web wizard)

```bash
sudo vaultbase setup-admin --email you@example.com --password '<pw>'
```

CLI-only. Skips the web setup endpoint entirely — safe for headless
deploys behind a firewall before the reverse proxy is wired.

## Reverse proxy

In-process gzip / TLS were removed from Vaultbase (event-loop blockers).
Always run behind nginx / Caddy / Cloudflare in production.

- **Caddy** (auto-HTTPS): see [`caddy/Caddyfile`](caddy/Caddyfile).
- **nginx** (manual TLS via certbot): see [`nginx/vaultbase.conf`](nginx/vaultbase.conf).

## Manual systemd setup

If `--no-systemd` was used or the install script wasn't applicable:

```bash
sudo cp systemd/vaultbase.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vaultbase
```

Make sure `/etc/vaultbase/vaultbase.env` exists with at least
`VAULTBASE_JWT_SECRET=<48-bytes-base64>` set.

## Cluster mode (multi-process throughput)

Single Bun process saturates one core. For higher throughput on multi-core
hosts, switch the systemd unit's `ExecStart` to:

```ini
ExecStart=/usr/local/bin/vaultbase cluster
```

…and set `VAULTBASE_WORKERS=N` in `/etc/vaultbase/vaultbase.env`
(default = available CPU cores).

The parent process supervises N worker processes; all share the listen
port via `SO_REUSEPORT`. Crashed workers auto-respawn. SIGTERM to the
parent broadcasts to all workers, drains in flight, then exits.

- **Linux / macOS:** kernel load-balances connections across workers.
  Real-world ~0.85x per added core.
- **Windows:** orchestrator runs but the kernel does not distribute
  connections — one worker tends to win all accepts. Use cluster mode
  on Linux / macOS for performance; Windows gets fault-tolerance only.

SQLite under cluster mode (Phase 6a — current strategy): all workers
open the same DB file. WAL mode allows concurrent readers; writes
serialize on the file lock. Read-heavy workloads scale near-linearly;
write-heavy workloads may need the dedicated-writer pattern (Phase 6b).
