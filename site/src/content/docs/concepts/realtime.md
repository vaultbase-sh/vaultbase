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

The auth context is stored per-connection and is available for future
per-record filtering features. Today it's captured but not yet consulted at
broadcast time — record-level access checks happen at REST API time, not
WebSocket time.

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
- **No SSE fallback** — WebSockets only. PocketBase uses SSE; we deliberately
  chose WS.
- **Connection cap** — bound by Bun's WebSocket implementation (~thousands per
  process by default).
