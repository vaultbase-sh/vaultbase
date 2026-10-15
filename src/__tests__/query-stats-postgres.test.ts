/**
 * Index suggestions on Postgres: plans come from EXPLAIN (GENERIC_PLAN,
 * FORMAT JSON) and are read for the same three signals as SQLite's.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, initDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache, getCollection } from "../core/collections.ts";
import { listRecords } from "../core/records.ts";
import { analyzePgPlan, pgPlanRows, queryStatsReport, resetQueryStats, SUGGEST_MIN_ROWS } from "../core/query-stats.ts";
import { createCollectionIndex } from "../api/indexes.ts";
import { createPublicCollection, onSqlite } from "./_helpers.ts";

describe("Postgres plan reading", () => {
  it("reads a sequential scan, an ordered index walk and a full sort", () => {
    const rows = pgPlanRows({ "Node Type": "Limit", Plans: [{ "Node Type": "Sort", "Sort Key": ["views DESC"], Plans: [{ "Node Type": "Seq Scan", "Relation Name": "vb_posts" }] }] });
    expect(rows.map((r) => r.detail)).toEqual(["Limit", "Sort (views DESC)", "Seq Scan on vb_posts"]);
    expect(analyzePgPlan(rows.map((r) => r.detail), "vb_posts", false)).toEqual({ fullScan: true, indexScan: false, temp_sort: true });
    const walk = pgPlanRows({ "Node Type": "Index Scan", "Index Name": "i", "Relation Name": "vb_posts" });
    expect(analyzePgPlan(walk.map((r) => r.detail), "vb_posts", false)).toEqual({ fullScan: false, indexScan: true, temp_sort: false });
    const seek = pgPlanRows({ "Node Type": "Index Scan", "Index Name": "i", "Relation Name": "vb_posts", "Index Cond": "(status = $1)" });
    expect(analyzePgPlan(seek.map((r) => r.detail), "vb_posts", false).indexScan).toBe(false);
  });
});

describe.skipIf(onSqlite)("query stats on Postgres", () => {
  beforeEach(async () => { await initDb(":memory:"); await runMigrations(); resetQueryStats(); });
  afterEach(async () => { _resetCollectionCache(); await closeDb(); });

  it("suggests the equality columns then the sort column, and stops once the index exists", async () => {
    await createPublicCollection({ name: "posts", fields: JSON.stringify([
      { name: "title", type: "text" }, { name: "status", type: "text" }, { name: "views", type: "number" },
    ]) });
    await db.exec(`INSERT INTO "vb_posts" ("id", "title", "status", "views", "created_at", "updated_at")
      SELECT 'p' || g, 'post ' || g, CASE WHEN g % 3 = 0 THEN 'draft' ELSE 'published' END, (g * 7919) % 10000, 1700000000 + g, 1700000000 + g
        FROM generate_series(1, ${SUGGEST_MIN_ROWS + 200}) AS g`);
    await db.exec(`ANALYZE "vb_posts"`);
    await listRecords("posts", { filter: 'status = "published"', sort: "-views" });
    const before = (await queryStatsReport()).find((r) => r.sort === "-views")!;
    expect(before.scan).toBe(true);
    expect(before.plan.some((l) => l.includes("Seq Scan on vb_posts"))).toBe(true);
    expect(before.suggestion?.fields).toEqual(["status", "views"]);
    await createCollectionIndex((await getCollection("posts"))!, before.suggestion!.fields);
    await listRecords("posts", { filter: 'status = "published"', sort: "-views" });
    const after = (await queryStatsReport()).find((r) => r.sort === "-views")!;
    expect(after.suggestion).toBeNull();
  });
});
