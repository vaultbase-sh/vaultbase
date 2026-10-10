import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { hooks } from "../db/schema.ts";
import {
  createCollection, getCollection, updateCollection, parseFields, _resetCollectionCache,
} from "../core/collections.ts";
import { createRecord, getRecord, listRecords } from "../core/records.ts";
import { seedAuthUser } from "./_helpers.ts";

// updateCollection wrote the new name into the metadata row but never
// renamed vb_<old>, so every record call afterwards failed with
// "no such table" and the collection was unusable.

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => {
  _resetCollectionCache();
  closeDb();
});

describe("collection rename", () => {
  it("renames the table; records stay readable and writable under the new name", async () => {
    const col = await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    const r = await createRecord("posts", { title: "hello" });

    await updateCollection(col.id, { name: "articles" });

    expect(await getCollection("posts")).toBeNull();
    expect((await getRecord("articles", r.id))?.["title"]).toBe("hello");
    await createRecord("articles", { title: "second" });
    expect((await listRecords("articles")).totalItems).toBe(2);
  });

  it("repoints relation fields and hooks that referenced the old name", async () => {
    const posts = await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    await createCollection({
      name: "comments",
      fields: JSON.stringify([{ name: "post", type: "relation", collection: "posts" }]),
    });
    await getDb().insert(hooks).values({ id: "h1", name: "h", collection_name: "posts", event: "beforeCreate", code: "" });
    const p = await createRecord("posts", { title: "p" });
    const c = await createRecord("comments", { post: p.id });

    await updateCollection(posts.id, { name: "articles" });

    const comments = await getCollection("comments");
    const rel = parseFields(comments!.fields).find((f) => f.name === "post");
    expect(rel?.collection).toBe("articles");
    const hook = (await getDb().select().from(hooks).where(eq(hooks.id, "h1")))[0]!;
    expect(hook.collection_name).toBe("articles");
    // The relation still expands through the renamed table.
    const listed = await listRecords("comments", { expand: "post" });
    const row = listed.data.find((x) => x.id === c.id) as { expand?: { post?: { id: string } } } | undefined;
    expect(row?.expand?.post?.id).toBe(p.id);
  });

  it("auth collection keeps its unique email index after rename", async () => {
    const users = await createCollection({ name: "members", type: "auth", fields: JSON.stringify([]) });
    await updateCollection(users.id, { name: "people" });
    await seedAuthUser({ collection: "people", email: "a@x.io" });
    await expect(seedAuthUser({ collection: "people", email: "a@x.io" })).rejects.toThrow();
  });

  it("refuses a name that is taken or not a valid identifier", async () => {
    const a = await createCollection({ name: "alpha", fields: JSON.stringify([]) });
    await createCollection({ name: "beta", fields: JSON.stringify([]) });
    await expect(updateCollection(a.id, { name: "beta" })).rejects.toThrow(/already exists/);
    await expect(updateCollection(a.id, { name: "bad name;" })).rejects.toThrow();
    expect(await getCollection("alpha")).not.toBeNull();
  });
});
