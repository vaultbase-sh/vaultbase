---
title: Custom routes
description: Mount your own HTTP handlers under /api/custom/* — full ctx with req, params, query, body, auth, helpers, and response controls.
---

Custom routes let you ship server-side logic that runs alongside the
records API — think webhook receivers, third-party integrations, server-only
math, or any HTTP endpoint where the built-in CRUD doesn't fit.

For the high-level overview see [Hooks · routes · cron](/concepts/hooks/).

## Mount path

Every custom route lives under `/api/custom/<your-path>`. The leading
`/api/custom` is fixed; whatever you put after is the route path you author
in the admin **Hooks → Custom routes** tab.

```
admin path:  GET  /health/:service
public URL:  GET  /api/custom/health/:service
```

Custom routes match **before** built-in routes, so they can't be shadowed
by `/api/<collection>` patterns.

## Editor

The Hooks → Custom routes tab in the admin UI provides:

- Method picker (`GET` / `POST` / `PATCH` / `PUT` / `DELETE`)
- Path input with `:name` syntax for params
- Monaco editor with TypeScript IntelliSense over `ctx`
- "Save & test" button that hits the route with a synthesized request

Saving compiles + caches the handler — errors show inline.

## Handler signature

```ts
async function handler(ctx: RouteContext) {
  // ...
  return { /* response body */ };
}
```

Whatever you `return` is JSON-encoded as the response body. To control the
status or headers, use `ctx.set`. To stream / return a non-JSON Response,
return a Web `Response` directly.

## The `ctx` object

```ts
interface RouteContext {
  // Inbound
  req: Request;                                 // raw Web Request
  method: string;                               // "GET", "POST", ...
  path: string;                                 // inner path (after /api/custom)
  params: Record<string, string>;               // from :name segments
  query: Record<string, string>;                // ?a=1&b=2 → { a: "1", b: "2" }
  body: any;                                    // parsed JSON for application/json

  // Caller identity (Bearer token decoded)
  auth: { id: string; type: "user" | "admin"; email?: string } | null;

  // Server-side helpers (same shape as in hooks/cron)
  helpers: HookHelpers;

  // Outbound shaping
  set: { status: number; headers: Record<string, string> };
}
```

Where `HookHelpers` is:

```ts
interface HookHelpers {
  slug(s: string): string;
  abort(message: string): never;
  find<T>(collection: string, id: string): Promise<T | null>;
  query<T>(collection: string, opts?: { filter?: string; sort?: string; perPage?: number }):
    Promise<{ data: T[]; totalItems: number }>;
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  email(opts: { to: string; subject: string; body: string }): Promise<void>;
  log(...args: unknown[]): void;
}
```

## Examples

### Health check that fans out

```ts
// GET /api/custom/health/:service
const r = await ctx.helpers.fetch(`https://${ctx.params.service}/healthz`, {
  signal: AbortSignal.timeout(2000),
});
ctx.set.status = r.ok ? 200 : 503;
return { service: ctx.params.service, healthy: r.ok };
```

### Public webhook receiver

```ts
// POST /api/custom/webhooks/stripe
const sig = ctx.req.headers.get("Stripe-Signature");
if (!sig) {
  ctx.set.status = 400;
  return { error: "missing signature" };
}

// ... verify signature ...
ctx.helpers.log("Stripe event:", ctx.body.type);

if (ctx.body.type === "invoice.paid") {
  const order = await ctx.helpers.find("orders", ctx.body.data.object.metadata.order_id);
  // ...
}

return { received: true };
```

### Auth-gated server-side compute

```ts
// POST /api/custom/cart/checkout
if (!ctx.auth) ctx.helpers.abort("Login required");

const cart = await ctx.helpers.query("cart_items", {
  filter: `user = "${ctx.auth.id}"`,
});

const total = cart.data.reduce((s, i) => s + i.price * i.qty, 0);
return { total, currency: "USD" };
```

`helpers.abort(message)` throws and the response becomes
`422 { error: <message> }` — same as hooks.

### Returning a non-JSON Response

```ts
// GET /api/custom/sitemap.xml
const posts = await ctx.helpers.query("posts", { perPage: 1000 });
const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${posts.data.map(p => `<url><loc>https://example.com/${p.slug}</loc></url>`).join("")}
</urlset>`;

return new Response(xml, {
  status: 200,
  headers: { "Content-Type": "application/xml" },
});
```

### Setting CORS / custom headers

```ts
// GET /api/custom/public/whatever
ctx.set.headers["Access-Control-Allow-Origin"] = "*";
ctx.set.headers["Cache-Control"] = "public, max-age=60";
return { ok: true };
```

## Auth

Custom routes don't have rule expressions — you decide who can call them
in the handler:

```ts
if (!ctx.auth) ctx.helpers.abort("Login required");
if (ctx.auth.type !== "admin") ctx.helpers.abort("Admin only");
```

Tokens are validated centrally — the same Bearer token that works for the
records API works here. Rate-limit rules apply (see
[Logging & rate limits](/concepts/logging/#rate-limits)).

## Limits

- **Body**: max 1 MB JSON (Bun default).
- **Compile errors** abort with a `500` and the error in the Logs page.
- **`helpers.fetch`** has no built-in timeout — pass an `AbortSignal` for
  outbound calls.
- Routes run in the same process as the rest of Vaultbase — long-running
  CPU work blocks other requests.

## See also

- [Hooks](/concepts/hooks/) — record-event hooks (`beforeCreate`, etc.) share
  the helpers API.
- [Logging & rate limits](/concepts/logging/) — both apply to custom routes.
