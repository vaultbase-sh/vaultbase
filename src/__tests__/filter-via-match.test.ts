/**
 * `_via_` with a `?` operator (some back-related row matches) or `:each`
 * (there are some, and every one matches). The `?` operators were refused,
 * and `:each` matched nothing on SQLite and failed on Postgres.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache, createCollection } from "../core/collections.ts";
import { listRecords, createRecord } from "../core/records.ts";
import { createPublicCollection } from "./_helpers.ts";

const ADMIN = { id: "a", type: "admin" as const };

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  await createPublicCollection({ name: "authors", fields: JSON.stringify([{ name: "name", type: "text" }]) });
  await createPublicCollection({
    name: "posts",
    fields: JSON.stringify([
      { name: "title", type: "text" },
      { name: "n", type: "number" },
      { name: "author", type: "relation", collection: "authors" },
    ]),
  });
  const two = await createRecord("authors", { name: "two" });
  const one = await createRecord("authors", { name: "one" });
  await createRecord("authors", { name: "none" });
  await createRecord("posts", { title: "u1", n: 1, author: two.id });
  await createRecord("posts", { title: "u12", n: 12, author: two.id });
  await createRecord("posts", { title: "u12", n: 12, author: one.id });
});

afterEach(async () => {
  _resetCollectionCache();
  await closeDb();
});

const names = async (filter: string, auth: { id: string; type: "admin" | "user" } | null = ADMIN) =>
  (await listRecords("authors", { filter, auth })).data.map((r) => r["name"]).sort();

describe("_via_ with ? operators", () => {
  it("match when some back-related row does, comparing values exactly", async () => {
    expect(await names(`posts_via_author.title ?= "u1"`)).toEqual(["two"]); // not u12's author
    expect(await names(`"u1" ?= posts_via_author.title`)).toEqual(["two"]);
    expect(await names(`posts_via_author.title ?!= "u1"`)).toEqual(["one", "two"]);
    expect(await names(`posts_via_author.title ?~ "u1"`)).toEqual(["one", "two"]);
    expect(await names(`posts_via_author.title ?!~ "2"`)).toEqual(["two"]);
    expect(await names(`posts_via_author.n ?> 5`)).toEqual(["one", "two"]);
    expect(await names(`posts_via_author.n ?< 5`)).toEqual(["two"]);
    expect(await names(`posts_via_author.n ?>= 12.5`)).toEqual([]);
    expect(await names(`posts_via_author.title ?= "nope"`)).toEqual([]);
  });

  it("still apply the target's rules", async () => {
    // A list rule of "" (admins only) and a view rule with a value: the
    // guard left the view rule's value in the statement when the list rule
    // denied, and the query failed on the count of its parameters.
    await createCollection({
      name: "notes",
      fields: JSON.stringify([{ name: "body", type: "text" }, { name: "author", type: "relation", collection: "authors" }]),
      list_rule: "", view_rule: `body != "secret"`,
    });
    const two = (await listRecords("authors", { auth: ADMIN })).data.find((r) => r["name"] === "two")!;
    await createRecord("notes", { body: "secret", author: two.id });
    await createRecord("notes", { body: "hello", author: two.id });
    const user = { id: "u", type: "user" as const };
    expect(await names(`notes_via_author.body ?= "hello"`, user)).toEqual([]);
    expect(await names(`notes_via_author.body ?= "hello"`)).toEqual(["two"]);
    expect(await names(`notes_via_author.body ?= "secret"`)).toEqual([]);
    expect(await names(`notes_via_author.body:each = "hello"`)).toEqual(["two"]);
    expect(await names(`notes_via_author:length > 0`, user)).toEqual([]);
    expect(await names(`@collection.notes.body = "hello"`, user)).toEqual([]);
  });
});

describe("_via_ with :each", () => {
  it("matches when there are back-related rows and every one matches", async () => {
    expect(await names(`posts_via_author.title:each = "u12"`)).toEqual(["one"]); // none has no posts
    expect(await names(`posts_via_author.n:each > 5`)).toEqual(["one"]);
    expect(await names(`posts_via_author.n:each > 0`)).toEqual(["one", "two"]);
    expect(await names(`posts_via_author.title:each ~ "u"`)).toEqual(["one", "two"]);
  });
});

describe("_via_ comparisons refused", () => {
  it("with a modifier, or an order or a match with the back-relation on the right", async () => {
    await expect(names(`posts_via_author:length ?> 1`)).rejects.toThrow(/:length/);
    await expect(names(`5 ?> posts_via_author.n`)).rejects.toThrow(/on the left/);
    await expect(names(`"x" ?~ posts_via_author.title`)).rejects.toThrow(/on the left/);
  });
});
