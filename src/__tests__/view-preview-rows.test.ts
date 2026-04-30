import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, previewViewRows } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

async function seedPosts(): Promise<void> {
  await createCollection({
    name: "posts",
    type: "base",
    fields: JSON.stringify([
      { name: "title",  type: "text",   required: false },
      { name: "score",  type: "number", required: false },
      { name: "active", type: "bool",   required: false },
    ]),
  });
  for (let i = 1; i <= 7; i++) {
    await createRecord("posts", { title: `post-${i}`, score: i * 10, active: i % 2 === 0 }, null);
  }
}

describe("previewViewRows", () => {
  it("returns up to N rows from a SELECT", async () => {
    await seedPosts();
    const r = previewViewRows(`SELECT title, score FROM vb_posts ORDER BY score`, 5);
    expect(r.rows).toHaveLength(5);
    expect(r.columns).toEqual(["title", "score"]);
    expect(r.rows[0]).toEqual({ title: "post-1", score: 10 });
  });

  it("default limit = 5", async () => {
    await seedPosts();
    const r = previewViewRows(`SELECT title FROM vb_posts`);
    expect(r.rows).toHaveLength(5);
  });

  it("clamps limit to [1, 100]", async () => {
    await seedPosts();
    const r0 = previewViewRows(`SELECT title FROM vb_posts`, 0);
    expect(r0.rows.length).toBeGreaterThanOrEqual(1);
    const rBig = previewViewRows(`SELECT title FROM vb_posts`, 1_000_000);
    expect(rBig.rows.length).toBeLessThanOrEqual(100);
  });

  it("returns empty rows when the SELECT matches nothing", async () => {
    await seedPosts();
    const r = previewViewRows(`SELECT title FROM vb_posts WHERE score > 9999`);
    expect(r.rows).toHaveLength(0);
    expect(r.columns).toEqual(["title"]);
  });

  it("rejects DML / DDL", async () => {
    await seedPosts();
    expect(() => previewViewRows(`DELETE FROM vb_posts`)).toThrow();
    expect(() => previewViewRows(`UPDATE vb_posts SET title = 'x'`)).toThrow();
    expect(() => previewViewRows(`SELECT 1; DROP TABLE vb_posts`)).toThrow();
  });
});
