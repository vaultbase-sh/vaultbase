---
title: Realtime
description: WebSocket subscriptions with topic-based fan-out for collections, specific records, and the wildcard topic.
---

A single WebSocket endpoint at `/realtime` carries every subscription. Topics
are strings; subscribe to as many as you like.

## Connecting

```js
const ws = new WebSocket("ws://localhost:8091/realtime");
// or with auth:
const ws = new WebSocket(`ws://localhost:8091/realtime?token=${userJwt}`);

ws.onopen = () => {
  ws.send(JSON.stringify({ type: "subscribe", topics: ["posts"] }));
};

ws.onmessage = (e) => {
  const event = JSON.parse(e.data);
  console.log(event);
};
```

The first message you receive after connection is `{ type: "connected" }`.

## Topics

Three kinds:

| Topic | Receives |
|---|---|
| `<collection>` | every event for that collection |
| `<collection>/<id>` | events for one specific record |
| `*` | every event everywhere |

Broadcasts fan out to all matching topics — a delete on `posts/abc` notifies
subscribers of `posts`, `posts/abc`, and `*` simultaneously. **Per-ws
deduplication** means a client subscribed to multiple matching topics gets
each event once, not three times.

## Event shape

```json
{ "type": "create", "collection": "posts", "record": { ...full record } }
{ "type": "update", "collection": "posts", "record": { ...full record } }
{ "type": "delete", "collection": "posts", "id": "abc" }
```

Records are the same shape as the REST API returns (with `id`, `created`,
`updated`, all field values). Deletes carry only the id since the record is gone.

## Client messages

```json
// Subscribe / unsubscribe
{ "type": "subscribe",   "topics": ["posts", "posts/abc", "*"] }
{ "type": "unsubscribe", "topics": ["posts/abc"] }

// Refresh credentials on a live connection (optional)
{ "type": "auth", "token": "<new-jwt>" }
```

`collections` is accepted as an alias for `topics` for backwards compatibility.

## Authentication

Optional. Pass a user or admin JWT in two ways:

1. **On connect** as a query param: `wss://host/realtime?token=<jwt>`
2. **Mid-connection** via `{ "type": "auth", "token": "<jwt>" }`

The auth context is stored per-connection and is **consulted at broadcast
time** to enforce each collection's `view_rule` per subscriber.

## Per-record rule filtering

Every record event (create / update / delete / cascade) is filtered against
the collection's `view_rule` for each subscriber individually:

- **Admins** always receive the event (bypass).
- **`view_rule = null`** (public) → every subscriber receives.
- **`view_rule = ""`** (admin-only) → non-admin subscribers are silently skipped.
- **Expression rule** → evaluated per-subscriber against the record. Failing
  subscribers are skipped silently — no error message, no leak that the
  record exists.

Delete events evaluate against the **just-deleted record snapshot** so a rule
like `owner = @request.auth.id` still works (the row is already gone in the DB
by broadcast time).

```js
// Example: a rule like `owner = @request.auth.id`
// Connection A is signed in as user u1, owner of post p7
// Connection B is signed in as user u2, NOT the owner
// Connection C is admin

await fetch("/api/posts/p7", { method: "PATCH", body: JSON.stringify({ title: "edited" }) });

// → A and C receive `update posts/p7`
// → B receives nothing
```

:::tip
This means a chatty client can't infer the existence of records it's not
allowed to see. Useful for multi-tenant apps where `owner` is the tenant id.
:::

## Cascade events

When a delete cascades (relation field with `cascade: "cascade"` or
`"setNull"`), each affected record fires its own broadcast event. So a
single `DELETE /api/users/alice` may emit:

- `delete posts/p1`, `delete posts/p2` (cascade)
- `update comments/c5` with `author = null` (setNull)

Each event reaches its appropriate subscribers (collection / record / wildcard).

## Hooks don't broadcast

Server-side JS hooks bypass the records API and so don't trigger
realtime events when they call `helpers.find` etc. If your hook needs to
broadcast, use `helpers.find/query` to read but call the records API
methods (or expose a custom route) to write.

## Limits

- **Single in-process subscription map** — Vaultbase is one binary; clustering
  realtime across nodes is out of scope.
- **SSE fallback available** — `GET /api/realtime` (see the
  [API page](/api/realtime/#sse-fallback)) for clients that can't open
  WebSockets.
- **Connection cap** — bound by Bun's WebSocket implementation (~thousands per
  process by default).
