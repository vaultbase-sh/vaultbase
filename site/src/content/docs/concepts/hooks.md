---
title: Hooks · routes · cron
description: Server-side JavaScript that runs alongside the records API — record events, custom HTTP routes, and scheduled jobs.
---

Vaultbase ships a JavaScript runtime for three kinds of code that live in the
admin UI: **hooks**, **custom routes**, and **cron jobs**. All three use a
Monaco editor with TypeScript IntelliSense over a typed `ctx` object.

Code is compiled and cached on save. Errors abort the operation (hooks) or
return a `500` (routes) — visible in the **Logs** page.

## Record event hooks

Six events × every collection:

- `beforeCreate`, `afterCreate`
- `beforeUpdate`, `afterUpdate`
- `beforeDelete`, `afterDelete`

`before*` hooks run **synchronously** in the same request — throwing
`helpers.abort("...")` aborts with a `422`. `after*` hooks run async,
fire-and-forget.

```ts
// beforeCreate on `posts`
ctx.record.title = ctx.helpers.slug(ctx.record.title);
if (!ctx.auth) ctx.helpers.abort("Login required");

// afterUpdate on `users`
ctx.helpers.log(`User ${ctx.record.email} updated their profile`);
```

`ctx.record` is **typed for the collection** — IntelliSense knows your
fields. `ctx.existing` is populated for `beforeUpdate`, `beforeDelete`,
`afterUpdate`, `afterDelete`.

## Custom HTTP routes

Mount any HTTP handler under `/api/custom/<path>`. Methods, path params,
query, body all available on `ctx`.

```ts
// route: GET /api/custom/health/:service
const svc = ctx.params.service;
const ok = await ctx.helpers.fetch(`https://${svc}/healthz`);
ctx.set.status = ok.ok ? 200 : 503;
return { service: svc, healthy: ok.ok };
```

Routes fire **before** built-in route resolution — so they can't be
shadowed by `/api/<collection>` patterns.

## Cron jobs

UTC cron expressions, ticked every 30 seconds. The admin UI renders human
descriptions via `cronstrue` and links to crontab.guru.

```ts
// cron: 0 3 * * *  (every day at 03:00 UTC)
const stale = await ctx.helpers.query("sessions", {
  filter: 'created < ' + (Date.now()/1000 - 7*24*3600),
  perPage: 1000,
});
ctx.helpers.log(`Cleaning ${stale.totalItems} stale sessions`);
// ...
```

Each job tracks `last_run_at`, `next_run_at`, `last_status`, `last_error` —
visible as columns in the Cron tab.

## The `helpers` object

Available on every `ctx.helpers`:

```ts
helpers.slug(s: string): string;
  // 'Hello World!' → 'hello-world'

helpers.abort(message: string): never;
  // throws a 422-mapped error (before* hooks only)

helpers.find<T>(collection: string, id: string): Promise<T | null>;
  // single record by id

helpers.query<T>(collection: string, opts?: {
  filter?: string;
  sort?: string;
  perPage?: number;
}): Promise<{ data: T[]; totalItems: number }>;

helpers.fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  // outbound HTTP — Web Fetch API

helpers.email(opts: { to: string; subject: string; body: string }): Promise<void>;
  // sends via the configured SMTP (Settings → SMTP)

helpers.log(...args: unknown[]): void;
  // server-side log — appears as a HOOK row in the Logs page
```

## Hook context shapes

```ts
interface HookContext {
  record: ThisCollectionRecord;       // mutable in before*
  existing: ThisCollectionRecord | null;  // null on create
  auth: { id, type, email? } | null;
  helpers: HookHelpers;
}

interface RouteContext {
  req: Request;
  method: string;
  path: string;                       // inner path (after /api/custom)
  params: Record<string, string>;     // from :name segments
  query: Record<string, string>;
  body: any;                          // parsed JSON
  auth: { id, type, email? } | null;
  helpers: HookHelpers;
  set: { status: number; headers: Record<string, string> };
}

interface JobContext {
  helpers: HookHelpers;
  scheduledAt: number;                // unix seconds
}
```

## Caveats

- **Hooks bypass realtime broadcasts.** `helpers.find/query` reads but
  doesn't broadcast — write through the records API or expose a custom route.
- **Hooks bypass API rules.** They run in a privileged context — no
  `evaluateRule` between them and the data.
- **Batch ops bypass per-collection hooks today.** A pre-existing limitation
  tracked in the parity doc's Follow-ups.
