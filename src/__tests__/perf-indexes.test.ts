import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, updateCollection, _resetCollectionCache } from "../core/collections.ts";

// The default list sort (-created_at) did a full scan + temp B-tree on every
// page because user tables had no created_at index, and every file /
// thumbnail request scanned vaultbase_files because it had no indexes.

function plan(sql: string, ...params: unknown[]): string {
  const rows = getRawClient().prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join(" | ");
}

function indexNames(table: string): string[] {
  return (getRawClient()
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name`)
    .all(table) as Array<{ name: string }>).map((r) => r.name);
}

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
});

afterEach(async () => {
  _resetCollectionCache();
  await closeDb();
});

describe("record table indexes", () => {
  it("the default sort on created_at uses an index", async () => {
    await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    const p = plan(`SELECT * FROM "vb_posts" ORDER BY "created_at" DESC LIMIT 30`);
    expect(p).not.toContain("TEMP B-TREE");
    expect(p).toContain("idx_vb_posts_created_at");
  });

  it("startup migration adds the indexes to collections created before them", async () => {
    await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    getRawClient().exec(`DROP INDEX "idx_vb_posts_created_at"; DROP INDEX "idx_vb_posts_updated_at";`);
    await runMigrations();
    expect(indexNames("vb_posts")).toEqual(["idx_vb_posts_created_at", "idx_vb_posts_updated_at"]);
  });

  it("a rename carries the indexes over instead of duplicating them", async () => {
    const c = await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    await updateCollection(c.id, { name: "articles" });
    await runMigrations();
    expect(indexNames("vb_articles")).toEqual(["idx_vb_articles_created_at", "idx_vb_articles_updated_at"]);
  });
});

describe("vaultbase_files indexes", () => {
  it("lookup by filename uses an index", () => {
    expect(plan(`SELECT * FROM vaultbase_files WHERE filename = ?`, "x.png")).toContain("USING INDEX");
  });

  it("lookup by record + field uses an index", () => {
    const p = plan(
      `SELECT * FROM vaultbase_files WHERE collection_id = ? AND record_id = ? AND field_name = ?`,
      "c", "r", "f",
    );
    expect(p).toContain("USING INDEX");
  });
});
