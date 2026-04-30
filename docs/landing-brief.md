# Vaultbase — landing page brief

A briefing document for building the project's marketing landing page. Use it
to extract product positioning, audience, feature copy, and visual cues. The
goal is a single high-converting landing page that explains what Vaultbase
is, who it's for, and why a developer should download the binary today.

---

## One-line pitch

**A self-hosted backend in a single binary. Collections, REST API, auth,
realtime, file uploads, server-side hooks — all from one executable.**

## Two-sentence pitch

Vaultbase is an open-source, self-hosted backend that ships as one
cross-platform executable. No database to provision, no auth service to
wire up, no file storage to configure — drop the binary on a server and
you have a typed REST API, WebSocket realtime, file uploads, and an admin
UI ready to go.

## Long pitch (one paragraph)

Most "backend-as-a-service" products force a tradeoff: hosted convenience
at the cost of vendor lock-in, opaque pricing, and data gravity you can't
walk away from. Vaultbase is the opposite end of the dial. It's a single
binary you compile from open-source TypeScript, drop on any Linux / macOS
/ Windows host, and run. It owns its own embedded SQLite database, its
own auth, its own file storage, its own admin UI. Data lives in real SQL
tables you can `sqlite3 vaultbase.db` and inspect any time. Server-side
logic is plain JavaScript edited inline through the admin UI. There is
nothing to "set up" — you `./vaultbase` and you have a backend.

---

## Who it's for

Primary audience — **solo developers and small teams** who:

- Need a real backend (auth, DB, files, realtime) but don't want to glue
  Postgres + Redis + S3 + an auth service together
- Are tired of "free tier" paywalls and vendor lock-in
- Build internal tools, side projects, MVPs, or B2B apps with one to a few
  thousand users
- Prefer TypeScript and want their backend logic to feel native to that
  world
- Want to be able to download a backup and walk away from the project at
  any time

Secondary audiences:

- **Agencies and freelancers** delivering small client apps who want a
  backend they can deploy alongside the client's app on a $5 VPS
- **Hackathon / weekend-project builders** who need auth + DB + realtime
  in 60 seconds
- **Self-hosters / homelab owners** who run their own services and don't
  want to manage a Postgres cluster for a personal app

It is *not* aimed at:

- Multi-region globally distributed apps
- Teams with dedicated platform engineers who already run their own
  Postgres + Redis stack — they probably want to roll their own
- Apps with hundreds of millions of records or 100k+ concurrent
  connections

## What it replaces

A Vaultbase install removes the need for, in a typical small-app stack:

- A managed Postgres (Supabase, Neon, RDS)
- A separate auth service (Auth0, Clerk, Cognito)
- An object store with signed URLs (S3 + Lambda glue, R2)
- A realtime broker (Pusher, Ably, a Socket.IO server)
- A queue / cron host (Render cron, Inngest, Trigger.dev)
- A backend framework instance just to host the above

For the kind of project where this whole stack runs at $80–$300/month and
you spend a weekend wiring it together, Vaultbase replaces the entire
thing with one process on one box.

---

## Key differentiators (rank in order on the page)

1. **One binary.** Compiled with `bun build --compile`. Drop it on a
   server, run it, done. Cross-compiles to Linux x64, macOS arm64/x64,
   Windows x64.
2. **Real SQL, not JSON blobs.** Each collection is a real SQLite table
   (`vb_<name>`). You can hit it with `sqlite3` directly, run native
   indexes, do `ALTER TABLE`-style schema migrations. Most BaaS tools
   shove your data into a JSON column — Vaultbase doesn't.
3. **Editable from the admin UI.** Schema, API rules, server-side hooks,
   custom HTTP routes, cron jobs, queue workers — all written in
   JavaScript directly in the browser, with Monaco autocomplete typed
   to the actual collection's record shape.
4. **Batteries included.** Email + password, OAuth2 (Google, GitHub,
   GitLab, Facebook, Microsoft, Discord, Twitch, Spotify, LinkedIn,
   Slack, Bitbucket, Notion, Patreon), OTP / magic link, MFA / TOTP,
   anonymous sessions, admin impersonation, encrypted fields (AES-GCM),
   file uploads (local + S3 / R2), image thumbnails, rate limiting,
   request logs, backup / restore — all in the box.
5. **Open source, MIT.** No "open core". Self-host it, fork it, walk
   away with your binary and your `vaultbase.db` whenever you want.

## Why "Vaultbase"

The name signals: a vault for your data (you own it, it's local, it's
encrypted at rest where you ask) plus a database (the primary thing
you're getting). The product is your data's safe house, not a hosted
endpoint that happens to store it.

---

## Feature pillars (use as section blocks on the page)

### Collections + REST API

- Typed fields: `text`, `number`, `bool`, `email`, `url`, `date`, `file`
  (single or multi), `relation` (with cascade options), `select` (single
  or multi-value), `json`, `autodate`, `password` (bcrypt-hashed),
  `editor` (rich text / HTML), `geoPoint`
- Three collection types: `base` (regular), `auth` (users with login),
  `view` (read-only, backed by a SQLite VIEW you write in SQL)
- REST API with filter, sort, expand (nested relations), field
  projection (`?fields=...`), skip-total, batch operations
- Per-collection real SQL tables — fast queries, native indexes
- Field-level validation (min/max length, regex, unique, encryption)
- ALTER TABLE-style schema diffs when you edit fields in the admin UI

### Auth, fully featured

- Email + password, JWT-based with configurable per-token-kind expiry
- OAuth2 with 13 providers built in
- OTP / magic-link login (single endpoint handles both)
- MFA / TOTP with recovery codes
- Anonymous sessions (configurable JWT window — defaults to 30 days)
- Admin impersonation of any user (audited via `impersonated_by` claim)
- Email verification + password reset flows that don't leak account
  existence (no enumeration)
- Multiple admins with distinct credentials

### Realtime

- WebSocket endpoint at `/realtime`
- Topic-based subscribe — subscribe to a collection, a specific record,
  a record's children, or `*` for everything
- SSE fallback for clients that can't open WebSockets
- Per-connection auth so realtime respects API rules

### Files

- Local filesystem storage by default — zero config
- Optional S3-compatible backend (Bun's native `Bun.S3Client` works for
  AWS S3, Cloudflare R2, MinIO) with one-click R2 + S3 presets and a
  round-trip test button
- Per-field MIME and size validation
- Multi-file fields (stores an array of filenames)
- On-the-fly image thumbnails (`?thumb=WIDTHxHEIGHT`), pure JS
- Protected-URL tokens — `protected: true` on a file field gates GETs
  behind a 1-hour signed token
- Optional CDN-fronted public URLs for buckets you serve directly

### Server-side logic, in the browser

- **Record hooks** — JavaScript that runs before/after Create / Update /
  Delete events. Use them for derived fields, integrity rules, side
  effects, audit trails. Edited in Monaco with typed `ctx` autocomplete
  scoped to the collection's actual fields.
- **Custom HTTP routes** — define handlers for `/api/custom/<path>`
  with full request, params, query, body, auth, and helpers in scope.
  Replaces the "small Express service in front of Vaultbase" most
  competing tools force you to build.
- **Cron jobs** — UTC schedules with cronstrue + crontab.guru link in
  the editor, run-now button, last-run status, last-error display.
- **Queue workers** — workers that pull jobs off named queues with
  configurable concurrency, retry budget, and exponential or fixed
  backoff. Hooks/routes/cron all enqueue via the same
  `helpers.enqueue(queue, payload)` call. Dead-letter trail in an
  audit log you can retry or discard from the UI.

### Operations

- Built-in request log viewer with rule-eval inspection (which API
  rule allowed/denied each request, why, and what filter it injected)
- JSONL log files per UTC day, never deleted, with JSONPath search in
  the admin UI
- Per-rule rate limiting (per-IP token bucket, scoped to path + action +
  audience)
- One-click SQLite snapshot download / upload for backup-restore
- Cross-environment migrations via JSON schema snapshots
- AES-GCM encryption at rest for sensitive fields, gated by an env-var
  key the operator controls

---

## Stack (developer trust signals)

- **Runtime**: Bun
- **HTTP**: Elysia
- **Database**: SQLite via `bun:sqlite` (built-in, no native deps)
- **ORM**: Drizzle (schema-driven, type-safe queries)
- **Admin UI**: React 19 + Vite + React Router v7 + Zustand + Monaco
- **Single binary**: `bun build --compile` — embedded admin assets via
  Bun macro (gzip + base64 inlined into the executable)

The whole stack is TypeScript end-to-end. There are no native binaries
shipped alongside the executable — the binary is genuinely self-contained.

---

## Quick start (verbatim — keep this on the page)

```bash
bun install
bun run build           # → ./vaultbase[.exe]
./vaultbase             # serves on :8091
# open http://localhost:8091/_/  → setup wizard
```

That's the actual install. Three commands. The first run launches a
setup wizard that creates the first admin account.

## Cross-compile (also keep verbatim)

```bash
bun run build:linux-x64
bun run build:macos-arm64
bun run build:windows-x64
# or all five
bun run build:all
```

Output lands in `releases/vaultbase-<target>[.exe]`.

---

## Concrete numbers (use them)

- **One** binary
- **Single port** (`:8091` by default)
- **Zero** native dependencies to ship alongside
- **13** OAuth2 providers built in
- **14** field types
- **3** collection types (`base`, `auth`, `view`)
- **Six** record-event hook points (before/after × Create/Update/Delete)
- **MIT** licensed
- Tested with **400+** server-side tests covering auth, rules, hooks,
  files, realtime, validation, queue engine

(Update test count if it has shifted by the time the page ships.)

## Performance notes

- Bun's native SQLite driver — no native module to install, no FFI cost
- Per-collection real SQL tables — queries hit native btree indexes,
  not JSON1 functions
- In-process queue uses optimistic DB-UPDATE-based claims to avoid
  double-processing without needing Redis
- Admin assets are gzipped + base64'd into the binary — no second
  asset server required

---

## Tone & voice for the landing copy

- **Direct.** No "transform your business" marketing-speak. Developers
  reading this want to know if it'll save them a weekend.
- **Specific.** "13 OAuth2 providers", "one binary", "real SQL tables"
  beats "comprehensive auth" / "self-contained" / "powerful database".
- **Honest about scope.** Vaultbase is for small-to-medium apps on a
  single host. Don't pretend it's globally distributed; the audience
  this turns off is not the audience.
- **Confident, not arrogant.** "Replaces a stack of five managed
  services" is fine. "The only backend you'll ever need" is not.
- **Comparison-friendly.** Developers will compare against Supabase,
  Firebase, PocketBase, Appwrite. Lead with the differentiator (single
  binary, owns SQL data, edits server logic in the browser) — don't
  shy away from naming the category.

## Words to use

self-hosted · single binary · open source · MIT · TypeScript · SQLite ·
admin UI · server-side hooks · realtime · OAuth2 · MFA · encrypted ·
batteries included · cross-compile · zero config · own your data

## Words to avoid

cloud-native · enterprise-grade · ecosystem · synergy · revolutionary ·
transform · empower · unleash · seamlessly · effortlessly · supercharge

---

## Suggested page structure

1. **Hero** — one-line pitch, two CTAs (Download binary / Read the
   docs), 3-line code block showing the install
2. **Why Vaultbase** — three short cards: "One binary", "Real SQL",
   "Edit in the browser"
3. **What's in the box** — six feature pillars from above (Collections,
   Auth, Realtime, Files, Hooks/Routes/Cron/Queues, Operations) with
   one-paragraph descriptions
4. **At a glance comparison table** — Vaultbase vs Supabase vs
   PocketBase vs Firebase, on the dimensions that matter (single
   binary, owns your data, server-side logic in browser, free for
   self-host, etc.) — keep it factual and link out
5. **Quick start** — the three-command install, copy-pasteable
6. **Cross-compile** — the build commands
7. **Stack & numbers** — bullet list, builds developer trust
8. **Closing CTA** — "Download v0.1.x" + GitHub link + docs link

## Calls to action

Primary: **Download the binary** (links to GitHub releases when those
exist) or **`bun run build`** (links to quick-start guide today)

Secondary: **Read the docs** (links to the docs site)

Tertiary: **Star on GitHub** (community / social proof)

---

## Visual & content hooks

- Show the *actual* admin UI in a screenshot — collections list,
  schema editor, hooks editor with Monaco autocomplete in flight
- Include the `./vaultbase` install snippet as a literal terminal
  block above the fold — that's the whole product demo
- A short architecture diagram is fine: one box (the binary) with
  arrows in (HTTP, WebSocket, admin UI requests) and arrows out (the
  SQLite file, the uploads dir, the JSONL logs dir). The *point* of
  the diagram is to show that the box is one process and everything
  else is just files on disk.
- Avoid stock photos of laptops / servers / glowing networks. The
  audience doesn't react to those.

## Repository facts

- **Repo**: github.com/vaultbase-sh/vaultbase (canonical link in README)
- **License**: MIT
- **Status**: actively developed, pre-1.0
- **Current version**: see `package.json` and `<dataDir>/.secret` —
  the admin UI shows the running version in the sidebar footer

## What is *not* in scope for v1

Be explicit on the page (briefly) so the audience self-selects:

- Not multi-region — single process on a single host
- Not horizontally scaled — Phase 2 (Redis backend for queues + cache)
  is on the roadmap but Vaultbase is intentionally a single-box product
  in v1
- Not a managed service — there is no `vaultbase.cloud`. You host it.

This is a feature, not a limitation, for the target audience.
