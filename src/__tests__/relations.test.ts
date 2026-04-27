import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, type FieldDef } from "../core/collections.ts";
import {
  createRecord,
  deleteRecord,
  getRecord,
  RestrictError,
} from "../core/records.ts";
import { ValidationError, validateRecord } from "../core/validate.ts";
import type { Collection } from "../db/schema.ts";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

function srcCol(targetName: string, cascade?: "setNull" | "cascade" | "restrict"): Collection {
  const fields: FieldDef[] = [
    { name: "title",  type: "text", required: false },
    { name: "author", type: "relation", collection: targetName, options: cascade ? { cascade } : {} },
  ];
  return {
    id: "src", name: "posts", type: "base",
    fields: JSON.stringify(fields),
    view_query: null,
    list_rule: null, view_rule: null, create_rule: null, update_rule: null, delete_rule: null,
    created_at: 0, updated_at: 0,
  };
}

describe("relation existence check", () => {
  it("rejects a relation pointing at a non-existent record", async () => {
    await createCollection({ name: "users", fields: JSON.stringify([{ name: "email", type: "text" }]) });
    const src = srcCol("users");
    await expect(validateRecord(src, { author: "ghost-id" }, "create")).rejects.toThrow(ValidationError);
  });

  it("accepts a relation pointing at an existing record", async () => {
    const target = await createCollection({ name: "users", fields: JSON.stringify([{ name: "email", type: "text" }]) });
    const u = await createRecord(target.name, { email: "a@x.com" });
    const src = srcCol("users");
    await expect(validateRecord(src, { author: u.id }, "create")).resolves.toBeUndefined();
  });

  it("rejects when target collection itself doesn't exist", async () => {
    const src = srcCol("missing_collection");
    await expect(validateRecord(src, { author: "any-id" }, "create")).rejects.toThrow(ValidationError);
  });

  it("allows null/empty relation values (clears the FK)", async () => {
    await createCollection({ name: "users", fields: JSON.stringify([{ name: "email", type: "text" }]) });
    const src = srcCol("users");
    await expect(validateRecord(src, { author: "" }, "create")).resolves.toBeUndefined();
    await expect(validateRecord(src, { author: null }, "create")).resolves.toBeUndefined();
  });
});

describe("cascade on delete", () => {
  async function setupTwoCollections(cascade: "setNull" | "cascade" | "restrict") {
    await createCollection({ name: "users", fields: JSON.stringify([{ name: "email", type: "text" }]) });
    await createCollection({
      name: "posts",
      fields: JSON.stringify([
        { name: "title", type: "text" },
        { name: "author", type: "relation", collection: "users", options: { cascade } },
      ]),
    });
    const u = await createRecord("users", { email: "alice@x.com" });
    const p = await createRecord("posts", { title: "hello", author: u.id });
    return { user: u, post: p };
  }

  it("setNull: clears the foreign key on referencing records", async () => {
    const { user, post } = await setupTwoCollections("setNull");
    await deleteRecord("users", user.id);
    const after = await getRecord("posts", post.id);
    expect(after).not.toBeNull();
    expect(after!["author"]).toBeNull();
  });

  it("cascade: deletes referencing records too", async () => {
    const { user, post } = await setupTwoCollections("cascade");
    await deleteRecord("users", user.id);
    const after = await getRecord("posts", post.id);
    expect(after).toBeNull();
  });

  it("restrict: refuses delete and leaves data intact", async () => {
    const { user, post } = await setupTwoCollections("restrict");
    await expect(deleteRecord("users", user.id)).rejects.toThrow(RestrictError);
    expect(await getRecord("users", user.id)).not.toBeNull();
    expect(await getRecord("posts", post.id)).not.toBeNull();
  });

  it("cascade default is setNull when option is unset", async () => {
    await createCollection({ name: "users", fields: JSON.stringify([{ name: "email", type: "text" }]) });
    await createCollection({
      name: "posts",
      fields: JSON.stringify([
        { name: "title", type: "text" },
        { name: "author", type: "relation", collection: "users" }, // no cascade
      ]),
    });
    const u = await createRecord("users", { email: "a@x.com" });
    const p = await createRecord("posts", { title: "hi", author: u.id });
    await deleteRecord("users", u.id);
    const after = await getRecord("posts", p.id);
    expect(after).not.toBeNull();
    expect(after!["author"]).toBeNull();
  });

  it("restrict allows delete once dangling refs are gone", async () => {
    const { user, post } = await setupTwoCollections("restrict");
    await deleteRecord("posts", post.id);
    await expect(deleteRecord("users", user.id)).resolves.toBeUndefined();
    expect(await getRecord("users", user.id)).toBeNull();
  });

  it("cascade chain handles A → B → C", async () => {
    await createCollection({ name: "users", fields: JSON.stringify([{ name: "email", type: "text" }]) });
    await createCollection({
      name: "posts",
      fields: JSON.stringify([
        { name: "title", type: "text" },
        { name: "author", type: "relation", collection: "users", options: { cascade: "cascade" } },
      ]),
    });
    await createCollection({
      name: "comments",
      fields: JSON.stringify([
        { name: "body", type: "text" },
        { name: "post", type: "relation", collection: "posts", options: { cascade: "cascade" } },
      ]),
    });
    const u = await createRecord("users", { email: "a@x.com" });
    const p = await createRecord("posts", { title: "t", author: u.id });
    const c = await createRecord("comments", { body: "nice", post: p.id });
    await deleteRecord("users", u.id);
    expect(await getRecord("comments", c.id)).toBeNull();
    expect(await getRecord("posts", p.id)).toBeNull();
    expect(await getRecord("users", u.id)).toBeNull();
  });
});
