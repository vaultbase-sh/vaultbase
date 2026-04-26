# Realtime WebSocket Design

**Goal:** Push record change events to subscribed clients over the existing `/api/realtime` WebSocket endpoint.

**Scope:** Collection-level subscriptions only. No auth on WS connection for v1.

---

## Architecture

In-process singleton `RealtimeManager` holds a `Map<collectionName, Set<ServerWebSocket>>`. RecordService calls it after each mutation. No external dependencies.

## Components

### `src/realtime/manager.ts` (new)

Singleton module exporting four functions:

- `subscribe(ws, collections: string[])` — add ws to each named collection's Set (create Set if absent)
- `unsubscribe(ws, collections: string[])` — remove ws from named Sets
- `disconnectAll(ws)` — remove ws from every Set (called on close)
- `broadcast(collection: string, event: RealtimeEvent)` — JSON-serialize and send to all ws in the Set; silently remove dead sockets

### Event shape (server → client)

```ts
type RealtimeEvent =
  | { type: "connected" }
  | { type: "create"; collection: string; record: RecordWithMeta }
  | { type: "update"; collection: string; record: RecordWithMeta }
  | { type: "delete"; collection: string; id: string };
```

### Client → server messages

```ts
type ClientMessage =
  | { type: "subscribe";   collections: string[] }
  | { type: "unsubscribe"; collections: string[] }
```

Unknown message types are silently ignored.

## Changes to existing files

### `src/server.ts`

Replace the stub WS handler:

```
open  → send { type: "connected" }
message → parse JSON, call subscribe or unsubscribe on manager
close → call disconnectAll on manager
```

### `src/core/records.ts`

After each mutation, call `broadcast`:

- `createRecord` → `broadcast(col.name, { type: "create", collection: col.name, record })`
- `updateRecord` → `broadcast(col.name, { type: "update", collection: col.name, record })`
- `deleteRecord` → `broadcast(col.name, { type: "delete", collection: col.name, id })`

## Data flow

```
Client --subscribe--> WS handler --> manager.subscribe(ws, ["posts"])
Client --POST /api/posts--> RecordService.createRecord --> manager.broadcast("posts", event)
manager --> ws.send(JSON) --> Client receives { type: "create", collection: "posts", record: {...} }
```

## Error handling

- Malformed JSON from client: ignore silently
- Dead socket on broadcast: catch send error, call `disconnectAll(ws)` and continue
- Manager called before any subscribers: no-op (empty Set)

## Testing

- Unit test `manager.ts`: subscribe, unsubscribe, disconnectAll, broadcast with mock ws objects
- Integration: spin up server, connect two WS clients, subscribe one to "posts", POST a record, verify only subscribed client receives event
