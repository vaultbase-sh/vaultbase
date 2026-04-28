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
client's reconnect logic.

## Per-record rule filtering

Every event is filtered against the collection's `view_rule` per subscriber:

| view_rule | Behavior |
|---|---|
| `null` (public) | Every subscriber receives |
| `""` (admin only) | Only admin connections receive |
| Expression (e.g. `owner = @request.auth.id`) | Evaluated per-subscriber against the record. Non-matching subscribers are skipped silently. |

Admins always receive (bypass).

Delete events evaluate against the **just-deleted record snapshot** so rules
that reference per-record fields (like `owner = @request.auth.id`) still work.

Filtering is silent — non-matching clients see no event, no error. A client
without permission cannot infer existence of records they're not allowed to
read.

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

## SSE fallback

For clients that can't open WebSockets (locked-down proxies, runtimes without
a WS API), an HTTP-only fallback exposes the same fan-out via
[Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html).

### Open the stream

```http
GET /api/realtime
Accept: text/event-stream
```

The server responds with `Content-Type: text/event-stream` and pushes:

```
event: connect
data: {"type":"connected","clientId":"<uuid>"}

event: message
data: {"type":"create","collection":"posts","record":{...}}

event: message
data: {"type":"delete","collection":"posts","id":"abc"}

: ping
```

The first frame carries a server-minted **`clientId`**. Use it to manage
subscriptions over a side-channel HTTP request. `: ping` lines are SSE
comments — clients ignore them; they keep idle connections alive through
proxies (sent every 30 seconds).

### Set subscriptions

```http
POST /api/realtime
{ "clientId": "<from connect frame>",
  "topics":   ["posts", "comments/abc"],
  "token":    "<optional jwt>"        }
   → { "data": { "clientId": "...", "topics": [...] } }
```

`subscriptions` and `collections` are accepted as aliases for `topics`.
Calling this replaces the client's full topic list (PUT semantics).
`token` attaches/refreshes the per-connection auth used for `view_rule`
filtering — same JWTs the WS path uses.

`404` if the `clientId` was never opened or has been torn down.

### Tear down

```http
DELETE /api/realtime/<clientId>
   → { "data": null }
```

Idempotent — unknown clientIds also return 200.

### Behavior matches WebSocket

- Same wildcard / per-record / per-collection topic forms.
- Same `view_rule` filtering on every event.
- Same admin-bypass.
- Heartbeat every 30s.

```js
// Browser EventSource example
const es = new EventSource("/api/realtime");
let clientId = null;

es.addEventListener("connect", (ev) => {
  ({ clientId } = JSON.parse(ev.data));
  fetch("/api/realtime", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ clientId, topics: ["posts"], token: jwt }),
  });
});

es.addEventListener("message", (ev) => {
  const event = JSON.parse(ev.data);
  // event.type === "create" | "update" | "delete"
});
```

## Limits
- **Single-process broadcast** — no clustering across nodes.
- **Hooks bypass realtime** — `helpers.find/query` reads but doesn't fire
  events.
