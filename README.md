# Vaultbase

Self-hosted backend in a single binary. PocketBase-style — collections, REST API, auth, realtime, file uploads, server-side hooks — but in TypeScript on Bun.

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
