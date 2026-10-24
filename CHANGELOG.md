# Changelog

All notable changes to Vaultbase. Newest first. Versions before 1.0 follow
[SemVer](https://semver.org/) loosely: a minor bump (0.x.0) may change behaviour
existing installs notice; read the **Upgrade notes** before upgrading.

Binaries, checksums, signatures and SBOMs for every version are on
[GitHub Releases](https://github.com/vaultbase-sh/vaultbase/releases).

## [0.27.2] — 2026-10-24

### Fixed

- **On Postgres, a setting written for the first time could read as unset for up to 2
  seconds.** The background refresh of the settings store (every 2 s) reads the table on
  another connection; one that started while the write was in flight didn't see the new row
  and dropped the value from memory until the next refresh. A refresh now keeps the values
  whose writes were in flight when it started. Found as an intermittent OAuth test failure
  in CI.

## [0.27.1] — 2026-10-22

### Fixed

- **A read worker could keep the old rate limits for up to 5 seconds after a settings
  change.** It dropped its rate-limit, CORS, email, storage and egress caches before the new
  value reached it, so a request in between rebuilt them from the old one. They are dropped
  once the new value is in.

## [0.27.0] — 2026-10-22

### Changed

- **Search is newest first unless you ask for relevance.** A `?search=` with no `sort` was
  ordered by relevance (bm25), which scores every match before it can return a page: about
  130 ms for a word in 100k records, and the slowest request in a mixed load test. With no
  `sort` a search now returns the newest matches first and stops at the page (a word in every
  record: 3.3 ms over HTTP, from 67 ms); pass `sort=@rank` for relevance order as before. On
  Postgres, newest first is `-created`.
- **Record reads go to a read worker without passing through the main thread's request
  pipeline.** The main thread sends every list and get-one to a worker, and its time per
  request caps read throughput. Measured locally with 4 workers: get-one 43k → 46k req/s, list
  pages (38 KB) 8.7k → 9.1k req/s. Most of what remains is the HTTP server's own work.
- **Read workers accept connections themselves (Linux).** Every request used to arrive on
  the main thread, which forwarded record reads to a worker and wrote the reply out; past a
  few workers that work on one thread capped reads. Each read worker now also listens on the
  public port, and the kernel spreads connections over the main thread and the workers. A
  worker serves list and get-one itself and passes everything else (writes, auth, admin,
  files, SSE, realtime WebSockets, custom routes) to the main thread over loopback, with the
  client's address, so per-client limits and trusted proxies behave as before; rate-limit
  buckets stay on the main thread. Measured in Docker on 6 cores with 4 workers: get-one
  38.6k → 112k req/s, list pages (38 KB) 7.2k → 29.7k, writes alone −3%, an 80/20 mix on a
  270k-row table under constant writes 16.6k → 50.8k (with the stored row counts below). On
  by default on Linux; macOS and Windows don't spread connections and keep the old path.
  `VAULTBASE_WORKER_LISTENERS=0` turns it off. A slow request on a worker (a search, a filter
  on an unindexed field) now holds up the other requests on its connections, as in cluster
  mode.
- **A list with no filter reads its total from a stored row count** instead of counting the
  table. Each record table keeps its count in `vaultbase_row_counts`, updated by triggers in
  the same transaction as every insert and delete (API, hooks or raw SQL), so totals stay
  exact. The cached total was dropped on every write, so under steady writes every list
  counted the whole table again, blocking the thread serving it. Filtered lists, rules that
  add a condition and searches count as before. Existing tables get their count at the first
  start of this version (one count per table). SQLite only.

### Fixed

- **Reads served by read workers skipped the rate limiter.** Since read workers became the
  default (0.22.0), list and get-one requests answered by a worker were never counted, so no
  rate-limit rule applied to them. They are counted on the main thread before forwarding, like
  every other request.

- **A search's `totalItems` is counted on the search index** instead of joining every match
  to the table: ~30 ms → 1.5–3.4 ms for a word in 100k records. With a filter or list rule
  the matches are joined to check them, as before.

## [0.26.5] — 2026-10-20

### Fixed

- **Relation fields are indexed.** Finding records from the other side of a relation
  (`post = "<id>"`: a post's comments, a user's records) scanned the whole table, since only
  `created_at` / `updated_at` had indexes: 56 ms on 265k rows in a load test, 1.2 ms with the
  index. New and added relation fields get one, and existing collections are indexed once at
  the first start of this version (not multiple relations, which an index can't serve). In a
  mixed load test, throughput at 100 concurrent clients went from 466 to 761 req/s.
- **Dropping a field that has an index** made in the admin failed, because SQLite refuses to
  drop an indexed column. The field's indexes are dropped with it.
- **Renaming a collection renames the indexes made in the admin.** They kept the old name,
  which a new collection with that name then collided with.
- **A realtime connection over the cap** (100 per address, 10,000 per process) is refused with
  a `503` and `Retry-After` before the WebSocket upgrade. It used to get a full handshake, an
  error frame and a close, on the thread that delivers events.
- **MCP `create_collection` with a name in use** says so instead of returning the database's
  `UNIQUE constraint` error.

## [0.26.4] — 2026-10-20

### Security

- **A hook egress list made of typos is refused.** Entries that weren't CIDRs were dropped
  silently, so a deny list of only bad entries replaced the default list with nothing.
  `hooks.http.deny` / `hooks.http.allow`, trusted proxies, the lockout duration (60s minimum),
  CORS max-age and the SMTP From address are validated at save, through the admin and MCP.
- **Admin emails ignore case.** `ops@` and `OPS@` could be two accounts; sign-in and the
  uniqueness check now match without regard to case.
- **The audit log credits a password change to the admin who made it.** Changing your own
  password ends your session, and the actor was read afterwards, so the change was recorded
  as anonymous.

### Added

- **Webhook redelivery:** `POST /api/v1/admin/webhooks/<id>/deliveries/<deliveryId>/redeliver`
  queues a past delivery's payload again, and the admin's delivery drawer has a Redeliver
  button.
- **Feature-flag segments in the admin**, and rules that use `any`, `not`, segments or
  prerequisites are edited as JSON.
- `GET /api/v1/admin/runtime` returns the port and data directory the server runs with.

### Fixed

- **Log JSONPath search looked at the newest 500 entries only.** `limit` now caps the results
  returned, and `matched` counts every match.
- **Feature flags:** saving a flag in the admin dropped rules that used `any`, `not`,
  segments or prerequisites, and condition values like `"02134"` were saved as numbers.
- **Cron:** a six-field expression (with seconds) is refused; the scheduler runs at most once
  a minute, so those jobs ran late or not at all.
- **Webhooks:** a test fire on a disabled webhook is a 409 instead of a success that delivers
  nothing; egress-blocked deliveries point to Settings → Hook egress.
- **`/api/v1/admin/auth/me`** returns the admin's current email, not the one in the token.
- **Storage and SMTP test failures** return 422 with the reason (a refused connection, a bad
  key) instead of a generic 500 message.
- **Audit log:** log searches and flag evaluations are no longer recorded as changes, and
  `POST /admin/<resource>/<action>` is labelled with the action instead of `create`.
- **Admin UI**, from a full pass in a browser:
  - Errors without an `error` field, or that aren't JSON, are shown instead of read as
    success; saves and deletes say why they failed.
  - Records: empty number, relation, select and geo values save as null; JSON and vector
    fields flag invalid input; dates use a date-time picker; record history with restore;
    create users; export the selection; import errors listed; sortable columns.
  - Collections: vector, editor, geoPoint and password fields in the editor; autodate create /
    update toggles; the history toggle; a type switch keeps your fields; view errors shown as
    text; the schema table lines up at any width.
  - The theme settings colour the whole admin; the Application tab shows the real port and
    data directory; the Settings tab is kept in the URL.
  - Changing your own superuser email keeps your row editable; a password change says to sign
    in again.
  - Number inputs no longer clamp while you type; ⌘↵ runs SQL from inside the editor; Logs
    filters apply at once.
  - Fonts are served with the admin (Google Fonts was blocked by the admin's own CSP).

## [0.26.3] — 2026-10-19

### Security

- **Rules read NULL the same way for one record as for a list.** A rule like
  `status != "secret"` hid a record with no status from lists but let it through on view by
  id and on realtime, as did `tags:length = 0` on a record with no tags. Any comparison with a
  missing value is now false in both, as in SQL (`= null` / `!= null` still test for it;
  `~` / `!~` keep their SQL answers).
- **List totals no longer go stale under rules that read other collections.** With a rule
  such as `@collection.members.user = @request.auth.id`, `totalItems` was served from a cache
  that only watched the listed table, so it kept counting rows the caller could no longer see.
- **Every admin write is audited.** The audit plugin was mounted after most admin routes, so
  settings, hooks, routes, jobs, admins, backups and indexes went unrecorded, and collection
  writes (outside `/admin`) never were. All are recorded now, collections as
  `collections.create` / `update` / `delete`.
- **A failed `vaultbase backup` to S3, R2 or B2 leaves no database copy behind.** Missing
  credentials or endpoint were found after the snapshot was taken and the process exited
  before removing it, leaving a full copy of the database in the data directory. The
  destination is checked first.

### Changed

- **A file field takes only its own record's uploads.** A non-admin could set a file field
  to any stored file name, including one uploaded to someone else's record: the file then
  showed on both, and broke on the copy when its owner replaced it (the hourly sweep deletes
  a file its own record no longer names). For everyone but admins, a file name added to a
  field must now be a file uploaded to that record and field; otherwise the write is a `422`.
  Names the field already holds stay valid, so a client that sends the whole record back is
  unaffected. Creating a record with a file name is refused the same way: create it, upload
  to it, then set the field, as uploads always required. Access to a file was, and is,
  checked against the record it was uploaded to.

### Fixed

- **API tokens work as the docs show them.** A token sent as `Authorization: Bearer vbat_…`
  counted as anonymous on the records, batch, custom-route and notification APIs, and on
  realtime. The request log attributes token calls as `api:<token id>`. Admin REST routes
  (`/api/v1/admin/*`, `/api/v1/collections`) still take only an admin session; automate admin
  work through MCP.
- **Collections:**
  - `DELETE /api/v1/collections/<name>` dropped the table but kept the collection, which then
    answered 500. Deleting by name or id now deletes both; an unknown one is a 404, and
    `PATCH` takes a name too.
  - Field names that records already have (`id`, `created`, `updated`, `created_at`,
    `updated_at`, `collectionId`, `collectionName`, `expand`) are refused; `created_at` used to
    leave a collection with no table, and `created` replaced the timestamp in every record.
  - A table that can't be made rolls the collection back.
  - A singleton can have required fields (its record starts empty; required is checked on
    writes).
  - Changing a field's type is a 422, not a 500.
  - A rule (or a file field's `viewRule`) that doesn't parse is refused at save with 422 and
    the reason, instead of silently denying every caller.
- **`created` and `updated` work in filters and list rules**, as in `sort`;
  `created_at` / `updated_at` work in view rules too.
- **Creating a record in an auth collection is a 405 JSON error** pointing to sign-up, not a
  plain-text 500.
- **A dotted filter or `?=` on a field that isn't JSON** names the problem.
- **Custom routes can return a `Response`** (XML, a stream): it's sent as is, with the
  security and CORS headers added. It used to arrive as JSON `{}`.
- **`.txt` and `.json` uploads work.** The type was compared with its parameters
  (`text/plain;charset=utf-8`) and refused.
- **Rate-limit rules labelled `/api/v1/...` match.** Only `/api/...` labels did.
- **Webhooks:** a test fire reaches only that webhook, not every `*` webhook too.
- **Notifications:**
  - `helpers.notify()` inbox rows go out over realtime (and to webhooks and after-hooks).
  - When FCM reached some of a user's devices, only the failed ones are retried, so the others
    don't get the push twice.
  - Enabling a provider without a `users` auth collection says so instead of creating
    collections every notification then failed against.
- **MCP:** `update_setting` validates values and refreshes caches as `PATCH /admin/settings`
  does; a `run_sql` call refused for its scope is audited.
- **Logs:** JSONPath filters at the root (`$[?(@.status >= 400)]`, the Logs page's default)
  match entries; they used to match nothing.
- **Encryption:** a value that won't decrypt reads as null (the server log names it) instead
  of failing the request; the startup error for a mismatched key names the right fix.
- **Realtime:** the SDK's `{type: "ping"}` keepalive gets `{type: "pong"}` instead of an error.
- **CLI:** `vaultbase doctor` no longer creates the data directory or key files, and exits 2
  when the database is missing or unreadable; `--help` lists `--snapshot-mode additive|sync`.

### SDK 0.7.3

- **One client no longer affects another's session.** Every client in a process (or tab)
  shared one BroadcastChannel: one client's 401 signed the others out, and one user's
  refreshed token was written into the others' stores. It's gone; `LocalStorageAuthStore`
  still shares a session across tabs. Scripts that create a client now exit normally.
- **`vb.flags`** evaluates with the session, so `auth.*` targeting works, and no longer signs
  the user out when public evaluation is off. A 401 on any request sent without the session
  keeps the session.
- **Realtime:** a dropped SSE stream reconnects.
- A caller's own `AbortSignal` throws kind `aborted` (it was `network`).
- `vb-types` types auth records as the server returns them (`email_verified`,
  `totp_enabled`, `is_anonymous` as 0/1), and its header names the command that produced the
  file. `totpConfirm` returns `recovery_codes`.

### Docs

- Every page was checked against the server and SDK; 47 pages corrected.

## [0.26.2] — 2026-10-19

### Added

- **Upload files from the admin.** A file field in the record form had no way to change it
  (an empty one said "File upload available in v2"). It now has an Upload / Replace / Add
  files button that follows the field's allowed types and `multiple`, a remove button on
  each file, and a preview of what you just picked. The change is saved with the record, like
  any other field; an upload left unsaved is removed by the hourly file sweep. A new record
  gets its files once it's created, since files belong to an existing record.

### Changed

- **Modals, drawers and the confirm dialog look like the rest of the admin.** They were
  drawn outside the app shell, so the redesign's square corners, mono labels and inputs never
  reached them. They're square now, with a header like the page bars, and Escape or a click
  outside closes the topmost one. Dropdown panels match too. The New record form lays out its
  fields like the edit drawer.
- **SDK 0.7.2: realtime callbacks get only their own collection's events, and all of them.**
  `vb.subscribe(name, "*")` also joined the global topic and was handed every collection's
  events, and a second update to the same record within a second was dropped, so pages that
  followed a record could show stale data. `vb.subscribe("*", "*")` is how to hear every
  collection. Unsubscribing no longer drops a topic another subscription still holds.
- SDK 0.7.2: `FileMeta` and `UploadOptions` are exported; `vb.files.upload` with one `File`
  is typed as returning one `FileMeta`.

### Fixed

- **A singleton's updates reach everyone allowed to read it.** Subscribing to a singleton's
  collection (`vb.subscribe("settings", "*")`) also applied its list rule, which a singleton
  never uses and stores as admin-only, so only admins heard about changes. The view rule alone
  decides now. Subscribing by the record's id already worked.
- **A dotted filter on a field that isn't JSON is a 400.** `?filter=author.name="Ada"` (or
  any `field.key` on a relation or text field) answered 500 "malformed JSON". It's a 400 that
  says a dotted path reads inside a `json` field and that filters don't follow relations. The
  docs showed `author.id=u1`, which never worked; they now compare the relation's id.
- **An upload that isn't multipart is a 400.** A body that couldn't be parsed as form data
  answered 500 with the parser's message, on file uploads and on restoring a backup.

## [0.26.1] — 2026-10-19

### Fixed

- **`GET /api/v1/<collection>/<id>` takes `expand` and `fields`.** The OpenAPI spec and the
  docs offered both, but the record came back as stored: no `expand`, every field. Get-one
  now shapes the record with the same code as a list, so a related record the caller can't
  view is still left out of `expand`. Singletons (`GET /api/v1/<name>`) take them too, and
  the OpenAPI spec now lists them there. The
  ETag stays that of the full record, so `If-None-Match` and `If-Match` work as before.
- **`fields` no longer drops `expand`.** `?fields=id,title&expand=author` returned the two
  fields without the expansion, on lists too; `expand` is kept when the request expands.

### Changed

- SDK 0.7.1: `collection(name).get(id, { expand, fields })`. `singleton(name).get()`
  already sent them; the server now honours them. The API preview's SDK code includes them.

## [0.26.0] — 2026-10-19

### Added

- **The API preview is a small HTTP client.** Open several requests at once as tabs and
  send with ⌘/Ctrl+Enter. Each has a Params table kept in step with the URL (path values
  like `{id}` get their own fields, filled with a real record when you pick an endpoint),
  Headers, and a JSON or form-data body (file uploads included). Send it as the admin, as
  a user signed in from an auth collection (the token stays in memory), with a pasted
  token, or with no auth, to see what a rule lets others do. The response shows status,
  time, size, headers and the body pretty or raw, and the request can be copied as
  Vaultbase SDK code, `fetch()` or curl. The last 50 requests are kept in the browser;
  requests you save are kept on the server for each admin. Neither stores tokens or files.
- **The API preview's endpoints come from the instance's OpenAPI spec**, so they follow the
  collections: auth collections get their sign-in routes, singletons GET and PATCH, views
  only reads. A filter and a reload sit above the list.
- **Export menu** in the API preview: the OpenAPI spec, a Postman collection (v2.1), an
  Insomnia export (format 4) or a `.http` file for the VS Code and JetBrains REST clients,
  each with every endpoint, sample bodies and base URL and token variables.
- **Favorites in the admin sidebar.** The star on a row puts the page in a Favorites section
  at the top. Favorites are kept per admin on the server, so they follow you across
  browsers.
- **Docker image** at `ghcr.io/vaultbase-sh/vaultbase` (amd64 and arm64; tags `X.Y.Z`,
  `X.Y` and `latest`), built from each release's own checked binaries. It runs as an
  unprivileged user, takes over a root-owned `/data` volume on first start, and has a
  health check. With it: a Docker Compose file with Caddy for HTTPS, and templates for
  Render (`render.yaml`), Fly.io (`deploy/fly/fly.toml`) and Railway
  (`deploy/railway/README.md`).

### Changed

- **The admin sidebar shows less until you need it.** Feature flags, Webhooks, API tokens,
  Monitoring, API preview, SQL and the audit log stay out of the sidebar until something is
  in them, they're open, they're a favorite, or they're pinned in the new Settings →
  Sidebar. A **More** row at the bottom lists the rest, and ⌘K reaches every page (it used
  to miss several). Nothing is turned off: the API, SDK and MCP are unchanged.

### Fixed

- **OpenAPI no longer lists a create operation for auth collections.** The server refuses
  `POST /api/v1/<auth collection>` and points to `/auth/<name>/register`; the spec offered
  it anyway.
- **The API preview opened on `/api/v1/health`, which is a 404**; it now opens on
  `/api/health`.
- **On Postgres, closing the database waits for settings writes still in flight**, so a
  write can't land after shutdown has started.

### Upgrade notes

- Some admin pages leave the sidebar until they're used. Open them from **More**, with ⌘K,
  or pin them in Settings → Sidebar. Pages already in use (a flag, a webhook, an API token)
  stay where they were.
- Clients generated from the OpenAPI spec lose the create method for auth collections. It
  never worked; use the register operation.

## [0.25.0] — 2026-10-18

### Added

- **Singleton collections**, a fourth collection type for things like site settings or app
  config: exactly one record, created with the collection (fields empty). Read it with
  `GET /api/v1/<name>` and change it with `PATCH /api/v1/<name>` (ETag, If-None-Match and
  If-Match as for any record; by id works too). Creating or deleting the record answers
  405, over HTTP, in batches and through MCP, which gets `get_<name>` and `update_<name>`
  tools for it. Only the view and update rules apply. A collection can't be turned into or
  out of a singleton. Snapshots, OpenAPI, realtime and the admin UI (a Singleton type; its
  records page is one form) know the type. SDK 0.7.0 adds `vb.singleton(name)`.

- **Every email template is editable in the admin.** Settings → Email templates now covers
  the email-change, invitation and sign-in code emails as well as verification and
  password reset, each with a Restore default button and its variables listed.

### Changed

- **A large realtime fan-out no longer holds the server.** One event to many subscribers
  was sent in one synchronous loop with a rule check per subscriber; past roughly 100,000
  messages a second it took over the main thread, and HTTP requests and writes waited. In
  a load test with 10,000 subscribers at 30 events a second, the event loop stalled for
  34 s and requests timed out. Now:
  - who receives an event is decided once per event where it can be: a public collection
    needs no per-subscriber check, admin-only only looks at who's an admin, and a rule
    expression is evaluated once per distinct identity;
  - fan-outs above 2,000 deliveries go through one ordered queue that sends for a few
    milliseconds at a time, so requests are served in between, and every connection still
    gets its events in order;
  - when the queue is more than 500,000 deliveries behind (a few seconds of sending), the
    connections still waiting are disconnected so they reconnect and refetch, and their
    queued events are dropped, instead of latency and memory growing without bound. It is
    logged and counted (`vaultbase_realtime_shed_connections_total`).
- New metrics: `vaultbase_realtime_connections`, `vaultbase_realtime_queued_deliveries`,
  `vaultbase_realtime_shed_connections_total` (and the same in `/api/v1/_/metrics`).
- Bun itself now also closes a WebSocket more than 1 MB behind, as a backstop for the
  server's own check.
- **Upgrades are tested.** Databases made by seven earlier releases, back to 0.10.2, are
  booted by every build in CI: sign-ins, records, rules, settings, hooks and writes are
  checked on each.

### Upgrade notes

- Under realtime overload (the server more than a few seconds behind delivering), waiting
  connections are now disconnected instead of falling further behind. The SDK's realtime
  client reconnects and re-subscribes on its own; refetch what you show after a reconnect,
  as after any disconnect.

## [0.24.1] — 2026-10-18

### Fixed

- **A WebSocket client that stops reading no longer grows the server's memory.** Every
  realtime event was buffered for it without limit: in a load test, 50 such clients held
  about 150 MB, and one address may open 100 realtime connections. A socket more than 1 MB
  behind is now disconnected, as SSE clients already were; the others keep receiving.

## [0.24.0] — 2026-10-18

Fixes from an external technical review of 0.23.1. Every item below was reproduced first and
has a regression test that fails on 0.23.2.

### Fixed

- **Schema snapshots no longer change permissions.** Syncing a snapshot that omits rules
  turned an admin-only collection fully public, and exports left public rules out, so an
  import made them admin-only. Exports now write all five rules, public (`null`) included.
  A rule a snapshot leaves out keeps the collection's current rule on sync, and is
  admin-only when the snapshot creates the collection.
- **Date rules decide the same for a list and a single record.** The single-record checker
  (get, update, delete, files, realtime) treated `strftime(...)` as empty, so `!=`, `<` and
  `<=` rules passed there while the list denied. It now evaluates `strftime` like SQL for
  `%Y %m %d %H %M %S %j` with a stored date and `'unixepoch'`, `'now'` or a literal
  timestamp; anything it can't evaluate makes the comparison false.
- **A broken inline hook no longer turns itself off.** Hook, route, job and worker code that
  doesn't compile is refused when saved (422, admin API and MCP tools). An enabled
  `before*` hook that can't compile blocks the write instead of being skipped.
- **Write batches are all or nothing for every failure.** An op that hit a missing record
  or collection came back as a 404 entry while the ops before it committed. The batch now
  rolls back and answers that op's status (`Batch failed at request N: …`). Read-only
  batches still report each op.
- **`uniqueKey` holds under concurrency.** Ten enqueues at once with one key made ten jobs.
  A partial unique index now allows one queued-or-running job per key (keys are global
  across queues); retrying a dead job while another with its key is active answers 409.
- **Online restore with read workers.** After a restore every read the workers served
  failed with `disk I/O error` until a restart: they and the checkpointer kept their
  connections to the replaced file. Restore now stops them, swaps the file and starts them
  again, and checks the file (integrity, a Vaultbase database) before touching anything,
  answering 422 for a bad one.
- **Several servers on one Postgres (beta):**
  - Running jobs are leased (60 s, renewed every 15 s). A server starting up re-queued
    jobs another server was still running; now only an expired lease is recovered, and
    only the attempt holding the lease records its result.
  - If-Match holds across servers: a guarded write holds the record's row lock from its
    check to its commit, so two servers can't both accept one ETag.
  - Peer messages are measured in UTF-8 bytes. A record of about 3,000 Chinese characters
    passed the old character count, was refused by `NOTIFY`, and took a rule change sent
    with it down too. Record events now never share a `NOTIFY` with an invalidation,
    failed ones are retried, and a polled sequence makes a server that missed another's
    invalidation reset its caches within 10 s.
- **Every MCP tool call is audited**, over HTTP/SSE and stdio: the token's admin, the tool,
  its target (never the payload), the status and the error. Only `run_sql` was before.
- **The release workflow builds the tag it publishes.** A manual run built the default
  branch and published it under the typed tag; it now checks out the tag and fails if the
  commit doesn't match. SBOMs listed zero components; they now list the installed
  dependencies and the workflow fails on an empty one.
- **Failed log writes are counted** (`/metrics`, readiness) and reported on stderr at most
  once a minute, instead of swallowed.
- The file token response says whether the token is one-time (`one_time`), so clients
  don't cache it.
- The admin dev server proxies to port 8091, the server's default.

### Added

- **`GET /_/ready`**: the database, storage, read workers, queues and log writes. 503 when
  the server can't serve, 200 with `ready` or `degraded` and each check otherwise.
  `/_/health` stays the cheap liveness probe.
- **Prometheus series**: `vaultbase_responses_total{class}`, `vaultbase_jobs{status}`,
  `vaultbase_jobs_oldest_due_seconds`, `vaultbase_webhook_deliveries{status}`,
  `vaultbase_read_workers{state}`, `vaultbase_read_workers_dropped_total`,
  `vaultbase_read_workers_restarted_total`, `vaultbase_log_write_failures_total`,
  `vaultbase_log_lines_lost_total`.

### Upgrade notes

- **Batches with a failed op now fail.** A write batch that used to return 200 with a 404
  entry (and keep the other ops) now returns 404 and changes nothing. Check
  every op exists, or send the ops that may miss outside the batch.
- **Broken hook code now blocks writes.** An enabled `before*` hook whose code doesn't
  compile was skipped silently; its writes now fail with a 422 naming the hook. Before
  upgrading, open the Hooks page: a hook that fails to compile has logged
  `[hooks] Failed to compile hook` at every start. Fix or disable it.
- **Rules using `strftime` with formats or forms outside the list above** now deny on
  single-record checks, as the list query does.
- **Duplicate active jobs with one `uniqueKey`** are cleaned up at the first start: one
  keeps the key (a running one first, then the oldest), the others keep running without
  it.
- Snapshots exported from 0.24 carry all five rules. Applying an older snapshot no longer
  changes rules it doesn't mention.

## [0.23.2] — 2026-10-18

### Fixed

- **Read workers come back after they are dropped.** A read worker that stopped answering
  was dropped and never replaced, so one overload spike left every read on the main thread
  until a restart. A dropped worker is now replaced after a second, waiting longer (up to a
  minute) while replacements keep failing. The Monitoring page shows how many were restarted.
- **A busy read worker is no longer mistaken for a stuck one.** A request that waits 30 s
  still fails with a 503, but its worker is dropped only when it has answered nothing at all
  for that long; one that is behind under load and still answering stays.

## [0.23.1] — 2026-10-16

### Changed

- **The setup wizard shows the database.** Its first step says whether the server runs on
  SQLite or Postgres, and how to switch before the first admin is created. The setup status
  reports it until then, and no longer once an admin exists.

### Fixed

- **The setup and sign-in pages on narrow screens.** The card kept its 640-pixel width
  below that and was cut off on phones.

## [0.23.0] — 2026-10-16

### Added

- **Postgres (beta).** Set `VAULTBASE_DATABASE_URL=postgres://…` and Vaultbase runs on
  Postgres instead of the SQLite file: the schema is created and kept up to date at start,
  and records, rules, filters, full-text search (a generated `tsvector` column with a GIN
  index, accents folded with `unaccent`), expand, batch, history, files, auth, admin, MCP,
  hooks and realtime work the same. Index suggestions read Postgres plans, the
  Monitoring page shows the database size and connections, `strftime()` in filters covers
  the common codes, and backups (scheduled, S3, download) run `pg_dump` when it is
  installed. Several servers can share one database: what one changes (collections, rules,
  hooks, settings, …) takes effect on the others within milliseconds, realtime subscribers
  on every server hear of every write, and servers starting together take turns upgrading
  the schema. Not on Postgres yet, each answering with a clear error: restore from the
  backups page (use `pg_restore`), the SQL sandbox (read-only queries work) and read worker
  threads. The test suite runs against Postgres in CI. See the Databases page.
- **`helpers.sql` in hooks, routes, jobs and workers.** Asynchronous SQL with `?`
  placeholders and an array of parameters: `query`, `queryOne`, `exec` and
  `transaction(fn)`. `helpers.db` stays as it is but is deprecated: it is synchronous and
  tied to SQLite.

### Changed

- **A schema change is one transaction.** Adding, renaming or dropping fields and
  renaming a collection run inside a single transaction while record writes wait, so a
  failure (a unique index over existing duplicates, for instance) leaves the table as it
  was instead of half-changed.

### Fixed

- **Decimal and negative numbers in filters and rules.** `price >= 10.5` was read as a
  dotted path (field `10`, key `5`) and `price < -3` did not parse at all; both work now,
  in `?filter=` and in rules alike.
- **`geoDistance()` with literal coordinates.** The compiled SQL used each latitude twice
  but bound it once, so the documented radius search failed with a parameter-count error.
- **Backups right after the index-suggestions report.** Opening the report on a collection
  with full-text search left a statement open, and a backup taken in the next moments
  failed with "SQL statements in progress".
- **Writes made while a batch was running.** A batch runs one transaction on the shared
  connection and awaits its hooks inside it; a setting saved or a session revoked by
  another request in the meantime joined that transaction and was undone if the batch
  failed. They now wait for the batch to finish.

## [0.22.1] — 2026-10-15

### Changed

- **Fewer read workers by default: cores minus two.** 0.22.0 started one read worker
  per spare core (cores minus one). On a 4-vCPU host that left the main thread, which
  still parses every request and writes every reply, and the reverse proxy sharing the
  last core with a third worker, and the box answered fewer requests than it did with
  two. The default is now cores minus two, at least one on two cores or more, none on a
  single core, at most 8. `VAULTBASE_READ_WORKERS` still sets the count outright.

### Fixed

- **`autodate` fields are stored.** They were computed on create and update and then
  skipped on the way to the table, which had no column for them. They now have a column,
  the server sets them on create and update when the field opts in (`onCreate`,
  `onUpdate`), a value the client sends is dropped, and collections created before this
  release get the column at the next start.
- **Renaming a field keeps its data.** A renamed field reached the schema diff as a
  different name, so the column was dropped and a new, empty one added. The admin editor
  now sends the previous name (`renamedFrom` on the field) and the column is renamed in
  place, with its unique index and the search index following. API callers can send the
  same hint with `PATCH /api/v1/collections/<id>`.
- **Datetime macros compare correctly.** `@now`, `@todayStart` and the other datetime
  macros bound ISO-8601 strings while `date` and `autodate` fields hold Unix seconds, so a
  comparison was decided by SQLite's type ordering rather than by the dates. They are Unix
  seconds now, in filters, rules and the in-process rule evaluator alike.
- **The 1,000-row cap on `_via_` back-relations applies.** It sat on the aggregate, where
  LIMIT bounds the single output row and capped nothing.
- **Caches bound to the database connection are cleared before `closeDb` returns** (restore,
  tests), not a few ticks later.

## [0.22.0] — 2026-10-15

### Changed

- **Record reads run on worker threads by default.** The server starts one read worker per
  spare core (`VAULTBASE_READ_WORKERS`, default: cores minus one, at most 8); each has its
  own database connection and serves record list and get-one requests, while writes, auth,
  admin, files, realtime and user code stay on the main thread. A collection or settings
  change on the main thread reaches the workers at once, a write tells them which tables it
  touched so their list-totals cache keeps the rest, the Monitoring page shows their
  per-step latencies and query shapes alongside the main thread's, and
  `GET /api/v1/_/metrics` gains `read_workers` (count, forwarded, in flight, dropped). A
  worker that dies is dropped and its in-flight requests fail; a forwarded request with no
  reply within 30 s fails with 503.

### Deprecated

- **`vaultbase cluster`.** Read worker threads use every core from one process, with one
  set of rate limits and realtime connections and cache invalidation that reaches every
  thread, which cluster mode never had. It still works and prints a deprecation line at
  start; a later release removes it.

## Upgrade notes

- Each read worker costs roughly 50–100 MB (its own JavaScript heap and SQLite page
  cache). Set `VAULTBASE_READ_WORKERS=0` to keep everything on one thread, or a number to
  size the pool. In-memory databases and cluster workers never start read workers.
- The first read of a collection after start, and the first after a collection change,
  is served on the main thread while it refills its collection cache; later ones go to a
  worker. Nothing to do, just an explanation for anyone reading the Monitoring page.

## [0.21.3] — 2026-10-15

### Fixed

- **List totals stay cached across writes to other collections.** Every write used to
  empty the whole totals cache, so under a mixed workload every list recounted its total.
  Record and user writes now report their table, and only that collection's totals are
  recounted; raw SQL from a hook or the SQL page still empties everything. Inside a
  transaction the cache answers but is not filled.

### Changed

- **Deploy notes:** the nginx template's header says to raise `worker_connections` (Ubuntu's
  default of 768 per worker shows up as 500s at a few hundred concurrent clients), and the
  deploy README warns against cron jobs that drop the page cache, which evict the
  memory-mapped database.

## [0.21.2] — 2026-10-15

### Fixed

- **Idle keep-alive connections are kept for 120 s instead of 30 s.** A reverse proxy
  that holds upstream connections open longer than the server does (nginx and Caddy with
  the `deploy/` configs keep them for 60 s) reused connections the server had already
  closed, and those requests failed with "connection reset by peer" / 502 in bursts after
  quiet periods. The proxy's keepalive timeout must stay below 120 s.

## [0.21.1] — 2026-10-15

### Fixed

- **Read worker threads (experimental): a pool that fails to start no longer takes
  requests.** In 0.21.0, when `VAULTBASE_READ_WORKERS` was set and the workers could not
  start, the server logged it but still forwarded every record list and get-one to the
  missing workers, and those requests never answered. A pool that can't start now leaves
  nothing behind, a worker that dies is dropped with its in-flight requests failed, and a
  forwarded request that gets no reply within 30 s fails with 503 instead of hanging.
- **Read worker threads (experimental): the worker is included in the compiled binaries.**
  0.21.0's binaries could not start it at all (`ModuleNotFound`); running from source
  worked. The build now compiles `src/read-worker.ts` as a second entry point.

## [0.21.0] — 2026-10-15

### Added

- **List queries on the Monitoring page.** Every record list is recorded by its SQL shape
  (collection, filter, sort, deep page, search) with call count, mean, max and total time.
  The new panel lists shapes by total time with SQLite's query plan, flags the ones that
  read a whole table without an index or sort in memory, and for those on a table of 1,000+
  rows names the index that would serve them: the equality-filter fields first, then the
  sort field. One click creates it. `GET /api/v1/_/metrics/queries` returns the same
  report; `POST /api/v1/_/metrics/reset` clears it with the other metrics.
- **Composite indexes.** `POST /api/v1/admin/collections/<name>/indexes` takes
  `fields: [...]` (up to 4, in index order) alongside the existing `field`; the list
  endpoint returns `fields` for every index. The collection's Indexes tab in the admin UI
  builds multi-field indexes and offers `created_at` / `updated_at` as trailing fields.
- **Read worker threads (experimental, off by default).** `VAULTBASE_READ_WORKERS=<n>`
  serves record list and get-one requests on worker threads, each with its own database
  connection; everything else stays on the main thread. Not yet for production: a
  collection or settings change made while running reaches the workers only after a
  restart, a worker that dies is not replaced, and the flag is ignored under
  `vaultbase cluster`. It is not in the compiled binaries' documented surface until those
  land.

### Changed

- **Request authentication verifies tokens synchronously.** Bearer tokens are checked
  with an HMAC in-process and the parsed token is remembered per token string; expiry,
  issuer and audience are still checked on every request, and revocation and principal
  lookups still hit the database. jose remains the signer.
- **Per-request lookups are cached on the read path.** Settings reads (2 s, dropped at
  once by a write through the settings API), a collection's parsed field list, its table
  columns (per schema version), its private-field set and the per-field decoders no longer
  repeat their work for every request.

### Fixed

- **Parallel refreshes of one token all get the same replacement.** The refresh handler
  records the replacement before revoking the old token, and a refresh that loses the race
  returns the winner's token instead of a 401 that signed every tab out.

## [0.20.1] — 2026-10-15

### Changed

- **List totals are cached.** `totalItems` / `totalPages` come from a cache keyed on the
  count query and its parameters, emptied whenever the database changes: a write on the
  server's own connection, a commit from any other connection (cluster workers, the CLI) or
  a schema change. Lists inside an open transaction, lists of view collections and filters
  using `strftime` are always counted fresh. `skipTotal` still skips the count.
- **Deep pages read only the rows they return.** Past an offset of 3,000, a list first
  finds the page's rowids from the index and then reads just those rows, instead of reading
  every skipped row in full.
- **Rows with equal sort values keep a fixed order.** Every list of a base or auth
  collection now ends its sort with the rowid, in the direction of the last sort field, so
  rows that tie (records created in the same second, equal numbers) no longer repeat or go
  missing across pages. Sorts served by an index already returned this order.

## [0.20.0] — 2026-10-14

### Added

- **Monitoring page** in the admin UI (`/_/monitoring`, under Data). Polls the metrics
  endpoint every 1, 2 or 5 seconds and shows requests and writes per second, end-to-end
  latency, CPU, event-loop lag, memory, the per-step latency breakdown, status classes,
  methods, SQLite file and WAL sizes, the checkpointer and realtime connections. Numbers are
  per process; under cluster mode each poll shows whichever worker answered.
- `GET /api/v1/_/metrics` also returns `total`, `reads` and `writes` latency histograms,
  `status` (2xx/3xx/4xx/5xx) and `methods` counters, a `series` of the last 120 seconds,
  `process` (memory, CPU %, event-loop lag, realtime connections) and, under `sqlite`, the
  database and WAL file sizes and `checkpoint` stats.
- A `record_write` pipeline step, timed on record create, update and delete. Write requests
  also record `collection_load`, `rule_compile` and `db_exec` now. The Prometheus output
  gains the new step label; nothing existing is renamed.

### Changed

- **Record writes share commits.** Creates, updates and deletes that arrive in the same
  event-loop turn run in one SQLite transaction and commit together. A write still returns
  only after the COMMIT that holds it; if that COMMIT fails, every write in it fails. A
  statement that fails only undoes itself. Realtime events, webhooks and after-hooks run
  after the commit. Batches, cascading deletes and schema changes commit any open group
  first.
- **WAL checkpoints run on a background thread.** A worker with its own connection copies the
  WAL back into the database, so a request no longer pays for a checkpoint. SQLite's own
  autocheckpoint is switched off while the worker runs and back on if it stops.
- Record create, update and delete reuse cached SQL statements instead of compiling them on
  every request.
- The metrics endpoint no longer runs a WAL checkpoint each time it is polled.

### Fixed

- The enabled-hooks cache stored a lazy query instead of its result, so the hooks table was
  queried twice on every record write.

### Upgrade notes

- **A write in a shared commit can be read by another request up to one event-loop turn
  before it commits.** It only disappears if that COMMIT itself fails (disk full, I/O error),
  and then the write's own request fails too. Set `VAULTBASE_GROUP_COMMIT=0` to commit every
  write on its own, as before.
- **Shared commits are off under `vaultbase cluster`.** An open group holds SQLite's write
  lock for its turn, and other workers would wait on it; each worker commits writes on their
  own instead. For write-heavy workloads, run a single process.

## [0.19.1] — 2026-10-13

### Changed

- Admin routes share one auth check (the `requireAdmin` route option in
  `src/api/_admin.ts`) instead of a copy per file. A test now calls every admin
  route without a token, so a new route that forgets the check fails CI.
- CSV import and export, creating, updating and deleting collections, the view
  query previews and collection stats answer **401** instead of 403 without a valid
  admin token, like every other admin route.
- An API token sent with its `vbat_` prefix is accepted on every admin route; some
  only accepted it without the prefix.

## [0.19.0] — 2026-10-13

### Added

- **Extension points.** Field types, OAuth2 providers, storage drivers, email
  transports and push providers are now registries: the built-ins are registered
  through them, and code that embeds Vaultbase can add its own (`registerFieldType`,
  `registerOAuthProvider`, `registerStorageDriver`, `registerEmailTransport`,
  `registerPushProvider`, all exported from `src/extend.ts`). Select a registered
  storage driver or email transport with the `storage.driver` / `email.transport`
  setting.
- **Event bus.** Record writes and sign-ups emit `record.created`, `record.updated`,
  `record.deleted` and `auth.signup`; listen with `on()`. Realtime, outbound webhooks
  and after-hooks are now listeners on it, with unchanged behaviour.
- **Hooks, routes, cron jobs and workers from code** (`registerHook`, `registerRoute`,
  `registerJob`, `registerWorker`), alongside the ones defined in the admin UI. Admin UI
  hooks run first, and an admin UI route on the same method and path wins.
- `GET /api/v1/admin/extensions` lists everything registered.
- **Hooks as files.** Create a `vb_hooks/` folder next to the data directory (or set
  `VAULTBASE_HOOKS_DIR`) and each file in it defines one hook, route, cron job or queue
  worker:

  ```ts
  import { defineHook } from "vaultbase";
  import { slugify } from "./lib/text.ts";

  export default defineHook({
    collection: "posts",
    event: "beforeCreate",
    async run(ctx) { ctx.record.slug = slugify(ctx.record.title); },
  });
  ```

  Files can import each other and npm packages installed in the folder. They reload
  within a second of a change; a file that fails to load keeps its previous version
  running and shows the error in the admin UI. The admin UI and the MCP tools edit the
  same files: creating a hook writes a new file, settings changed in the form are
  written into the file, and a save is refused (409) if the file changed on disk since
  it was opened. `vaultbase.d.ts` in the folder types the `ctx` argument.

### Changed

- A new collection field must use a registered type; an unknown type (a typo, say) is
  refused instead of being stored as text. Existing fields are unaffected.
- **On the first start with a hooks folder, hooks, routes, jobs and workers written in
  the admin UI are moved into it as files** (under `hooks/`, `routes/`, `jobs/`,
  `workers/`), keeping their ids. One whose code doesn't load as a file stays in the
  database and the server logs why. Jobs created by `helpers.cron.add` stay in the
  database, and `cron.add` refuses to change a job defined in a file. To keep
  everything in the database, don't create the folder, or set `VAULTBASE_HOOKS_DIR=off`.
- `storage.driver` and `email.transport` must name a registered driver or transport.
  An unregistered storage driver is an error rather than a silent fall back to local
  disk.
- List requests are a little faster (about 4–9% in a local load test): the
  trusted-proxy setting and a collection's column list, read on every request, now
  reuse their compiled SQL statement instead of preparing it each time.

### Fixed

- **The README said cluster mode scales on macOS.** Only Linux spreads connections
  across workers; on macOS and Windows one worker takes them all, so cluster mode there
  only restarts crashed workers. The README, the deployment guide and code comments now
  say so.

## [0.18.0] — 2026-10-13

### Upgrade notes

- **Sign-up now follows the auth collection's create rule.** `/auth/:collection/register`,
  `/anonymous`, `/promote` and OAuth2 sign-up used to ignore it, so anyone could open an
  account in any auth collection and set any of its custom fields, whatever the rule
  said. On the first boot after upgrading, existing auth collections whose create rule is
  **Admin only** are switched to **Public**, so sign-up keeps working as before (the
  server logs which ones). Review them: set **Admin only** to close sign-up (invite-only),
  or a rule such as `@request.body.role:isset = false` to restrict what sign-ups may set.
  New auth collections still default to **Admin only**.
- **`@request.body.*` and `@request.query.*` match the key exactly.** They used to try
  the lowercased key first, so a body with both `isApproved` and a decoy `isapproved`
  showed the rule one value and stored the other. Headers are still matched
  case-insensitively.

### Security

- **Filters can't probe collections the caller can't list.** A `?filter=` that reaches
  another collection through `@collection.*` or `_via_` now joins it under its list rule
  as well as its view rule, so records readable by id only (invite codes, a users list
  restricted to self) can't be enumerated through the filter.
- **File field values must be stored file names.** A value like
  `../../admin/users/…/disable-mfa?` is refused with 422. The admin UI also encodes file
  URLs, so such a value can't redirect an admin's request to another endpoint.

## [0.17.1] — 2026-10-12

### Fixed

- **The installer looked frozen while downloading.** The binary (about 70 MB on macOS)
  downloaded silently, so a slow connection looked like a hang. The installer now shows
  the size and a progress bar in a terminal, and a download that stays under 100 KB/s
  for 30 seconds is retried on a new connection; if it is still slow, the last attempt
  runs without the speed check so it can finish.

## [0.17.0] — 2026-10-12

### Upgrade notes

- **Collection rules now default to admin-only.** A rule left out when creating a
  collection — over the API, from the admin's **New collection** dialog, or when
  restoring a migration snapshot — is stored as `""` (admin only). It used to be stored
  as `null`, which is public, so a new collection was readable and writable by anyone
  until someone set its rules. Existing collections keep the rules they have. To make a
  collection public, set `null` explicitly or pick **Public** on the **API rules** tab.
- **`~` against an empty value no longer matches.** `field ~ ""`, or `~` against a
  request value, auth field or column that is empty or missing, used to match every
  record; it now matches none, and `!~` matches all. A `!~` filter now also includes
  records whose field is NULL, as single-record rule checks already did.
- **An encryption key is generated when none is set.** Without `VAULTBASE_ENCRYPTION_KEY`
  the server now creates `<dataDir>/.encryption-key` (0600) on first start, uses it for
  secret settings and encrypted fields, and encrypts secret settings still stored in
  plaintext. **Back up this file with your database backups**: encrypted values can't be
  read without it. To switch to the env var later, set it to the file's contents. The
  server refuses to start if the key doesn't decrypt the stored secrets, or if the key
  file exists but can't be read, rather than replacing it.
- **Client filters may use one cross-collection reference.** A non-admin `?filter=` with
  more than one `@collection.*` / `_via_` operand — including one whose referenced
  collection's view rule itself uses them — now answers `400`. Admin requests and rules
  are not limited this way.
- **Custom routes are rate limited and return a generic `500`.** A custom route that
  throws now answers `{"error":"Internal error"}`; read the message in the logs. They
  count against the `/api/*` rate-limit rules like other API requests.
- **Secret settings read back as `********`.** The admin API and MCP settings tools no
  longer return secret values; a `PATCH` (or MCP `update_setting`) that sends `********`
  back leaves the stored value alone. `GET /admin/notifications/providers` ignores
  `?reveal=1`: the OneSignal key and FCM service account are write-only. Scripts that read a secret back from `GET /admin/settings` must keep their
  own copy. A metrics token can be copied only before it is saved.
- **New files are no longer world-readable.** The server sets a `027` umask at startup,
  so the database, uploads, logs and backups it creates are readable by its user and
  group only. If another user (not in the service's group) reads those files directly,
  add it to the group.
- **`read` API tokens are labelled as what they are.** A `read` or `mcp:read` token reads
  all data regardless of collection rules (a read-only admin); the admin token page,
  `vaultbase token mint` and the docs now say so. No behaviour change.
- **Cluster mode is documented as stateless REST scaling.** Caches, realtime and rate
  limits are per worker; worker 0 prints these limits at startup. Cron jobs, daily
  maintenance, the update check and the orphan-file sweep now run on worker 0 only
  (cron ran every job once per worker). Online restore answers `409` in cluster mode.
- **An uncaught exception now stops the process.** It used to be logged and ignored,
  leaving the server running in an unknown state. It is still logged, then the server
  shuts down gracefully with exit code 1 — run Vaultbase under a supervisor that
  restarts it (the installer's systemd unit does). Hook code that throws from a timer
  callback is one way to trigger this.
- **Rules can now see the request body.** `@request.body.<field>` was always empty, so
  `:isset` was always false and comparisons against the body always failed. Rules that
  use it now behave as written — check any that only worked because the body was empty.
- **Update rules are checked against the record as it would be after the change**, as
  well as the record as it is now. A rule like `owner = @request.auth.id` no longer lets
  the owner hand the record to someone else in the same request.
- **`expand` follows the related collection's `view_rule`.** Related records the caller
  can't view are left out of `expand` instead of being returned in full.
- **Auth cookies only work on same-origin requests.** `vaultbase_admin_token` and
  `vaultbase_user_token` are ignored on cross-site and same-site (sibling subdomain)
  requests. The admin UI and anything sending `Authorization: Bearer …` are unaffected.
  With the SDK, `authTransport: "cookie"` now only works when your app is served from the
  same origin as Vaultbase; the default, `"both"`, also sends the header and keeps working.
- **Uploaded files are served more strictly.** Only safe raster images are shown inline;
  everything else, SVG included, downloads as `application/octet-stream`. Every file
  response carries `Content-Security-Policy: sandbox`, and stored file extensions now
  come from the validated MIME type rather than the uploaded file name.
- **First-admin setup always needs a setup key.** While no admin exists,
  `POST /api/v1/admin/setup` requires the key as an `X-Setup-Key` header or a `setup_key`
  body field. It is `VAULTBASE_SETUP_KEY` when set (`install.sh` writes one into
  `/etc/vaultbase/vaultbase.env`); otherwise the server generates one, keeps it in
  `<dataDir>/.setup-key` and prints it at startup with a `/_/setup#key=…` link. The browser
  setup page has a **Setup key** field, filled in from that link. `vaultbase setup-admin`
  doesn't need the key, and now reads `/etc/vaultbase/vaultbase.env` (or
  `VAULTBASE_ENV_FILE`) so it works on the service's database.
- **`VAULTBASE_HOST` is honoured.** The server used to listen on every interface
  whatever it said; set `VAULTBASE_HOST=127.0.0.1` behind a local reverse proxy. Unset,
  it still listens on every interface, IPv4 and IPv6.
- **Sign-in lockout is on by default and covers users too.** After 10 failed sign-ins in
  15 minutes, the account (and, behind a configured trusted proxy, the client IP) gets
  `429 Too many failed attempts` until the window passes. This applies to admin sign-in,
  which previously shipped with the lockout off, and now also to
  `POST /auth/:collection/login`, which had none. Tune or disable it at **Settings →
  Security → Brute-force lockout** (`auth.lockout.max_attempts`, `0` turns it off). An
  install that had explicitly saved `0` keeps it off.
- **Refreshing a token revokes the old one, and sessions have a maximum age.**
  `POST /auth/refresh` now revokes the token it was called with, so keep the new token
  and drop the old one (the SDK already does). Refreshing the same token again within
  30 seconds — another tab, a retried request — returns the same new token rather than
  an error. Signing out with the old token in that window ends the new one too. A sign-in can be kept alive by refreshing
  for at most 30 days from the original sign-in; after that `/refresh` answers `401` and
  the user or admin signs in again. Set `auth.session.max_seconds` (**Settings → Auth →
  Session lifetimes → Maximum session age**) to change it, `0` for no cap. Anonymous
  sessions are exempt.
- **`/totp/setup` and `/totp/confirm` refuse while MFA is on.** To move a user to a new authenticator,
  call `/totp/disable` with a current code, then `/totp/setup` and `/totp/confirm` again.
- **`request-email-change` no longer reports a taken address.** It answers
  `{ "sent": true }` and sends nothing; the old `422 Email already in use` is gone.
- **Admins can only edit their own email and password.** `PATCH /admin/admins/:id` on
  another admin answers `403`, and the **Superusers** page only offers Edit on your own
  row. Reset another admin's password from the server with
  `vaultbase setup-admin --email … --password … --force`.
- **The admin SQL runner runs one statement per query.** A script with several
  statements separated by `;` now answers an error; run them one at a time.
- **Protected files always need a download token.** Apps that showed protected files
  by relying on the record's view rule must now mint a token
  (`POST /files/:collection/:recordId/:field/:filename/token`) and append `?token=`.
- **`GET /collections` and `/collections/:id` need an admin token.** Non-admin callers
  get `401`. For a schema your app can read, enable the public OpenAPI document
  (`api.openapi_public`), which leaves out admin-only collections.
- **A delete is refused if its cascade would touch records you can't modify.** Deleting
  a record whose relations cascade (`cascade` or `setNull`) now checks each affected
  record against its own collection's delete (or update) rule and answers `403` if any
  fails, instead of removing or changing them. Admins are unaffected.
- **Files whose field was removed are admin-only.** A stored file whose field was dropped
  or renamed is no longer served by the record's rules.
- **View queries can't name auth secrets.** A view whose query mentions `password_hash`,
  `totp_secret` or `password_reset_at` is rejected when saved; edit it to drop those
  columns. `SELECT *` views keep working, without those columns.
- **Uploads need an existing record.** `POST /files/:collection/:recordId/:field` answers
  `404` for a record id that doesn't exist; create the record first, then upload.
- **Realtime changes.** A WebSocket or SSE connection from this server's own origin is
  accepted even with `security.allowed_origins` empty (it used to be refused). Clients
  should handle `{ "type": "auth_expired" }` by sending a fresh token. Connections are
  capped at 10,000 per process, 100 per client address and 100 topics (of at most 200
  characters) each; WebSocket messages over 64 KB are refused. The per-address cap needs
  the real client address: behind a reverse proxy, set `security.trusted_proxies` (until
  then, connections from a loopback peer — a proxy on the same host — are not capped per
  address; a proxy elsewhere must be listed). Subscriptions to a whole
  collection only deliver records that pass its `list_rule`. Managing an SSE client that
  has authenticated needs that user's token.
- **OAuth flows need the server-issued `state`.** `/oauth2/authorize` records the
  `state` (generating one if you send none, returned as `data.state`); `/oauth2/exchange`
  now requires it back, for the same provider and redirect URI, once. With no
  `oauth2.allowed_redirect_uris` configured, only redirect URIs on `app.url`'s origin are
  accepted — set the list if your callback lives elsewhere. Accounts with TOTP get
  `{ mfa_required, mfa_token }` from `/exchange` and password-based `/merge-confirm`.
  `/oauth2/authorize` also returns a `state_secret`; keep it in the page that started
  the flow and send it to `/exchange` — without it the exchange answers `400`. Facebook,
  Microsoft, Twitch, Spotify and Notion emails no longer merge into existing accounts or
  count as verified; an account created from an unverified (or already taken) provider
  email gets a placeholder `…@oauth.invalid` address. Resetting a password removes the
  account's provider links.
- **Hook egress is stricter.** `helpers.fetch` is now filtered like `helpers.http`;
  redirects are followed by hand (at most 5) with each hop checked; a host that doesn't
  resolve is blocked; and cloud metadata addresses can't be allowed. A hook that reached
  an internal service through one of these gaps needs a `hooks.http.allow` entry.
- **Relations must point at records the writer can view.** A non-admin can no longer set
  a relation to a record they can't read — including linking to another user when the
  `users` collection isn't readable to them. Open the target's view rule (for example
  to signed-in users) where such links are intended.
- **Reverse proxies: set `X-Forwarded-For`, don't append.** Update nginx to
  `proxy_set_header X-Forwarded-For $remote_addr;` (and fix the SSE `location` to
  `/api/v1/realtime`), as in `deploy/nginx/vaultbase.conf`. With a chain of proxies, list
  all of them in `VAULTBASE_TRUSTED_PROXIES`.
- **`/metrics` needs a token.** With `metrics.enabled` on and no `metrics.token`, the
  endpoint used to be public; it now answers `401` unless an admin token is sent. Set
  `metrics.token` for your scraper.
- **List pages are capped at 100,000 skipped records.** `page × perPage` beyond that
  answers `400`; narrow deep reads with a filter (for example on `created`) instead of
  paging.
- **Flag evaluation sets `auth` itself.** An `auth` key in the context sent to
  `POST /flags/evaluate` is replaced with the caller's verified session (or removed).
  Target trusted attributes as `auth.id`, `auth.email`, `auth.collection`.
- **MCP `run_sql` writes need the `mcp:admin` scope.** A token with only `mcp:sql` can
  still read; `allow_write: true` now answers with an error unless the token also has
  `mcp:admin` (or `admin`).
- **Regenerating recovery codes needs a current TOTP code.** Send
  `{ "code": "123456" }` to `/totp/recovery/regenerate`; without it the call answers
  `401`. `/totp/confirm` now returns the first set of recovery codes as
  `recovery_codes`, so enrolling doesn't need a separate regenerate call.
- **Re-running the installer now restarts the service.** Previously the binary was replaced
  but the running process kept serving the old one until someone restarted it by hand.

### Added
- **`color` field type.** Stores a hex color as lowercase `#rrggbb`; `#rgb` and any case
  are accepted and normalised, so equality filters and unique checks match regardless of
  how the value was typed. The `alpha` option also accepts `#rgba` / `#rrggbbaa`. The admin
  shows a color picker in the record form and a swatch in the records table.
- **The installer detects the platform.** `curl -fsSL https://get.vaultbase.dev | sh` now works on macOS (Intel and Apple silicon, including from a Rosetta shell) as well as Linux. On macOS it installs the binary only. New `--install-dir` flag.
- **Windows installer.** `irm https://get.vaultbase.dev/install.ps1 | iex` downloads the Windows binary, checks it against `SHA256SUMS`, installs it to `%LOCALAPPDATA%\Programs\Vaultbase` and adds it to the user `PATH`.
- **Queue stats are windowed.** `GET /admin/queues/stats` accepts `?window=<seconds>` (default 24h, clamped to 30d) and each queue now also reports `succeeded_window`, `failed_window`, `dead_window` and `oldest_queued_at`. The all-time `queued` / `running` / `succeeded` / `failed` / `dead` counters are unchanged, so existing callers are unaffected.
- **Collection stats are windowed.** `GET /admin/collections/stats` accepts the same `?window=` parameter, driving `recentWrites`. It previously hardcoded 24 hours.
- **Redesigned admin.** New first-run setup wizard, sign-in screen and dashboard, and a
  token layer that applies the design system across the rest of the admin. The dashboard
  is rebuilt around four live tables — dead jobs, per-queue backlog, top collections and
  recent requests — with a 1h / 24h / 7d range picker backed by the windowed endpoints above.
- The installer grants `CAP_NET_BIND_SERVICE` when `--port` is below 1024, instead of writing a unit that cannot bind.

### Security
- **New collections were public by default.** See the upgrade note above. The admin's
  rule editor also had a bug that saved an "Admin only" rule as public when the
  collection was edited; both are fixed.
- **Filters could read hidden columns.** `filter` and `sort` accepted `password_hash`,
  `totp_secret` and other private auth columns, which let a caller recover them one
  character at a time. They — and any column that isn't a declared field — are now
  rejected as unknown, including through `@collection.*` and `_via_` references.
- **An uploaded file could run as a page on the API's own origin.** A file stored with
  an `.html` name was served as `text/html` even when uploaded as an image, which with
  the admin cookie amounted to admin takeover. See the upgrade note on file serving.
- **The auth cookies could be used from another site.** See the upgrade note above.
- **Rules didn't see the request body, and update rules only checked the old record.**
  Together these let a user write fields a rule was meant to block, or move a record they
  owned to another user. The built-in `notifications` collection's update rule now also
  pins the `user` field.
- **`expand` ignored the related collection's view rule**, returning related records the
  caller wasn't allowed to see.
- **Dropping an index wasn't tied to its collection.** `DELETE
  /admin/collections/:name/indexes/:indexName` only checked the `idx_`/`uniq_` prefix, so
  it could drop any matching index in the database, including the one keeping admin
  emails unique, and the name went into SQL unescaped. It now returns 404 unless the
  index belongs to that collection.
- **View queries could read SQLite metadata.** `pragma_*()` functions and `sqlite_*`
  tables passed the view-query check and could expose the schema and database file path
  through a public view. They are now rejected.
- **OTP sign-in codes could be guessed without limit.** A wrong code was never counted
  against the attempt limit, and requesting a new code left the older ones valid. Each code
  now allows 5 attempts, a new code voids the previous one, used and expired codes are
  never matched, and an address allows 10 failed codes per 15 minutes in total; past that,
  `POST /auth/:collection/otp/auth` answers `429` until the window passes. Both limits
  are charged before the code is compared, so parallel guesses can't race past them.
- **The MFA code limit could be reset by signing in again.** The 5-attempt limit on the
  second step of MFA sign-in was kept per sign-in ticket, so anyone holding the password
  could fetch a new ticket and keep guessing; parallel guesses could also slip past the
  count. Failed TOTP and recovery codes now count per account (10 per 15 minutes, then
  `429`), including on `POST /auth/:collection/totp/disable`, and the counter is updated
  atomically, before the code is checked, so guesses sent in parallel can't get past
  either limit. A TOTP code is accepted once: replaying a code that has just been used is
  refused (and isn't counted as a failed guess). A recovery code or MFA ticket can no
  longer be used twice by sending two requests at the same time.
- **Passwords could be guessed without an account lockout.** User sign-in had no
  per-account limit, only the per-IP rate limit, and the admin lockout was off by default.
  See the upgrade note above. The lockout is also charged before the password is checked,
  so parallel attempts can't slip past it, and it now also guards the password checks in
  `confirm-email-change` and `oauth2/merge-confirm`. The per-IP limit is five times the
  per-account one and is kept separately for admin and user sign-in, so people sharing an
  address can't lock the admin out. `vaultbase setup-admin --force` clears an admin's
  lockout when resetting the password.
- **A victim's inbox could be flooded with reset and sign-in emails.** Password-reset,
  OTP and verification emails were limited only per client IP. Each user now gets at most
  one email of each kind per minute; extra requests to the public endpoints still answer
  `200` but send nothing, and `request-verify` answers `429`. A held-back OTP request
  doesn't void the code that was already sent. `request-email-change`, which mails an
  address the caller chooses, has the same one-a-minute limit (`429`).
- **A stolen token could be kept alive forever.** `/auth/refresh` left the old token
  valid until its own expiry and re-stamped the expiry on every call, with no limit on
  the session's total age. Admin refreshes also didn't appear in **Settings → Security →
  Sessions**, so they couldn't be revoked from there. See the upgrade note above.
- **Promoting a guest account could set protected columns.** `POST
  /auth/:collection/promote` copied every extra body field into the user row, so a guest
  could mark their new email verified, set MFA columns, or change the record's `id`. Only
  the collection's own declared fields are accepted now (the same rule is enforced when
  creating users). Promoting also ends the guest session: the anonymous token stops
  working and the caller keeps the new token from the response.
- **A stolen session could replace an account's TOTP secret.** `POST
  /auth/:collection/totp/setup` overwrote the secret even with MFA already on, with no
  code required, after which the attacker's authenticator passed every MFA check. Setup
  now answers `409` while MFA is enabled; disable it with a current code first.
- **A stolen session could mint new MFA recovery codes.** `POST
  /auth/:collection/totp/recovery/regenerate` needed only a session; it now needs a
  current authenticator code, under the same attempt limit as sign-in.
- **The account lockout could be reset from a look-alike account.** Address lookups are
  case-sensitive, but the lockout was keyed by the lower-cased address, so signing in to
  `VICTIM@example.com` cleared the failures recorded against `victim@example.com`. The
  lockout is now keyed by the account itself.
- **Registration and email change could reveal which addresses have accounts.** Register
  skipped password hashing (and validation) when the address was taken, so the response
  came back measurably faster; both branches now do the same work and validate first.
  `request-email-change` answered "Email already in use" for a taken address; it now
  answers like any other request and sends nothing. Reset, OTP and email-change requests
  no longer wait for the mail server before answering, which made addresses with an
  account measurably slower, and `promote` checks the password before the address.
- **One-time tokens were stored in plaintext.** Password-reset, verification, OTP and
  invitation links, MFA tickets and OAuth merge tokens were kept verbatim in the
  database, so anyone with a copy of it (a backup, read-only SQL access) could use a
  pending reset link. They are now stored as SHA-256 hashes, and an OTP's 6-digit code as
  an HMAC keyed with the server secret. Links issued before the upgrade are re-keyed on
  first start and keep working; OTP codes issued before it stop working (they last ten
  minutes — request a new one).
- **Any admin could take over another admin's account.** `PATCH /admin/admins/:id`
  changed any admin's email and password; it now only changes the caller's own (`403`
  otherwise). A locked-out admin is recovered with `vaultbase setup-admin --force`.
- **The admin SQL time limit never worked.** A query ran on the server's own thread, so
  the 5-second limit couldn't interrupt it and one slow query stalled every other
  request. Queries now run in a separate process (read-only mode) or worker (sandbox) and
  are stopped when the limit is reached. The sandbox also refuses `ATTACH`, `DETACH` and
  `VACUUM`, which could reach the live database or write files outside it, and the
  SQL runner now runs one statement at a time.
- **Protected file fields didn't require a token.** A request without one fell through
  to the record's rules and was served whenever they allowed it, so on a viewable record
  `protected` — and one-time or IP-bound download tokens — could be skipped. Protected
  files now need a valid download token for everyone but admins.
- **Collection definitions were public.** `GET /collections` and `/collections/:id`
  answered anyone with every collection's rules, fields and view SQL. They are now
  admin-only, as the API docs already said.
- **Record history showed old versions to a record's new owner.** History was readable
  by anyone who passed the view rule against the record as it is now, so after a record
  changed hands the new owner could read every earlier version. Non-admins now see only
  versions that pass the view rule as they stood, and only their own user id as the
  author of a change.
- **`If-Match` didn't stop concurrent writes.** The ETag was compared before the write,
  so several requests carrying the same ETag could all pass and all write. The check now
  holds until the write lands: only one succeeds, the rest get `412`.
- **Deleting a record could delete other people's records through a relation.**
  Cascades (`cascade` and `setNull`) ignored the related collection's rules, so a user
  allowed to delete their own record removed or changed every record pointing at it,
  whoever owned them. Each affected record must now pass its own collection's delete (or
  update) rule, or the whole delete is refused with `403`. Admins are unaffected. A
  delete blocked by a `restrict` reference — directly or inside `/batch` — no longer
  names the referencing collections to non-admins.
- **List rules that read the request matched too much.** A `list_rule` using
  `@request.headers.*` or `@request.query.*` was compiled without the request, so those
  values were empty in the SQL filter — `field ~ @request.headers.x` then matched every
  record. And for `~`, a `%` or `_` sent by the caller acted as a wildcard. List rules
  now see the request, and values from the request are matched as plain text with `~`
  (patterns written into a rule or filter keep their wildcards).
- **Rules with `@collection.*` or `_via_` could pass on a negated comparison.** Checks
  on a single record — view, update and delete by id, file access, realtime delivery —
  can't look into other collections, and those operands resolved to NULL there, so
  `@collection.bans.user != @request.auth.id` let a banned user read, change or delete
  the record by id while list requests refused them. A comparison with such an operand
  is now false in those checks, so it can only narrow access.
- **Secret settings were stored and backed up in plaintext by default.** Encryption at
  rest needed `VAULTBASE_ENCRYPTION_KEY`, which few installs set, so the SMTP password,
  OAuth client secrets and storage keys sat in `data.db` and every backup in clear. A key
  is now generated when none is set, and existing plaintext secrets are encrypted.
- **The settings API returned every secret in plaintext.** `GET /admin/settings` (and the
  MCP `list_settings`/`get_setting` tools) decrypted the SMTP password, OAuth client
  secrets, storage keys and tokens, so anything that could read one admin response had
  them all. Secret-valued settings now read back as `********`.
- **A fresh install could be claimed by whoever reached it first.** `POST /admin/setup`
  was open unless `VAULTBASE_SETUP_KEY` was set, so an install from the container image,
  a manual binary or source had its first-admin endpoint open to the network. The server
  now generates a setup key when none is configured and requires it (compared in
  constant time). `VAULTBASE_HOST` was documented but ignored, so the server always
  listened on all interfaces; it is now used.
- **Custom routes skipped rate limits, security headers and CORS.** Routes under
  `/api/v1/custom/` answer before the rest of the pipeline, so none of the three applied,
  and an uncaught error returned its message (SQL, file paths) to the caller. They now
  get all three and a generic `500`. Routes can also require sign-in (`require_auth`,
  **Require sign-in** in the editor; guest sessions don't count); existing routes stay
  public.
- **Restoring a backup revived revoked sessions and kept stale caches.** A restore rolled
  back `token_revocations`, so sessions signed out and API tokens revoked since the
  backup worked again; it kept serving collections, hooks and routes from the replaced
  database's in-memory caches until restart; and it ran without the write gate.
  Revocations (and each admin's and user's "signed out everywhere" / password-reset
  time) are now carried over, caches are dropped, and the swap holds the write gate. In cluster mode, where it swapped the database under one worker only, online
  restore answers `409`.
- **Admin actions from the admin UI were audited without an actor.** The audit log read
  the admin only from the `Authorization` header, so actions by an admin signed in with
  the session cookie were recorded with no actor. It now reads the same token sources
  as the admin routes. New `audit.retention_days` setting (default `0`, keep forever)
  bounds how long entries are kept.
- **Data files were world-readable outside the installer.** No umask was set, so with the
  usual `022` the database, uploads, logs and backups were readable by every local user
  unless the installer had locked down the data directory. The server now uses `027`.
- **`vaultbase update` installed unsigned releases silently.** With cosign installed,
  the signature was only checked when the release carried `.sig`/`.pem` assets, so a
  release without them was installed on the SHA-256 alone, with no warning. It is now
  refused unless `--no-verify` is passed.
- **A trusted proxy reaching the server over IPv4-mapped IPv6 wasn't trusted.** On an
  IPv6 listener an IPv4 proxy appears as `::ffff:127.0.0.1`, which never matched
  `127.0.0.1` or `127.0.0.0/8` in `VAULTBASE_TRUSTED_PROXIES`, so the forwarded client
  address and `X-Forwarded-Proto` were ignored and every client shared the proxy's rate
  limit. Peer addresses are now read in their IPv4 form.
- **Rules couldn't tell guests, unverified users or other auth collections apart.** The
  usual "signed in" rule, `@request.auth.id != ""`, also admits anonymous guest sessions
  and users of every auth collection, and there was no way to require a verified email.
  Rules can now use `@request.auth.collectionName`, `@request.auth.verified` (read from
  the account on each request) and `@request.auth.anonymous`. Review rules that rely on
  `@request.auth.id != ""` if you enable anonymous sign-in or have more than one auth
  collection.
- **`@collection.*` rules looked at one arbitrary row.** `@collection.members.user =
  @request.auth.id` compiled to "the `user` of the first `members` row equals the
  caller", so only that member passed, and a ban list (`@collection.bans.user !=
  @request.auth.id`) only banned its first entry. A rule now passes when some row of the
  collection (that the caller may view) makes it true, with every reference to the same
  collection and alias bound to that one row; `!=` and `!~` against such a reference
  mean no row matches (and are false for non-admins unless the collection is public).
  An expression may join at most 3 collections/aliases, and a non-admin `?filter=` may
  use only one `@collection.*` or `_via_` operand — counting any in the view rule of the
  collection it references — so a client filter can no longer build a cross join that
  stalls the server.
- **The same address could be registered twice in different case.** Promoting an
  anonymous account, changing email and magic-link sign-up checked for an existing
  address case-sensitively, so `ALICE@example.com` could be added beside
  `alice@example.com` (register already checked in any case). All four now do.
- **`~` with an empty right side matched every record.** When the right-hand value of
  `~` was empty or missing — `tag ~ @request.headers.x` with no header, an
  `@request.auth.*` field of an anonymous caller, an empty column, or a `_via_`
  back-relation — the SQL filter compared against `%%` and matched everything. An empty
  or missing value now matches nothing with `~` (and everything with `!~`), in list
  filters and in single-record rule checks alike. Single-record checks also ignore ASCII
  case now, as list queries always did, so `title !~ "confidential"` can't hide
  "CONFIDENTIAL plan" from lists yet serve it by id or over realtime.
- **A list request could make the database scan the whole table.** `page` had no upper
  bound, and SQLite walks every skipped row to reach an offset. A list may now skip at
  most 100,000 records; deeper pages answer `400`.
- **Anyone could evaluate feature flags as any user.** `POST /flags/evaluate` takes the
  targeting context from the caller, so a caller could claim another user's id and read
  their treatment. The server now sets the context's `auth` attribute from the caller's
  session (and removes it for anonymous callers), so rules targeting `auth.*` can be
  trusted, and `flags.public_evaluate = 0` limits evaluation to signed-in callers.
- **Views over auth tables exposed password hashes.** A view collection such as
  `SELECT * FROM vb_users` returned `password_hash`, `totp_secret` and
  `password_reset_at`, and let callers filter on them. They are now stripped from view
  rows and refused in view filters, and a view query that names them (or renames them)
  is rejected. The view-query check also read a `'--'` inside a string as a comment and
  skipped the rest of the line, which could hide a reference to SQLite's metadata
  tables; it now parses strings, identifiers and comments properly.
- **CSV exports could carry spreadsheet formulas.** A text value starting with `=`, `+`,
  `-`, `@`, tab or carriage return ran as a formula in whoever opened the export. Such
  values are now prefixed with `'` (shown as plain text); CSV import removes the prefix
  again, so an export re-imports unchanged.
- **Files could be uploaded for records that don't exist.** The upload endpoint accepted
  any record id and judged it by the create rule, so storage could be filled with files
  attached to nothing. Uploads now need an existing record and pass its update rule.
- **Relation fields could point at records the caller can't see.** A relation was only
  checked for existence, so a user could link to another user's private record, and the
  "does not exist" error told them which ids exist in a collection they can't read. A
  relation set by a non-admin must now point at a record that caller can view; missing
  and hidden records get the same error. (A `unique` field still reports a duplicate:
  that is what a unique constraint has to say.)
- **Realtime connections outlived their credentials and had no limits.** A connection's
  token was checked once, so a signed-out or expired session kept receiving protected
  events; connections, topics and an unread SSE stream's buffer could grow without
  limit; and `POST`/`DELETE /realtime` trusted the SSE `clientId` alone. Tokens are now
  re-checked every minute and at expiry, connections and topics are capped, slow SSE
  readers are dropped, and managing an authenticated SSE client needs its user's token.
  Collection-wide subscriptions also ignored the collection's `list_rule`, so a record
  hidden from lists was still pushed to every subscriber who could view it; they now
  follow the list rule as well (a subscription to one record by id needs only the view
  rule).
- **OAuth sign-in skipped MFA and didn't check its own state.** Signing in through a
  linked provider, or confirming a merge with the password, issued a session even when
  the account had TOTP on. `/oauth2/exchange` accepted any `state` (it was only checked
  for server-side PKCE), so a forged callback could sign a victim's browser into the
  attacker's account; OIDC/Apple flows sent no `nonce`; with no redirect allow-list any
  redirect URI was accepted, and a `https://app.com*` entry also matched
  `https://app.com.evil.tld`. Five providers' unverified emails were trusted for account
  merging. A password reset left provider links in place. All fixed — see the upgrade
  note.
- **The hook egress filter could be bypassed.** IPv6 addresses carrying an IPv4 one
  (`[::ffff:169.254.169.254]`, NAT64, 6to4) weren't matched against the IPv4 ranges,
  only the first DNS answer was checked, a name that failed to resolve was let through,
  `helpers.http` followed redirects without checking where they went, and
  `helpers.fetch` wasn't filtered at all. All of these are now checked, for webhook
  deliveries too, and cloud metadata endpoints stay blocked even when the allow list
  covers them or the filter is turned off.
- **The client IP could be spoofed with `X-Forwarded-For`.** The first (client-written)
  entry was taken as the client address, and the lockout, audit log, request logs and
  custom-route logs read the header without checking who sent it. The header now counts
  only from a trusted proxy and is read from the right, everywhere; the shipped nginx and
  Caddy configs set it instead of appending to it. The Settings → Security trusted-proxy
  list now applies to rate limiting too (it used to read only the env var). The nginx
  and Caddy SSE locations also pointed at the old `/api/realtime` path; they now match
  `/api/v1/realtime`.
- **Admin and auth responses could be cached.** Nothing under `/api/v1/admin` or
  `/api/v1/auth` sent a `Cache-Control` header, so responses carrying settings secrets,
  tokens and session lists could be kept by the browser or a shared proxy (a cached
  `401` from `/admin/auth/me` even caused a sign-in loop). They are now `no-store`.
  Record reads keep their ETag revalidation.
- **The admin cookie lacked `Secure` behind a TLS proxy.** The flag was taken from the
  request URL, which is plain http behind a TLS-terminating proxy. It is now set when a
  trusted proxy reports `X-Forwarded-Proto: https` or `app.url` is https.
- **The rate limiter was easy to sidestep.** Any `Authorization` header selected the
  limits meant for signed-in clients, an IPv6 client got a fresh budget for every address
  in its /64, and the bucket table could grow without bound. Only a valid token now
  counts as signed in, IPv6 clients are limited per /64, and the table is capped.
- **`/metrics` was public when enabled without a token**, and the HTML sanitizer let
  `javascript:` links through behind a leading control character. `/metrics` now needs
  `metrics.token` or an admin token; the sanitizer drops leading control characters
  before checking the scheme, as browsers do.
- **Thumbnails had no decode budget.** A small upload could declare a huge canvas (or an
  animated GIF thousands of frames) and be decoded on the request path, and concurrent
  requests for different sizes could get past the 32-variants-per-file cap. Images over
  50 megapixels are now served without a thumbnail; animations over 25 megapixels in total
  (frames × width × height, frames counted from the file's structure) get a still first
  frame; at most two animations are decoded at once; and the variant cap is taken
  atomically.
- **An `mcp:sql` token could rewrite the database.** The MCP `run_sql` tool's
  `allow_write` flag was the caller's own choice, reads ran on the server's own
  connection (where a `PRAGMA` could change its behaviour for every later request), and
  nothing was audited. Writes now also need the `mcp:admin` scope, reads use a separate
  read-only connection with the 5-second limit, and every call goes to the audit log.

### Fixed
- **Trust boundaries and password policy documented.** The security docs now say which
  settings and credentials are trusted (admin-configured integration URLs, `read`
  tokens, hook code) and how to tighten the password policy (`password.hibp_check`,
  `password.min_length`).
- **Docs and help drift.** `vaultbase --help` and the install docs named
  `VAULTBASE_CLUSTER_WORKERS`; the variable `vaultbase cluster` reads is
  `VAULTBASE_WORKERS`. `docker-compose.web.yml` pointed at directories that don't exist
  in this repo. `SECURITY.md` said `helpers.query` applies collection rules (it doesn't)
  and that `helpers.fetch` skips the egress guard (it no longer does); it now spells out
  that hook, route, job and worker code is trusted with the server's full privileges.
- **Queue jobs interrupted by a restart or crash ran again.** A job left in `running`
  when its process stopped stayed there for good. At startup those jobs go back on the
  queue (the interrupted run counts as an attempt; a job with no attempts left is marked
  dead). In cluster mode, where a sibling may still be running them, only jobs running
  for over an hour are taken back. Shutdown waits up to 10 s for running jobs to finish.
- **Vector search returned `400` for `nearLimit` above 25.** The top matches were
  loaded with one `id = … || …` filter, longer than the filter parser accepts. They are
  now loaded in chunks, so `nearLimit` works up to its documented 1000.
- **Read-only batches no longer block writes.** A `/batch` of only `GET`s took the
  exclusive write gate, so a batch of 100 slow lists stalled every write in the process.
  Read-only batches now run without it; each read sees committed data, with no snapshot
  across the batch.
- **Shutdown waits for requests in flight.** `SIGTERM`/`SIGINT` used to exit as soon as
  logs were flushed, dropping any request being handled. The server now stops taking
  connections, gives in-flight requests up to 10 s, stops background work and closes the
  database before exiting. A second signal exits at once.
- **Migrations no longer hide failures.** Adding a column ignored every error as "the
  column already exists", so a locked or read-only database, or a full disk, left the
  schema half-migrated with nothing logged. Only that one error is ignored now; anything
  else stops startup with the error. `busy_timeout` is also set before switching to WAL,
  so processes opening the database together (cluster workers, a CLI next to the
  server) wait for the lock instead of failing with `SQLITE_BUSY`.
- **The hosted magic-link page now works for accounts with two-factor sign-in.** It used
  the link and then showed "Invalid or expired link", because it didn't know what to do
  with the MFA step. It now asks for the authenticator (or recovery) code and finishes the
  sign-in.
- On Alpine, the installer now installs `libstdc++` and `libgcc`. Without them the musl binary failed to start. On Alpine arm64, where there is no musl build, it stops with a clear message instead of installing a binary that can't run.
- **The installer works on stock Alpine.** It no longer requires `useradd` (from the `shadow` package, absent on Alpine) and falls back to busybox `adduser` / `addgroup`. It also installs `xz` when missing, so musl hosts download the ~30 MB compressed asset instead of the ~100 MB raw binary.
- **`--version`, `--port` or `--install-dir` as the final argument** no longer aborts with `shift: can't shift that many` and exit 2. This hit dash — `/bin/sh` on Debian and Ubuntu, i.e. the documented `curl … | sudo sh` path.
- **A service that fails to start no longer swallows the installer's output.** The summary, the `journalctl` hint and the generated setup key are printed either way; the installer exits non-zero so a wrapper still notices.
- **The installer re-asserts `/etc/vaultbase/vaultbase.env` ownership and mode on every run.** An env file left at `0644` kept the JWT signing key and setup key readable by every local user; re-running is the documented repair path and now actually repairs it.
- **A pre-existing `vaultbase` user with a different primary group** no longer aborts the install with `install: invalid group 'vaultbase'`. The group is created independently of the user, and failures name the fix.
- The installer validates `--port` (1–65535) and requires `--install-dir` to be absolute, rejecting paths under `/home` or `/root` that `ProtectHome=yes` would hide from the service.
- On an upgrade the installer no longer claims `--port` was ignored when it was never passed, and no longer tells you to bootstrap an admin that already exists.
- **The hook editor advertises the real helper surface.** All four scaffolds (record hook, custom route, cron job, queue worker) listed between six and nine helpers and no namespaces; `notify`, `enqueue`, `recordRule`, `uuid`/`id` and all twelve namespaces (`db`, `http`, `security`, `fs`, `flags`, `webhooks`, `mails`, `cron`, `template`, `path`, `util`, `os`) were invisible from the editor.
- Documented `helpers.uuid()` / `helpers.id()`, `helpers.flags.*` and `helpers.webhooks.dispatch()`, which the hooks reference omitted.

## [0.16.0] — 2026-10-11

### Upgrade notes

- **Orphaned files are now deleted.** An hourly sweep removes stored files (and their thumbnails) whose record or collection is gone, whose field was dropped, or that the record's field no longer names, once they are 24 hours old. Collections with record history are skipped. Set `files.orphan_cleanup` to `0` to keep the old behaviour.
- **Request-log files follow data retention.** Daily `logs/*.jsonl` files older than `maintenance.retention_days` (default 30) are deleted. Set it to `0` to keep everything.
- **Changing an admin's password signs that admin out everywhere**, including the session that made the change.

### Added
- **Email change.** `POST /auth/:collection/request-email-change` emails a link to the new address; `confirm-email-change` applies it with the current password, marks it verified and ends existing sessions. SDK: `vb.auth.<collection>.requestEmailChange()` / `.confirmEmailChange()`.
- **Invitations.** `POST /admin/users/:collection/invite` creates a user without a usable password and emails a 7-day link; `accept-invite` sets the password and verifies the email. Admin: **Records → Invite user** on auth collections. SDK: `vb.auth.admin.invite()`, `vb.auth.<collection>.acceptInvite()`.
- Hosted pages for both flows at `/auth/confirm-email-change` and `/auth/invite`.

### Security
- Confirming a password reset didn't end existing sessions, so a stolen token kept working after the owner reset their password. It now does, as does an admin password change.
- The hosted auth pages put the `token` / `collection` query values into an inline script unescaped. The site CSP blocked the injection, but see below.

### Fixed
- The hosted `/auth/reset`, `/auth/verify` and `/auth/otp` pages never worked in a browser: the site-wide CSP (`script-src 'self'`) blocked their inline scripts, leaving a form or spinner that did nothing. Each page now sends its own CSP with a per-response nonce.
- SMTP had no timeouts, so a hung mail server could hold a request open for minutes. Connect and greeting now time out after 15 s.
- Very long request paths and hook log messages are truncated in the log (2 KB / 8 KB).

## [0.15.0] — 2026-10-11

### Upgrade notes

- **Thumbnail variants are capped at 32 per file** for non-admin requests. If your app requests more distinct sizes, formats or qualities than that for one image, the extra ones get the original file (`X-Vaultbase-Thumb: limit`). Thumbnails already cached keep working. List the sizes you use in the field's **Thumbnail sizes** to make the set explicit.

### Added
- **Full-text search.** Mark `text`, `editor`, `email` or `url` fields as **Searchable** (field option `searchable: true`) and query them with `?search=` on the list endpoint. Words are ANDed, the last one matches as a prefix, and matching ignores case and accents. Results are ordered by relevance unless `sort` is set. Search combines with `filter`, pagination, the list rule and `nearVector`. Backed by a SQLite FTS5 index kept in sync by triggers, so every write path updates it. Existing records are indexed when the option is turned on.
- **Image output format and quality.** `?format=webp|jpeg|png|auto` re-encodes an image, with or without `?thumb=`. `auto` returns WebP when the browser accepts it and sets `Vary: Accept`. `?quality=1-100` applies to JPEG and WebP.
- **One-side thumbnails.** `?thumb=800x0` or `?thumb=0x300` keeps the aspect ratio.
- **Allowed thumbnail sizes per file field** (option `thumbs`). Non-admin requests for other sizes get the original file.
- **Aggregations.** `GET /api/v1/:collection/_aggregate?agg=count,sum(amount)&groupBy=status` returns count / sum / avg / min / max, grouped by up to 3 fields or by time buckets (`created:month`). Scoped like a list: filter, search and the list rule all apply. SDK: `collection.aggregate()`.
- **OpenAPI spec.** `GET /api/v1/openapi.json` describes the records, auth and files API as OpenAPI 3.1, generated from the live collections, for Swagger UI / Postman / client generators in any language. Admin-only by default; **API preview → public spec** serves it to anyone, minus admin-only collections.

### Security
- Anyone who could read an image could request unlimited distinct thumbnail sizes, each one a fresh decode and a new cache file. A file now accumulates at most 32 cached variants from non-admin requests; beyond that the original is served.

### Fixed
- `?thumb=WxH&fit=cover` ignored `fit` when it was sent as its own query parameter (the form shown in the docs). Only the `WxH_cover` suffix worked.

## [0.14.0] — 2026-10-11

### Added
- **Scheduled backups.** Settings → Backup & restore can now take snapshots on a cron schedule (UTC, default daily 03:00), keep the newest N (default 7), and optionally copy each one to a private S3-compatible bucket. Stored snapshots can be listed, downloaded, restored and deleted from the same page or via `/api/v1/admin/backups`. In cluster mode only one worker runs each backup.

### Fixed
- `GET /admin/backup` streamed the live database file, which could miss recent writes still in the WAL. It now returns a `VACUUM INTO` snapshot.
- The S3 storage secret (`s3.secret_access_key`) was stored in plaintext even with `VAULTBASE_ENCRYPTION_KEY` set. It's encrypted on the next save.
- Restore could fail on Windows with `EBUSY` because the old database handle wasn't released.

## [0.13.2] — 2026-10-10

### Upgrade notes

- **API tokens are limited to their scopes on the data API.** Records, batch, files, realtime and custom routes used to treat every API token as the admin who created it. Now `admin` keeps full access, `read` can read but not write, `write` can write under collection rules (as a non-admin), and any other scope (e.g. only `mcp:*`) is treated as anonymous. Give a token `read`, `write` or `admin` if it calls these endpoints.
- **API tokens can't be refreshed** (`401` on `/auth/refresh`).
- **File download tokens are not sessions.** They work only on the file download they were issued for.

### Security
- An API token with any scope could act as full admin on records and files, and `/auth/refresh` turned it into an unscoped admin session.
- Sign in with Apple trusted the `id_token` without verifying it. It is now checked against Apple's keys (signature, issuer, audience, expiry).
- Logged-out or deleted users' tokens still worked on the TOTP, recovery-code, email-verify, promote and OAuth2 link/unlink endpoints, and a token from one auth collection was accepted on another's. All now use the central token check.
- Revoked or force-logged-out admin tokens still worked for collection create / update / delete and for impersonation.
- Custom routes accepted revoked tokens.
- A forged API token could overwrite a real token's last-used IP and user agent.
- The `/metrics` bearer token is compared in constant time.

### Changed
- Removed the UPX compression scripts (UPX-packed binaries crash on start). `--help` no longer claims the encryption key can come from a file.

## [0.13.1] — 2026-10-10

### Upgrade notes

- **AVIF uploads are no longer resized.** `?thumb=` on an AVIF file returns the original. AVIF files are still stored and served as before.

### Fixed
- **Image thumbnails in release binaries.** `?thumb=` returned the original file for every format, because the image codecs were not part of the single binary. Thumbnails now use Bun's built-in image engine for JPEG, PNG, WebP and still GIFs, and are generated and cached as intended. Large photos thumbnail in milliseconds instead of most of a second.
- JPEG thumbnails respect EXIF orientation, so phone photos come out upright.
- Animated GIF thumbnails stay animated instead of becoming a still PNG of the first frame.
- PNG thumbnails are compressed. They were written uncompressed, often larger than the source.

## [0.13.0] — 2026-10-10

### Upgrade notes

- **History cleanup.** A daily task deletes finished queue jobs and finished webhook deliveries older than 30 days. Change or disable it in **Settings → Data retention** (`maintenance.retention_days`, `0` keeps everything). Expired token revocations and one-time auth tokens are always cleaned up.
- **ETag format** is now `W/"<updated>-<content hash>"`, so two writes in the same second get different tags. Old `W/"<updated>"` tags still work on `If-Match`; on `If-None-Match` they no longer match (fresh `200` instead of `304`). Treat ETags as opaque.
- **Unique fields.** Adding a unique field to an existing collection works, and switching `unique` on is enforced in the database (`422` over duplicate data). A field created unique together with its collection can't have `unique` switched off in place; drop and re-add it.
- **Delete order.** `restrict` checks, then the `beforeDelete` hook, then cascades. A refusing hook leaves children untouched; cascading deletes are atomic.
- **Batches.** Other record writes wait while a batch runs; its realtime events, webhooks and after-hooks fire only after `COMMIT`.
- **Startup migrations** add timestamp indexes to every collection, file-metadata indexes and three jobs-log columns.

### Added
- Settings → Data retention (`maintenance.retention_days`).

### Fixed
- Collection rename renames the table and indexes and repoints relation fields, hooks and record history.
- Cascading deletes are atomic and run after `beforeDelete`.
- `helpers.enqueue` honours `retries`, `backoff` and `retryDelayMs`.
- Realtime no longer accumulates empty topics; dead sockets are dropped from every topic.
- Dependencies: nodemailer 10 (clears the open Dependabot alerts), elysia 1.4.30, react-router 7.18, DOMPurify 3.4.16.

### Performance
- Record writes ~1.8× faster (hook / webhook / relation lookups cached).
- Default list sort and file lookups use indexes.
- Admin initial load ~5.8 MB → ~1.5 MB (Monaco and Quill load on demand).
- Repeat vector searches ~12× faster (parsed-vector cache).
- Logs page reads only new lines; request logging no longer re-verifies JWTs; each uncached thumbnail is generated once.

## [0.12.0] — 2026-10-10

### Upgrade notes

- **Uploads are capped at 50 MB per request by default** (`413` above it); configurable in Settings → File storage, up to 128 MB.
- **`perPage` is capped at 500**; invalid `page` / `perPage` fall back to 1 / 30.
- **A list rule that can't be evaluated returns `403`** instead of being silently dropped; an invalid `?filter=` returns `400`.
- **Impersonation tokens can't be refreshed** (`403`).

### Fixed
- List rules fail closed: broken or cold-cache rules no longer expose every row.
- Token refresh kept only `id` / `email`, logging every user out; claims are now preserved.
- Batch requests no longer sweep other requests' writes into their transaction; concurrent batches work.
- Webhook deliveries are claimed before sending (no duplicate POSTs); cron jobs run once per slot, also under `vaultbase cluster`.
- Realtime accepts non-browser clients without an `Origin` header again.
- `vaultbase --help` / `--version` exit instead of hanging.

### Changed
- Linux binaries ~118 MB → ~89 MB (Bun 1.4.2, admin UI embedded once), plus `.xz` downloads (~30 MB) that the installer prefers.
- New vb monogram brand in the admin UI.

## [0.11.5] — 2026-05-06
### Security
- Fixes from the 2026-05 audit: MCP `run_sql` write bypass via CTEs, MCP settings scope, records sort identifier validation, trusted-proxy CIDR matching, realtime `Origin` checks, SQL sandbox quoting.

## [0.11.4] — 2026-05-05
### Added
- Built-in HTML pages for `/auth/reset`, `/auth/verify` and `/auth/otp`.
- Server version shown in the admin sidebar, login and setup screens.

## [0.11.3] — 2026-05-05
### Fixed
- MCP write tools, CLI help, secret reveal toggles in the admin.

## [0.11.2] — 2026-05-04
### Fixed
- `setup-admin --force` resets an existing admin's password instead of failing.

## [0.11.1] — 2026-05-04
### Added / Fixed
- Auth hooks, admin records flow for auth collections, collection stats.

## [0.11.0] — 2026-05-04
### Changed
- Auth is a first-class collection: each auth collection has its own `vb_<name>` table with inline auth columns. Tokens minted before 0.11 are rejected; users sign in again.
### Added
- `vaultbase wipe` reset CLI.

## [0.10.2] — 2026-05-03
### Fixed / Added
- Realtime subscriptions keyed by connection id; event-typed topics (`posts.create`, `*.delete`).

## [0.10.1] — 2026-05-03
### Fixed
- Realtime unsubscribe with the wildcard forms (`<col>.*`, `<col>/*`) was a no-op.

## [0.10.0] — 2026-05-03
### Added
- API tokens, a built-in MCP server for AI agents, and a SQL runner with IntelliSense.

## [0.9.1] — 2026-05-03
### Changed
- Admin UI redesign; coral brand accent.
### Fixed
- geoPoint map renders (OpenStreetMap tiles allowed in CSP).

## [0.9.0] — 2026-05-03
### Added
- Push notifications via OneSignal and FCM.

## [0.8.2] — 2026-05-03
### Added
- geoPoint fields shown on a map in the admin (Leaflet + OpenStreetMap).

## [0.8.1] — 2026-05-03
### Fixed
- Remaining `/api/` references moved to `/api/v1/`, including the admin theme loader.

## [0.8.0] — 2026-05-03
### Added
- `vaultbase update`: self-update with SHA-256 and cosign verification.

## [0.7.1] — 2026-05-03
### Fixed / Performance
- Request logs mounted inside `/api/v1`; WAL size capped and optimizer sampling tuned.

## [0.7.0] — 2026-05-01
### Changed
- **Breaking:** the API moved under `/api/v1/`.

## [0.6.1] — 2026-05-01
### Security
- Dependency advisories closed (drizzle-orm SQL identifier escaping, drizzle-kit, Quill pinned).

## [0.6.0] — 2026-05-01
### Added
- Rule-based file protection: per-field rules, one-time and IP-bound tokens, download audit.

## [0.5.0] — 2026-05-01
### Added
- Outbound webhooks with HMAC-signed deliveries and an admin UI.

## [0.4.0] — 2026-05-01
### Added
- Feature flags phase 2–3: WebSocket push, segments, prerequisites.

## [0.3.0] — 2026-05-01
### Added
- Feature flags: evaluation engine and admin UI.

## [0.2.2] — 2026-05-01
### Added
- Admin Theme tab: customizable accent and surface colors.

## [0.2.1] — 2026-05-01
### Fixed
- Disabling MFA now sticks.

## [0.2.0] — 2026-05-01
### Added
- Security settings: sessions, brute-force lockout, trusted proxies, fingerprints.

## [0.1.9] — 2026-05-01
### Fixed
- Admin Updates tab layout.

## [0.1.8] — 2026-05-01
### Changed
- Admin Updates tab redesign.

## [0.1.7] — 2026-05-01
### Added
- CORS settings, password policy, Prometheus metrics, update checker.

## [0.1.6] — 2026-05-01
### Added
- Admin audit log page and hook egress settings.

## [0.1.5] — 2026-05-01
### Added
- Admin actions audit log; `vaultbase backup --to <dest>`; SBOMs and cosign keyless signatures on releases.

## [0.1.4] — 2026-05-01
### Security
- SSRF denylist for `helpers.http`.

## [0.1.3] — 2026-04-30
### Security
- Every admin endpoint verifies tokens through one path; record history encrypted at rest; admin password policy.

## [0.1.2] — 2026-04-30
### Security
- drizzle 0.44.7 and DOMPurify 3.4.2.

## [0.1.1] — 2026-04-30
### Fixed
- imagescript codec patch for single-binary builds; installer resolves the latest release correctly.

## [0.1.0] — 2026-04-30
- First release.
