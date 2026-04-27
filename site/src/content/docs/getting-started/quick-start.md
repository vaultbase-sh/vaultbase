---
title: Quick start
description: Run Vaultbase locally, create your first collection, and read it from the REST API in under five minutes.
---

This walks you from a fresh checkout to your first record over the REST API.

## 1. Build and run

```bash
git clone https://github.com/vaultbase/vaultbase
cd vaultbase
bun install
bun run build           # compiles admin + binary → ./vaultbase
./vaultbase             # starts on :8091
```

The first `bun run build` takes ~30 seconds (compiles the admin UI + bundles
the Bun binary). After that, `./vaultbase` starts in milliseconds.

## 2. Setup wizard

Open <http://localhost:8091/_/> in your browser. On a fresh install you'll see
a setup wizard:

1. Pick an admin email and password (≥8 chars).
2. Done — you land on the Collections page.

The admin password is hashed with `Bun.password.hash` (Argon2 by default) and
stored in the `vaultbase_admin` table. The JWT signing secret is
auto-generated and persisted to `<dataDir>/.secret` if you don't set
`VAULTBASE_JWT_SECRET`.

## 3. Create a collection

Click **New collection**. In the modal:

- **Name**: `posts`
- **Type**: `Base` (default)
- **Schema**: click `+text`, name it `title`, mark Required.
- Click `+text` again, name it `body`.
- **Create collection**.

Behind the scenes, Vaultbase runs:

```sql
CREATE TABLE vb_posts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
```

— a real table with native columns, not a JSON blob.

## 4. Open the API to anyone

By default, all rules are `null` (public). If you want to lock down create:

- Click the **Schema** button on the `posts` row.
- In **API rules**, set `create_rule` to:
  ```
  @request.auth.id != ""
  ```
- Save.

Now `POST /api/posts` requires a logged-in user (any auth user).
[Read more about rules →](/concepts/rules/)

## 5. Add a record from the admin

- Open the `posts` collection (click the row).
- **New record** → fill in `title` and `body` → Create.
- You'll see it in the table.

## 6. Hit the REST API

```bash
# List
curl http://localhost:8091/api/posts

# Get one
curl http://localhost:8091/api/posts/<id>

# Filter (URL-encode in real use)
curl 'http://localhost:8091/api/posts?filter=title~"hello"&sort=-created'

# Create — needs Content-Type, no auth needed if create_rule is null
curl -X POST http://localhost:8091/api/posts \
  -H "Content-Type: application/json" \
  -d '{"title":"hello","body":"world"}'
```

Response shape:

```json
{
  "data": [
    {
      "id": "abc-123",
      "collectionId": "...",
      "collectionName": "posts",
      "title": "hello",
      "body": "world",
      "created": 1730000000,
      "updated": 1730000000
    }
  ],
  "page": 1,
  "perPage": 30,
  "totalItems": 1,
  "totalPages": 1
}
```

## 7. Subscribe to live changes

Open the browser console at any URL and paste:

```js
const ws = new WebSocket("ws://localhost:8091/realtime");
ws.onopen = () => ws.send(JSON.stringify({ type: "subscribe", topics: ["posts"] }));
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```

Now create or edit a post in the admin — you'll see the event print live.

## What's next

- [Concepts → Collections](/concepts/collections/) — base / auth / view types
- [Concepts → API rules](/concepts/rules/) — the expression language
- [API reference → Records](/api/records/) — every query parameter
- [Guides → Deployment](/guides/deployment/) — running in production
