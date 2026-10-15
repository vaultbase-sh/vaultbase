# Deploy

Drop-in templates for production deployment.

## One-shot install (Linux, macOS)

```bash
curl -fsSL https://get.vaultbase.dev | sudo sh
```

What it does:
- Detects the OS (Linux / macOS), arch (x64 / arm64) and, on Linux, libc
  (glibc / musl). On Alpine it installs `libstdc++` and `libgcc`, which the
  musl build needs.
- On macOS it only installs the binary to `/usr/local/bin` (or
  `--install-dir`) and stops there. Everything below is Linux only.
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
sh -s -- --install-dir DIR    # put the binary somewhere else
```

## One-shot install (Windows)

```powershell
irm https://get.vaultbase.dev/install.ps1 | iex
```

[`install.ps1`](install.ps1) downloads `vaultbase-windows-x64.exe`, checks
it against `SHA256SUMS`, installs it to `%LOCALAPPDATA%\Programs\Vaultbase`
and adds that folder to the user `PATH`. No admin rights, no service.
Options (`-Version`, `-InstallDir`, `-VerifySig`, `-NoPath`) need the
script-block form:

```powershell
& ([scriptblock]::Create((irm https://get.vaultbase.dev/install.ps1))) -Version v0.22.0
```

## get.vaultbase.dev

[`get-worker/`](get-worker) is the Cloudflare Worker behind the domain. It
serves `install.sh` at `/` and `/install.sh`, and `install.ps1` at
`/install.ps1` (and at `/` for PowerShell user agents), always from the
latest release tag. Redeploy it with `bunx wrangler deploy` after changing
it; installer changes go live with the next release.

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
- **nginx** (manual TLS via certbot): see [`nginx/vaultbase.conf`](nginx/vaultbase.conf). Raise
  `worker_connections` in `nginx.conf` (the file's header says how); the Ubuntu default of 768
  per worker runs out at a few hundred concurrent clients and shows up as 500s.
- Don't run anything that drops the page cache (`echo 1 > /proc/sys/vm/drop_caches`, some
  "free memory" cron scripts do): it evicts the memory-mapped database and the next requests
  read it back from disk.

## Manual systemd setup

If `--no-systemd` was used or the install script wasn't applicable:

```bash
sudo cp systemd/vaultbase.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vaultbase
```

Make sure `/etc/vaultbase/vaultbase.env` exists with at least
`VAULTBASE_JWT_SECRET=<48-bytes-base64>` set.

## Read worker threads

Record list and get-one requests run on worker threads, one per spare core
by default (`VAULTBASE_READ_WORKERS`; `0` keeps everything on one thread, a
number sizes the pool, at most 8 by default). Each worker holds its own
database connection and costs roughly 50–100 MB. Writes, auth, admin, files,
realtime and user code stay on the main thread. The service log says how
many started; the admin **Monitoring** page shows them under
"read workers · forwarded".

## Cluster mode (multi-process throughput) — deprecated

Read worker threads replace this: one process now uses every core, with
one set of rate limits and realtime connections. Cluster mode still works
and prints a deprecation line at start; a later release removes it. To use
it anyway, switch the systemd unit's `ExecStart` to:

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
