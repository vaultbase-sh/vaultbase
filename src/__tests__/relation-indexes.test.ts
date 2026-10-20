/**
 * Relation fields had no index, so finding records from the other side of a
 * relation (`post = "<id>"`, a post's comments) scanned the whole table: 56 ms
 * on 265k comments in the load test, against ~2 ms for an indexed read.
 * Also: dropping a field that an admin had indexed failed (SQLite refuses to
 * drop an indexed column), and renaming a collection left its admin-made
 * indexes under the old name.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, updateCollection, getCollection, _resetCollectionCache } from "../core/collections.ts";
import { createCollectionIndex } from "../api/indexes.ts";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  _resetCollectionCache();
});
afterEach(() => closeDb());

const indexes = async (table: string) =>
  (await db.all<{ name: string }>(db.dialect.listIndexesSql(), [table])).map((r) => r.name).sort();

async function postsAndComments() {
  await createCollection({ name: "posts", type: "base", fields: JSON.stringify([{ name: "title", type: "text" }]) });
  return createCollection({
    name: "comments", type: "base",
    fields: JSON.stringify([{ name: "body", type: "text" }, { name: "post", type: "relation", collection: "posts" }]),
  });
}

describe("relation indexes", () => {
  it("a relation field gets an index, and a filter on it uses the index", async () => {
    await postsAndComments();
    expect(await indexes("vb_comments")).toContain("idx_vb_comments_post");
    if (db.dialect.name === "sqlite") {
      const plan = await db.all<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT * FROM vb_comments WHERE post = 'x'`);
      expect(plan.map((p) => p.detail).join(" ")).toContain("idx_vb_comments_post");
    }
  });

  it("a relation field added later gets one too", async () => {
    const c = await postsAndComments();
    const fields = [...JSON.parse(c.fields), { name: "reply_to", type: "relation", collection: "comments" }];
    await updateCollection(c.id, { fields: JSON.stringify(fields) });
    expect(await indexes("vb_comments")).toContain("idx_vb_comments_reply_to");
  });

  it("dropping an indexed field works: a relation, or one indexed in the admin", async () => {
    const c = await postsAndComments();
    await createCollectionIndex((await getCollection("comments"))!, ["body"]);
    const keep = JSON.parse(c.fields).filter((f: { name: string }) => f.name !== "post" && f.name !== "body");
    await updateCollection(c.id, { fields: JSON.stringify([...keep, { name: "note", type: "text" }]) });
    const left = await indexes("vb_comments");
    expect(left.some((n) => n.includes("post") || n.includes("body"))).toBe(false);
  });

  it("renaming a collection renames its indexes, admin-made ones included", async () => {
    const c = await postsAndComments();
    await createCollectionIndex((await getCollection("comments"))!, ["body"]);
    await updateCollection(c.id, { name: "notes" });
    const names = await indexes("vb_notes");
    expect(names).toContain("idx_vb_notes_post");
    expect(names).toContain("idx_notes_body");
    expect(names.some((n) => n.includes("comments"))).toBe(false);
  });

  it("existing installs are backfilled once; an index dropped afterwards stays dropped", async () => {
    await postsAndComments();
    await db.exec(`DROP INDEX "idx_vb_comments_post"`);
    await db.run(`DELETE FROM vaultbase_migrations WHERE key = ?`, ["v0_26_5_relation_indexes"]);
    await runMigrations();
    expect(await indexes("vb_comments")).toContain("idx_vb_comments_post");
    await db.exec(`DROP INDEX "idx_vb_comments_post"`);
    await runMigrations();
    expect(await indexes("vb_comments")).not.toContain("idx_vb_comments_post");
  });
});
