import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { hooks } from "../db/schema.ts";
import { createCollection } from "../core/collections.ts";
import { createRecord, deleteRecord, getRecord, RestrictError } from "../core/records.ts";
import { invalidateHookCache } from "../core/hooks.ts";
import { makeBatchPlugin } from "../api/batch.ts";
import { createPublicCollection } from "./_helpers.ts";

// deleteRecord applied cascades (deleting / nulling children) before the
// beforeDelete hook ran and outside any transaction. A hook that aborted the
// delete left the parent in place with its children already gone, and a
// cascade that failed part-way left the earlier children deleted.

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  await createPublicCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
  await createPublicCollection({
    name: "comments",
    fields: JSON.stringify([
      { name: "body", type: "text" },
      { name: "post", type: "relation", collection: "posts", options: { cascade: "cascade" } },
    ]),
  });
  await createPublicCollection({
    name: "flags",
    fields: JSON.stringify([
      { name: "comment", type: "relation", collection: "comments", options: { cascade: "restrict" } },
    ]),
  });
  invalidateHookCache();
});

afterEach(async () => {
  invalidateHookCache();
  await closeDb();
});

describe("delete: hook order and atomicity", () => {
  it("a beforeDelete hook that aborts leaves the children intact", async () => {
    const post = await createRecord("posts", { title: "p" });
    const c = await createRecord("comments", { body: "c", post: post.id });
    await getDb().insert(hooks).values({
      id: "h1", name: "deny", collection_name: "posts", event: "beforeDelete", enabled: 1,
      code: 'throw new Error("not allowed");',
    });
    invalidateHookCache();

    await expect(deleteRecord("posts", post.id)).rejects.toThrow();
    expect(await getRecord("posts", post.id)).not.toBeNull();
    expect(await getRecord("comments", c.id)).not.toBeNull();
  });

  it("a cascade that fails part-way rolls everything back", async () => {
    const post = await createRecord("posts", { title: "p" });
    const c1 = await createRecord("comments", { body: "first", post: post.id });
    const c2 = await createRecord("comments", { body: "second", post: post.id });
    // c2 is pinned by a restrict reference, so cascading into it fails
    // after c1 has already been deleted.
    await createRecord("flags", { comment: c2.id });

    await expect(deleteRecord("posts", post.id)).rejects.toBeInstanceOf(RestrictError);
    expect(await getRecord("posts", post.id)).not.toBeNull();
    expect(await getRecord("comments", c1.id)).not.toBeNull();
    expect(await getRecord("comments", c2.id)).not.toBeNull();
  });

  it("inside a batch: cascade commits with the batch, rolls back with it", async () => {
    const post = await createRecord("posts", { title: "p" });
    const c = await createRecord("comments", { body: "c", post: post.id });
    const run = (requests: unknown[]) => makeBatchPlugin("s").handle(new Request("http://localhost/batch", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requests }),
    }));

    // Cascading delete followed by a failing op → whole batch rolls back.
    const failed = await run([
      { method: "DELETE", url: `/api/v1/posts/${post.id}` },
      { method: "POST", url: "/api/v1/flags", body: { comment: "ghost-id" } }, // invalid relation → 422
    ]);
    expect(failed.status).not.toBe(200);
    expect(await getRecord("posts", post.id)).not.toBeNull();
    expect(await getRecord("comments", c.id)).not.toBeNull();

    const ok = await run([{ method: "DELETE", url: `/api/v1/posts/${post.id}` }]);
    expect(ok.status).toBe(200);
    expect(await getRecord("posts", post.id)).toBeNull();
    expect(await getRecord("comments", c.id)).toBeNull();
  });

  it("a successful cascade still deletes parent and children", async () => {
    const post = await createRecord("posts", { title: "p" });
    const c = await createRecord("comments", { body: "c", post: post.id });
    await deleteRecord("posts", post.id);
    expect(await getRecord("posts", post.id)).toBeNull();
    expect(await getRecord("comments", c.id)).toBeNull();
  });
});
