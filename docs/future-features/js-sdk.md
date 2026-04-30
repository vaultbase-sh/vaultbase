# JS SDK (TypeScript) — design

> Status: **spec**. Not implemented. Build target: **v1 in ~10 focused days**.

Single npm package — **`vaultbase`** — that wraps the REST + WS/SSE wire
in a small, fully-typed, zero-dep client. Goal: typed end-to-end without
building a query AST, a state manager, or a forms library.

---

## Scope

**v1 ships:**

1. Core HTTP client with auth, JWT auto-refresh, and per-key request
   cancellation (opt-in).
2. Typed `Collection<T>` for record CRUD with codegen-driven inference.
3. Realtime — WebSocket-first with SSE auto-fallback. Topic-based.
4. File uploads with progress, multi-file, auto-token for `protected` fields.
5. Auth flows for every server endpoint (login, register, OAuth2, OTP,
   MFA + recovery, anonymous, promote, impersonate, refresh, logout).
6. Batch helper.
7. Custom-route helper.
8. Codegen CLI — reads a committed `vaultbase-schema.json` (or live admin
   endpoint) and emits a typed `.ts`.

**v1.1 follow-up (separate ship):**

- Offline mutation queue (IndexedDB) + server-side idempotency table.
- Tagged-template filter helper (`vb.q\`title ~ ${q}\``).
- Typed expand inference for nested paths (template literal types,
  depth cap = 2).

**Companion packages (later):** `@vaultbase/react`, `@vaultbase/admin`.

Distribution: ESM + CJS dual build, browser/Node/Bun/Deno entries, full
`.d.ts`. Tree-shakeable — apps that only need auth pay nothing for
realtime.

---

## Five decisions that differ from PocketBase

These are concrete deviations. Each is intentional.

| # | Choice | Why |
|---|---|---|
| 1 | Package name **`vaultbase`** (unscoped) | Owns npm slot, shorter import, mirrors PocketBase's `pocketbase`. Scoped names reserved for add-ons. |
| 2 | Auto-cancel **default OFF**, opt-in per call | PB's default-ON pattern is the project's most-cited foot-gun (mounted-twice components cancel each other). Make it explicit. |
| 3 | Codegen reads **`vaultbase-schema.json`** (committed) by default; live admin-token fetch optional | Avoids the "dev points `vb-types` at prod with leaked admin token" failure mode. Snapshot file is the source of truth; CI builds reproducibly. |
| 4 | Default `BrowserAuthStore` = **sessionStorage + HttpOnly cookie**, NOT localStorage | Reflects the same security audit fix the admin SPA shipped: `localStorage` token is XSS-readable forever; sessionStorage dies on tab close, cookie carries across reload. |
| 5 | Independent SemVer for SDK; advertise `serverCompat: ">=1.4 <2.0"` in `package.json` | Doc-coupled SDK.minor ↔ server.minor blocks SDK bugfix releases. Range string lets CI verify compat. |

---

## Surface

```ts
import { Vaultbase } from "vaultbase";
import type { Schema } from "./vaultbase-schema.gen";  // from codegen

const vb = new Vaultbase<Schema>({
  baseUrl: "https://api.example.com",
  // Defaults: SessionStorageAuthStore in browsers, MemoryAuthStore on server.
  // Override only when you need cross-tab sync (CookieAuthStore) or SSR.
});

// Auth — typed return, full IntelliSense on collection-specific fields
const { token, record } = await vb.auth.users.login({
  email: "alice@x.com",
  password: "supersecret",
});

// Records — typed end-to-end, no `any`
const post = await vb.collection("posts").create({
  title: "hi",         // ✓ typed against Schema['posts']
  author: record.id,   // ✓ relation field accepts string id
});

const list = await vb.collection("posts").list({
  page: 1,
  perPage: 30,
  filter: 'published = true',
  sort: '-created',
  expand: 'author,comments.user',     // typed in v1.1
});
list.data[0].title;                   // string — verified by TS

// Auto-cancel: opt-in via requestKey
vb.collection("posts").list(
  { filter: `title ~ "${q}"` },
  { requestKey: "search-box" },       // new request with same key cancels prior
);

// Realtime
const off = vb.collection("posts").subscribe("*", (e) => {
  // e: { type: "create"|"update"|"delete"; record?: Post; id?: string }
});
off();                                // unsubscribe

// Files
const up = await vb.files.upload("posts", post.id, "cover", file, {
  onProgress: ({ loaded, total }) => setProgress(loaded / total),
});
const url = vb.files.url(up.filename);                    // public files
const url2 = vb.files.url(up.filename, { thumb: "200x200", fit: "cover" });
// Protected files: url() auto-mints + caches the access token, refreshes ~60s before expiry.

// Batch (capped at 100 ops server-side; SDK throws on exceed)
const r = await vb.batch()
  .create("posts",      { title: "x" })
  .update("posts", "id", { title: "y" })
  .delete("posts", "id2")
  .run();

// Custom routes
const stats = await vb.custom.get<{ active: number }>("/stats/active-users");
```

---

## Architecture

```
src/
  index.ts                  -- entry, re-exports
  client.ts                 -- core HTTP + JWT refresh + retry-on-429
  errors.ts                 -- discriminated VaultbaseError union (see below)
  cancel.ts                 -- per-key AbortController map
  auth/
    store.ts                -- AuthStore interface + 3 built-ins
    flows.ts                -- login, register, oauth2, otp, mfa, ...
    refresh.ts              -- mutex'd JWT refresh + cross-tab BroadcastChannel
  collection.ts             -- typed CRUD
  realtime/
    ws.ts
    sse.ts
    manager.ts              -- transport selection + reconnect
  files.ts
  batch.ts
  custom.ts
  codegen/
    bin.ts                  -- the `vb-types` CLI
    generate.ts             -- schema JSON → ts
tests/
  unit/
  integration/              -- vs a real Vaultbase
```

Located under `sdks/js/` in the main monorepo (`workspaces: ["sdks/*"]`).
Single CI, single release cadence per `serverCompat` range.

---

## Error model

A discriminated union. Apps `switch (e.kind)` instead of string-matching.

```ts
export type VaultbaseError =
  | { kind: "network";    message: string; cause?: unknown }
  | { kind: "auth";       message: string; reason: "expired" | "invalid" | "forbidden" }
  | { kind: "validation"; message: string; details: Record<string, string> }
  | { kind: "rate_limit"; message: string; retryAfterMs: number }
  | { kind: "conflict";   message: string; serverCode: 409 | 422 }
  | { kind: "server";     message: string; status: number };

// every SDK call rejects with VaultbaseError; never a raw string or Response.
```

Class-based (`class VaultbaseError extends Error`) so existing `instanceof
Error` paths keep working; `kind` is the discriminant.

---

## Auto-cancel

Off by default. Opt in by passing `requestKey`. New request with the
same key aborts the previous in-flight one.

```ts
// One key per logical query
vb.collection("posts").list({ filter: `title ~ "${q}"` }, { requestKey: "search" });

// Disable explicitly when default is on (e.g., per-instance config)
vb.collection("posts").list({ filter: 'x' }, { requestKey: null });
```

Internally a `Map<string, AbortController>` on the client. Aborted
requests reject with `{ kind: "network", message: "aborted", cause: <DOMException> }`.

A future global config flag `defaultAutoCancel: true` exists for users who
want the PocketBase ergonomic; off in v1.

---

## Realtime

### Transport selection

1. Try WebSocket (`new WebSocket(...)`). 99% of environments.
2. On upgrade failure, fall back to SSE (`GET /api/realtime`).
3. Re-attempt WS on every reconnect (cheap; some networks fix themselves).

### Reconnect

Exponential backoff with jitter: 250ms, 500ms, 1s, 2s, 5s, 10s (cap),
plus ±20% random jitter on each interval. Re-subscribe all topics on
each reconnect from a stored topic list. New `clientId` each reconnect
(server doesn't preserve them).

**Gap window**: events fired between disconnect and reconnect are lost.
This is documented; mission-critical apps should reconcile via a
follow-up `list({ filter: 'updated > <last_seen>' })`. Server-side
"missed events catchup" is not in scope for v1.

### Subscribe API

```ts
type SubscribeFilter =
  | "*"            // every event for the collection
  | string         // a specific record id
  | string[]       // multiple record ids

const off = vb.collection<Post>("posts").subscribe("*", (e) => {});
const off2 = vb.collection("posts").subscribe(["abc", "def"], (e) => {});
```

Calling the returned function unsubscribes. SDK refcounts — multiple
subscribers on the same topic share the underlying server subscription.

Events are delivered to matching callbacks on the calling tick. SDK
de-dupes per (clientId, eventId) when the server fans out to the same
client through both a specific topic and `*`.

### Origin handling

WS upgrade includes the page's `Origin` automatically. Server's
`security.allowed_origins` setting must include the SDK consumer's
origin. SDK surfaces upgrade rejection as
`{ kind: "auth", reason: "forbidden", message: "Origin not allowed" }`.

---

## Auth

### Stores

```ts
interface AuthStore {
  get(): { token: string; record: AnyRecord } | null;
  set(value: { token: string; record: AnyRecord } | null): void;
  onChange?(listener: () => void): () => void;
}
```

Built-ins, in default-preference order on the browser:

1. **`CookieAuthStore`** — wraps an HttpOnly cookie set server-side.
   Host (Next.js, Astro, SvelteKit middleware) does the cookie writing;
   SDK reads via the `cookie` HTTP request header on SSR / sends
   `credentials: "include"` on browser fetches.
2. **`SessionStorageAuthStore`** — survives F5 refresh in the same tab,
   gone on tab close. Default for client-only SPAs.
3. **`MemoryAuthStore`** — Node, SSR, Bun, Deno. Default off-browser.

`LocalStorageAuthStore` is **available but not default**, with a JSDoc
warning: "Token stays readable to any future XSS for the lifetime of
the browser profile. Prefer `SessionStorageAuthStore`."

### JWT refresh

- SDK proactively refreshes when the token's `exp` is within 60s.
- Refresh is mutex'd via `BroadcastChannel("vaultbase-refresh")` on the
  browser so two tabs / two pending requests collapse to one refresh.
- On refresh failure, SDK calls `store.set(null)` and emits
  `{ kind: "auth", reason: "expired" }`.
- Cookie-based deployments: refresh hits the same `/api/auth/refresh`
  endpoint; the server sets a new cookie. SDK never touches the token
  value directly in cookie mode.

### Multi-realm auth

Two auth collections (e.g., `users` + `customers`) get separate
namespaced flows:

```ts
await vb.auth.users.login({ email, password });
await vb.auth.customers.login({ email, password });
```

Active store is keyed per realm; SDK maintains both, requests carry the
realm-specific token where the endpoint expects it.

---

## Codegen

Two modes. Snapshot is the recommended one.

### Snapshot mode (default)

```bash
# One-time: snapshot the schema
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.example.com/api/admin/migrations/snapshot \
  > vaultbase-schema.json

# Commit `vaultbase-schema.json`. Anyone can regen types from it:
npx vb-types --schema=./vaultbase-schema.json --out=./vaultbase-schema.gen.ts
```

CI builds reproducibly from the committed file. No admin tokens in CI.

### Live mode

```bash
npx vb-types --url=https://api.example.com --admin-token=$VB_ADMIN_TOKEN
```

For dev convenience only. Document loudly: "do not run against prod with
a long-lived token."

### Generated shape

```ts
// AUTO-GENERATED. Do not edit.

export interface PostRecord {
  id: string;
  created: number;
  updated: number;
  title: string;
  body?: string;
  author: string;                     // relation → "users"
  published?: boolean;
  tags?: ("urgent" | "draft" | "archived")[];   // select.multiple → string union
  cover?: string;
}

export interface PostCreate {
  title: string;
  body?: string;
  author: string;
  published?: boolean;
  tags?: ("urgent" | "draft" | "archived")[];
  cover?: string;
  // password fields appear here for `auth` collections, never on Record.
}

export type Schema = {
  posts: { record: PostRecord; create: PostCreate; update: Partial<PostCreate> };
  users: { record: UserRecord; create: UserCreate; update: Partial<UserCreate> };
};
```

### Edge cases (handled)

| Case | Output |
|---|---|
| `select.multiple` | `("a" \| "b")[]` |
| `view` collection | `Record` only, no `Create` / `Update` |
| `auth` implicit fields | `email` + `verified` on Record; `email` + `password` on Create |
| `password` field type | Never on Record; required on Create |
| Encrypted text/email/url | Same TS type as plaintext (encryption transparent on wire) |
| `multiple: true` file field | `string[]` |
| Single file field | `string` |
| Geo point | `{ lat: number; lng: number }` |
| Circular relation in expand | Depth-capped at 2 in v1.1 typed-expand |

Codegen runs are atomic — write to `<out>.tmp`, rename. No half-written
types ever appear on disk.

---

## Files

```ts
const meta = await vb.files.upload("posts", postId, "cover", file, {
  onProgress: ({ loaded, total }) => {},
  signal: ac.signal,
});

vb.files.url(filename);                                     // public file
vb.files.url(filename, { thumb: "200x200", fit: "cover" }); // with thumb
await vb.files.token(filename);                             // mints 1h token
await vb.files.delete("posts", postId, "cover");
await vb.files.delete("posts", postId, "cover", filename);  // multi-file specific
```

For protected fields, `url()` auto-mints + caches per-filename tokens
in-memory and refreshes ~60s before expiry. Cache is per-`Vaultbase`
instance.

Multi-file fields: `vb.files.upload(...)` accepts `File | File[]`; SDK
posts each as a separate `file` form-data entry.

Progress events from streaming `fetch` upload in modern runtimes; fall
back to XHR on older browsers. Node / Bun: no progress, single emission
on completion.

---

## Batch

```ts
const r = await vb.batch()
  .create("posts",      { title: "x" })
  .update("posts", "id", { title: "y" })
  .delete("posts", "id2")
  .get("users",    "id3")
  .list("posts",        { filter: 'x' })
  .run();

r.data[0]; // { status: 201; body: PostRecord }
r.data[1]; // { status: 200; body: PostRecord }
```

100-op cap (server-enforced); SDK throws `{ kind: "validation", … }` on
exceed before sending. Atomic on the server — first failure rolls back
the whole transaction.

---

## Rate limit handling

Server returns `429 + Retry-After` for rate-limited requests. SDK
behavior:

- One automatic retry per call after `Retry-After` seconds (capped at
  10s; longer waits surface as `{ kind: "rate_limit", retryAfterMs }`).
- Auth-refresh path is special-cased: NEVER auto-retried — surfaces
  immediately so the caller can fail fast.
- Offline replay (v1.1) respects 429 globally and pauses the queue.

---

## Build

| Concern | Choice |
|---|---|
| Bundler | `tsup` (esbuild-backed, fast) |
| Outputs | ESM + CJS + UMD (browser global `Vaultbase`) |
| Targets | ES2020 (covers all live browsers, Node 18+, Bun, Deno) |
| Types | `tsc --emitDeclarationOnly` + api-extractor bundle |
| Source maps | Inline in dev, separate `.map` in prod |
| Tree shaking | All exports `__PURE__`-annotated; per-feature sub-imports (`vaultbase/realtime`) |
| Size budget | < 6 KB gzipped for core (auth + records); +3 KB realtime; +5 KB offline (v1.1). Total < 15 KB gzipped. |
| Tests | `bun test` + integration suite vs a real Vaultbase |

---

## Versioning

- SDK semver is **independent** of the server.
- `package.json` includes `"vaultbaseServerCompat": ">=1.4 <2.0"`.
- A `vb compat` CLI (or `vb.compat()` runtime check) hits
  `/api/health/version` and warns on mismatch.
- Breaking changes are major. Server features that require new SDK
  endpoints bump the SDK minor; bug fixes bump the patch.

---

## v1.1 follow-up: offline + filter helper

Cut from v1 to ship the core in 10 days. Outlined here so the design
doesn't paint v1 into a corner.

### Offline mutation queue

- Storage: IndexedDB (browser), Memory (Node/Bun/Deno default), pluggable
  for React Native (AsyncStorage adapter).
- Each mutation gets `idempotencyKey: <uuid>`; queued when a request
  rejects with `{ kind: "network" }`.
- **Server change**: `vaultbase_idempotency` table, key `(user_id,
  idempotency_key)`, response cached for 24h. Replay returns the cached
  response. Schema: ~50 lines + a small ALTER. TTL'd by daily GC.
- Replay on reconnect: linear order, one-at-a-time, respect 429.
- Auth expired during offline period → SDK pauses queue, emits
  `{ kind: "auth", reason: "expired" }`, resumes on next successful
  auth.
- Schema drift (queued op against missing field) → `{ kind:
  "validation" }` on replay; SDK marks failed and exposes via
  `vb.offline.failed()`.
- App-visible queue: `vb.offline.pending(): QueuedOp[]` for "3 changes
  pending" UI.

### Tagged-template filter helper

Cheap typed-ness without a full AST:

```ts
const q = vb.q`title ~ ${userInput} && published = ${true}`;
// q is { sql: "title ~ ? && published = ?", binds: [userInput, true] }
// SDK serializes binds with the same escaping rules the server's parser
// expects. No string concat, no injection foot-gun.
```

Codegen-aware variant later: field names autocomplete inside the tag.

---

## Phasing

| Phase | Cum days | Ships |
|---|---|---|
| 1 | 3 | Core HTTP + auth flows + auto-cancel + typed `Collection<T>` (hand-typed Schema, no codegen). MVP for 90% of apps. |
| 2 | 7 | Realtime (WS + SSE + reconnect) + Files + Batch + Custom routes |
| 3 | 10 | Codegen CLI (snapshot mode + live mode). **Headline of the release.** |
| **v1** | **10** | Public release. |
| 4 | +6 | Offline queue + server idempotency table + filter tag. **v1.1.** |
| 5 | later | `@vaultbase/react`, then Vue, then Svelte. |

---

## What this is NOT

- Not a server-side hook runtime. Hooks live on the server.
- Not a query builder beyond filter strings + the v1.1 tag helper.
- Not GraphQL, gRPC, or anything other than wrapped REST + WS/SSE.
- Not a state-management library. Wrap with React Query / SWR / Zustand
  externally.
- Not a forms library.
- Not an offline-first conflict resolver. Replay is linear; CRDTs are
  out of scope forever.

---

## Why ship this

Vaultbase has a complete server. Apps interact via wire-protocol docs
and hand-rolled `fetch`. **The missing first-party SDK is the single
biggest gap vs PocketBase / Supabase / Appwrite.** Every example in the
docs site is `curl`. TypeScript shops won't pick this if they have to
build their own client first.

A typed SDK:

- **Closes the deal** for TS shops that compare BaaS options on DX.
- **Validates the API design** by building a real consumer.
- **Makes new server features visible** the moment they ship (codegen
  surfaces field changes immediately).
- **Unblocks the React / Vue / Svelte** companions.

## Why not yet

- 10 focused days. Big chunk of attention.
- Server still has unfinished work (Redis, feature flags, user groups).
  Shipping the SDK before those means a follow-up to expose them.
- Codegen + generics get gnarly; a wrong abstraction here creates worse
  DX than no SDK.

**Recommendation:** ship anyway. Phase the unfinished server features
*through* the SDK rather than ahead of it.

---

## Open questions

1. **CookieAuthStore wiring**: ship per-framework recipes (Next.js,
   Astro, SvelteKit) in docs, or a thin sub-package per framework?
   Lean: docs first, sub-packages once a framework has > 100 SDK
   consumers.
2. **Idempotency key TTL**: 24h vs 7d vs configurable. Lean: 24h fixed
   in v1.1; configurable in v2.
3. **`vb.q` tag escaping**: prepared-statement style (`?` placeholders)
   vs server-side filter rebuild. Lean: prepared style — matches the
   parser's existing behavior.
4. **`@vaultbase/admin` separate package**: bundles admin-only endpoints
   so user-app builds don't include them. Lean: yes; same monorepo,
   sub-package.
5. **Node 16 support**: dropped. ES2020 needs 18+. Document.
6. **CSP / Trusted Types**: SDK is fetch + WS only, no inline scripts,
   no `eval`, no `new Function`. CSP-compatible by construction. Worth
   stating in README.

---

## Bottom line

Ship `vaultbase` as a 10-day v1: core + realtime + files + codegen.
Defer offline to v1.1 (6 days, server idempotency bundled in). React
companion follows once a real app validates the SDK's shape. Total path
from zero to "BaaS users have nothing to complain about": ~22 days
across two minor releases.

The five concrete deviations from the obvious PocketBase clone — package
name, auto-cancel default, codegen source, default auth store, semver
independence — are each a small choice that compounds into a measurably
better DX over a 1-year horizon.
