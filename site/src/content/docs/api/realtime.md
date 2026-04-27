---
title: Realtime (WebSocket)
description: Wire-level reference for the /realtime WebSocket endpoint.
---

Single endpoint. Topic-based fan-out. See
[Realtime concepts](/concepts/realtime/) for the high-level overview.

## Endpoint

```
ws://<host>/realtime
ws://<host>/realtime?token=<jwt>          ← optional auth on connect
```

## Server → client

First message after connect:

```json
{ "type": "connected" }
```

Per-event messages:

```json
{ "type": "create", "collection": "<name>", "record": { ...full RecordWithMeta } }
{ "type": "update", "collection": "<name>", "record": { ...full RecordWithMeta } }
{ "type": "delete", "collection": "<name>", "id": "<record_id>" }
```

`record` matches the REST API's record shape exactly.

## Client → server

```json
{ "type": "subscribe",   "topics": ["<topic>", ...] }
{ "type": "unsubscribe", "topics": ["<topic>", ...] }
{ "type": "auth",        "token": "<jwt>" }
```

Topics:

| Form | Receives |
|---|---|
| `<collection>` | every event in that collection |
| `<collection>/<id>` | events for one specific record |
| `*` | every event in every collection |

`collections` accepted as an alias for `topics` (backwards compat).

## Fan-out

A single broadcast to `posts/abc` reaches subscribers of:

- `posts`
- `posts/abc`
- `*`

A client subscribed to multiple matching topics gets the event **once**
(per-ws dedup).

## Auth

Two ways to attach a user/admin JWT:

```js
// 1. On connect
new WebSocket(`ws://host/realtime?token=${jwt}`);

// 2. Mid-connection
ws.send(JSON.stringify({ type: "auth", token: jwt }));
```

Auth context is stored per-connection and survives reconnect cycles via the
client's reconnect logic. Today it's captured but **not yet consulted at
broadcast time** — record-level access enforcement happens at REST API time.

## Lifecycle

```
client → ws connect (optional ?token)
server → { type: "connected" }

client → { type: "subscribe", topics: [...] }    ← optional auth refresh
... events stream ...
client → { type: "unsubscribe", topics: [...] }  ← optional
client closes connection (or server closes on idle)
```

Close handler removes the connection from every subscription set
automatically.

## Limits

- **No SSE fallback** — WebSockets only.
- **Single-process broadcast** — no clustering across nodes.
- **Hooks bypass realtime** — `helpers.find/query` reads but doesn't fire
  events.
