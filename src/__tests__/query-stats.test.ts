/**
 * List-query statistics and index suggestions (core/query-stats.ts), the
 * composite index API and the `/_/metrics/queries` endpoint.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import Elysia from "elysia";
import { initDb, closeDb, getDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { admin as adminTable } from "../db/schema.ts";
import { _resetCollectionCache, getCollection } from "../core/collections.ts";
import { listRecords } from "../core/records.ts";
import { queryStatsReport, resetQueryStats, analyzePlan, constrainedColumns, SUGGEST_MIN_ROWS, exportShapes, setExternalShapes } from "../core/query-stats.ts";
import { createCollectionIndex, makeIndexesPlugin, IndexError } from "../api/indexes.ts";
import { makeMetricsPlugin } from "../api/metrics.ts";
import { signAuthToken } from "../core/sec.ts";
import { onSqlite, createPublicCollection } from "./_helpers.ts";

const SECRET = "test-secret-query-stats";

async function seedPosts(rows: number, name = "posts") {
  await createPublicCollection({
    name,
    fields: JSON.stringify([
      { name: "title", type: "text", options: { searchable: true } },
      { name: "status", type: "select", options: { values: ["draft", "published"] } },
      { name: "views", type: "number" },
    ]),
  });
  const c = getRawClient();
  const ins = c.prepare(`INSERT INTO "vb_${name}" ("id", "title", "status", "views", "created_at", "updated_at") VALUES (?, ?, ?, ?, ?, ?)`);
  c.exec("BEGIN");
  for (let i = 0; i < rows; i++) ins.run(crypto.randomUUID(), `post ${i}`, i % 3 ? "published" : "draft", (i * 7919) % 10_000, 1_700_000_000 + i, 1_700_000_000 + i);
  c.exec("COMMIT");
}

const report = () => queryStatsReport();
const shape = async (pred: (r: Awaited<ReturnType<typeof report>>[number]) => boolean) => {
  const r = (await report()).find(pred);
  if (!r) throw new Error("shape not recorded");
  return r;
};

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  resetQueryStats();
});

afterEach(async () => {
  resetQueryStats();
  _resetCollectionCache();
  await closeDb();
});

describe.skipIf(!onSqlite)("query stats", () => {
  it("records a shape per SQL with count, mean and max", async () => {
    await seedPosts(50);
    await listRecords("posts", { filter: 'status = "published"' });
    await listRecords("posts", { filter: 'status = "draft"' });
    await listRecords("posts", {});
    const rows = await report();
    expect(rows).toHaveLength(2);
    const filtered = await shape((r) => r.filter !== null);
    expect(filtered.count).toBe(2);
    expect(filtered.filter).toBe('status = "published"');
    expect(filtered.sort).toBeNull();
    expect(filtered.mean_us).toBeGreaterThan(0);
    expect(filtered.max_us).toBeGreaterThanOrEqual(filtered.mean_us);
    expect(filtered.total_us).toBeGreaterThanOrEqual(filtered.max_us);
    expect(filtered.rows).toBe(50);
  });

  it("suggests the equality columns then the sort column for a scanned filter + sort", async () => {
    await seedPosts(SUGGEST_MIN_ROWS + 200);
    await listRecords("posts", { filter: 'status = "published"', sort: "-views" });
    const r = await shape((r) => r.sort === "-views");
    expect(r.scan).toBe(true);
    expect(r.temp_sort).toBe(true);
    expect(r.suggestion).toEqual({ fields: ["status", "views"], name: "idx_posts_status_views" });
  });

  it("suggests the sort column alone for an unfiltered sort on an unindexed field", async () => {
    await seedPosts(SUGGEST_MIN_ROWS + 200);
    await listRecords("posts", { sort: "-views" });
    const r = await shape((r) => r.sort === "-views");
    expect(r.suggestion).toEqual({ fields: ["views"], name: "idx_posts_views" });
  });

  it("suggests (filter, created_at) when the default sort walks the created_at index past the filter", async () => {
    await seedPosts(SUGGEST_MIN_ROWS + 200);
    await listRecords("posts", { filter: 'status = "published"' });
    const r = await shape((r) => r.filter !== null);
    expect(r.plan.join(" | ")).toContain("idx_vb_posts_created_at");
    expect(r.suggestion).toEqual({ fields: ["status", "created_at"], name: "idx_posts_status_created_at" });
  });

  it("has nothing to suggest for the default list, a range sorted by itself, or a search", async () => {
    await seedPosts(SUGGEST_MIN_ROWS + 200);
    await createCollectionIndex((await getCollection("posts"))!, ["views"]);
    await listRecords("posts", {});
    await listRecords("posts", { filter: "views > 5000", sort: "-views" });
    await listRecords("posts", { search: "post" });
    for (const r of await report()) expect(r.suggestion).toBeNull();
    expect((await shape((r) => r.search)).search).toBe(true);
    // The default sort walks the created_at index: not a scan, not a temp sort.
    const dflt = await shape((r) => r.filter === null && !r.search);
    expect(dflt.scan).toBe(false);
    expect(dflt.temp_sort).toBe(false);
  });

  it("stays quiet on small tables and once the index exists", async () => {
    await seedPosts(SUGGEST_MIN_ROWS - 1);
    await listRecords("posts", { filter: 'status = "published"', sort: "-views" });
    expect((await shape((r) => r.sort === "-views")).suggestion).toBeNull();
  });

  it("re-explains after the suggested index is created", async () => {
    await seedPosts(SUGGEST_MIN_ROWS + 200);
    await listRecords("posts", { filter: 'status = "published"', sort: "-views" });
    const before = await shape((r) => r.sort === "-views");
    expect(before.suggestion).not.toBeNull();
    await createCollectionIndex((await getCollection("posts"))!, before.suggestion!.fields);
    const after = await shape((r) => r.sort === "-views");
    expect(after.scan).toBe(false);
    expect(after.temp_sort).toBe(false);
    expect(after.suggestion).toBeNull();
    expect(after.plan.join(" | ")).toContain("idx_posts_status_views");
  });

  it("keys deep pages separately and flags them", async () => {
    await seedPosts(SUGGEST_MIN_ROWS + 200);
    await listRecords("posts", { page: 1, perPage: 30 });
    await listRecords("posts", { page: 200, perPage: 30 });
    const deep = (await report()).filter((r) => r.deep);
    expect(deep).toHaveLength(1);
    expect(await report()).toHaveLength(2);
    // The outer query re-sorts only the page's rows; that isn't a temp sort worth flagging.
    expect(deep[0]!.temp_sort).toBe(false);
    expect(deep[0]!.scan).toBe(false);
    expect(deep[0]!.suggestion).toBeNull();
    expect(deep[0]!.plan.some((p) => p.startsWith("  "))).toBe(true);
  });

  it("merges shapes reported by read workers by SQL", async () => {
    await seedPosts(50);
    await listRecords("posts", {});
    await listRecords("posts", { filter: 'status = "draft"' });
    const mine = exportShapes();
    expect(mine).toHaveLength(2);
    // A worker that ran the plain list 5 more times and one shape of its own.
    const plain = mine.find((s) => s.filter === null)!;
    setExternalShapes("w0", [
      { ...plain, count: 5, total_us: plain.total_us * 5, max_us: plain.max_us + 1 },
      { ...plain, selectSql: plain.selectSql + " -- elsewhere", count: 1, total_us: 1 },
    ]);
    const rows = await report();
    expect(rows).toHaveLength(3);
    const merged = rows.find((r) => r.filter === null && !r.deep && r.count === 6)!;
    expect(merged.total_us).toBe(Math.round(plain.total_us * 6));
    expect(merged.max_us).toBe(Math.round(plain.max_us + 1));
    setExternalShapes("w0", null);
    expect(await report()).toHaveLength(2);
    setExternalShapes("w0", [plain]);
    resetQueryStats();
    expect(await report()).toHaveLength(0);
  });

  it("orders by total time and reset empties it", async () => {
    await seedPosts(50);
    await listRecords("posts", {});
    expect(await report()).toHaveLength(1);
    resetQueryStats();
    expect(await report()).toHaveLength(0);
  });
});

describe.skipIf(!onSqlite)("plan analysis", () => {
  it("tells scans from seeks and spots temp sorts", () => {
    expect(analyzePlan(["SCAN vb_posts", "USE TEMP B-TREE FOR ORDER BY"], "vb_posts")).toEqual({ fullScan: true, indexScan: false, temp_sort: true });
    expect(analyzePlan(["SCAN vb_posts USING INDEX idx_vb_posts_created_at"], "vb_posts")).toEqual({ fullScan: false, indexScan: true, temp_sort: false });
    expect(analyzePlan(["SEARCH vb_posts USING INDEX idx_posts_status_views (status=?)"], "vb_posts")).toEqual({ fullScan: false, indexScan: false, temp_sort: false });
    // Older SQLite wording, and another table's scan in a join.
    expect(analyzePlan(["SCAN TABLE vb_posts", "SCAN vb_authors"], "vb_posts").fullScan).toBe(true);
    expect(analyzePlan(["SCAN vb_authors"], "vb_posts").fullScan).toBe(false);
  });

  it("splits filtered columns into equality and range", () => {
    const where = `WHERE ("vb_posts"."status" = ? AND "vb_posts"."views" > ?) OR "vb_posts"."title" LIKE ? AND "vb_posts"."id" IN (?, ?) AND "vb_posts"."views" != ?`;
    expect(constrainedColumns(where, "vb_posts")).toEqual({ eq: ["status", "id"], range: ["views", "title"] });
    expect(constrainedColumns(`WHERE "vb_authors"."name" = ?`, "vb_posts")).toEqual({ eq: [], range: [] });
  });
});

describe.skipIf(!onSqlite)("composite indexes", () => {
  it("creates an index over several fields in order and lists it", async () => {
    await seedPosts(10);
    const col = (await getCollection("posts"))!;
    const made = await createCollectionIndex(col, ["status", "created_at"]);
    expect(made).toEqual({ name: "idx_posts_status_created_at", field: "status,created_at", fields: ["status", "created_at"], unique: false });
    const plan = getRawClient().prepare(`EXPLAIN QUERY PLAN SELECT * FROM "vb_posts" WHERE "status" = ? ORDER BY "created_at" DESC LIMIT 30`).all() as Array<{ detail: string }>;
    expect(plan.map((p) => p.detail).join(" | ")).toContain("idx_posts_status_created_at");
    expect(plan.map((p) => p.detail).join(" | ")).not.toContain("TEMP B-TREE");
  });

  it("rejects unknown, repeated and too many fields", async () => {
    await seedPosts(10);
    const col = (await getCollection("posts"))!;
    await expect(createCollectionIndex(col, [])).rejects.toThrow(IndexError);
    await expect(createCollectionIndex(col, ["status", "nope"])).rejects.toThrow("not found");
    await expect(createCollectionIndex(col, ["status", "status"])).rejects.toThrow("only once");
    await expect(createCollectionIndex(col, ["id", "title", "status", "views", "created_at"])).rejects.toThrow("at most 4");
    await expect(createCollectionIndex(col, ["Status"])).rejects.toThrow("[a-z0-9_]+");
  });

  it("the API takes `fields` and still takes the older `field`", async () => {
    await seedPosts(10);
    await getDb().insert(adminTable).values({ id: "a1", email: "a@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
    const app = new Elysia().group("/api/v1", (g) => g.use(makeIndexesPlugin(SECRET)));
    const { token } = await signAuthToken({ payload: { id: "a1", email: "a@test.local" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const post = (body: unknown) => app.handle(new Request("http://localhost/api/v1/admin/collections/posts/indexes", { method: "POST", headers, body: JSON.stringify(body) }));
    let res = await post({ fields: ["status", "views"] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { fields: string[] } }).data.fields).toEqual(["status", "views"]);
    res = await post({ field: "title" });
    expect(res.status).toBe(200);
    res = await post({ fields: ["status", "nope"] });
    expect(res.status).toBe(422);
    res = await post({});
    expect(res.status).toBe(422);
    const list = await app.handle(new Request("http://localhost/api/v1/admin/collections/posts/indexes", { headers }));
    const names = ((await list.json()) as { data: Array<{ name: string; fields: string[] }> }).data;
    expect(names.find((i) => i.name === "idx_posts_status_views")?.fields).toEqual(["status", "views"]);
    expect(names.find((i) => i.name === "idx_posts_title")?.fields).toEqual(["title"]);
  });
});

describe.skipIf(!onSqlite)("GET /_/metrics/queries", () => {
  it("returns the report to admins only", async () => {
    await seedPosts(10);
    await listRecords("posts", {});
    await getDb().insert(adminTable).values({ id: "a1", email: "a@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
    const app = new Elysia().group("/api/v1", (g) => g.use(makeMetricsPlugin(SECRET)));
    const { token } = await signAuthToken({ payload: { id: "a1", email: "a@test.local" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET });
    const anon = await app.handle(new Request("http://localhost/api/v1/_/metrics/queries"));
    expect(anon.status).toBe(401);
    const res = await app.handle(new Request("http://localhost/api/v1/_/metrics/queries", { headers: { authorization: `Bearer ${token}` } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ collection: string; plan: string[]; id: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.collection).toBe("posts");
    expect(body.data[0]!.plan.length).toBeGreaterThan(0);
    const reset = await app.handle(new Request("http://localhost/api/v1/_/metrics/reset", { method: "POST", headers: { authorization: `Bearer ${token}` } }));
    expect(reset.status).toBe(200);
    const after = await app.handle(new Request("http://localhost/api/v1/_/metrics/queries", { headers: { authorization: `Bearer ${token}` } }));
    expect(((await after.json()) as { data: unknown[] }).data).toHaveLength(0);
  });
});
