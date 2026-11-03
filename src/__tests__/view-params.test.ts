/**
 * Parameters on view collections (core/view-params.ts): `:name` in the
 * query, `?params[name]=…` on reads, bound behind a cast, never written into
 * the SQL; the database view keeps the defaults for everything else.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { admin } from "../db/schema.ts";
import { createCollection, getCollection, updateCollection, CollectionValidationError } from "../core/collections.ts";
import { createRecord, getRecord, listRecords } from "../core/records.ts";
import { signAuthToken } from "../core/sec.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { makeCollectionsPlugin } from "../api/collections.ts";
import { makeBatchPlugin } from "../api/batch.ts";
import { buildOpenApi } from "../core/openapi.ts";
import { listCollections } from "../core/collections.ts";
import { rewriteSqlParams } from "../core/sql-scan.ts";
import {
  ViewParamError, coerceViewParam, resolveViewParams, validateViewParams, viewParamsFromUrl, type ViewParam,
} from "../core/view-params.ts";
import { applySnapshot, type CollectionSnapshot } from "../core/migrations.ts";
import { onSqlite, seedAuthUser, signUserJwt } from "./_helpers.ts";

const SECRET = "test-secret-view-params";
let tmpDir: string;
let adminToken: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-view-params-"));
  setLogsDir(tmpDir);
  await initDb(":memory:");
  await runMigrations();
  await getDb().insert(admin).values({ id: "a1", email: "a@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
  adminToken = (await signAuthToken({ payload: { id: "a1", email: "a@test.local" }, audience: "admin", expiresInSeconds: 600, jwtSecret: SECRET })).token;
});

afterEach(async () => {
  await closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

const DAY = 86_400;
const T0 = Date.UTC(2026, 0, 1) / 1000;

async function seedOrders(): Promise<void> {
  await createCollection({
    name: "orders", type: "base",
    fields: JSON.stringify([{ name: "owner", type: "text" }, { name: "status", type: "text" }, { name: "amount", type: "number" }, { name: "note", type: "text" }]),
    list_rule: null, view_rule: null, create_rule: null, update_rule: null, delete_rule: null,
  });
  const rows: Array<[string, string, number, number]> = [
    ["u1", "paid", 10, T0 + 1 * DAY],
    ["u1", "paid", 20, T0 + 40 * DAY],
    ["u2", "paid", 5, T0 + 41 * DAY],
    ["u2", "open", 7, T0 + 42 * DAY],
    ["u3", "void", 100, T0 + 2 * DAY],
  ];
  for (const [owner, status, amount, at] of rows) {
    const r = await createRecord("orders", { owner, status, amount });
    await db.run(`UPDATE vb_orders SET created_at = ? WHERE id = ?`, [at, String(r.id)]);
  }
}

const REVENUE = `SELECT owner AS id, COUNT(*) AS orders, SUM(amount) AS total
FROM vb_orders WHERE created_at >= :since AND status = :status GROUP BY owner`;
const REVENUE_PARAMS: ViewParam[] = [
  { name: "since", type: "date", default: "2026-01-01" as unknown as number },
  { name: "status", type: "text", default: "paid" },
];

async function revenueView(listRule: string | null = null): Promise<void> {
  await createCollection({
    name: "revenue", type: "view", view_query: REVENUE, view_params: JSON.stringify(REVENUE_PARAMS),
    list_rule: listRule, view_rule: null,
  });
}

async function get(path: string, token?: string) {
  const res = await makeRecordsPlugin(SECRET).handle(new Request(`http://localhost${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }));
  return { status: res.status, body: await res.json() as Record<string, unknown> & { data: Array<Record<string, unknown>>; error?: string; totalItems?: number } };
}

const ids = (rows: Array<Record<string, unknown>>) => rows.map((r) => r["id"]).sort();

describe("finding parameters in a query", () => {
  const names = (sql: string, pg = false) => rewriteSqlParams(sql, () => "?", { pg, bound: false }).names;

  it("finds :name, and not inside strings, quoted names, comments or casts", () => {
    expect(names("SELECT * FROM t WHERE a = :a AND b > :b_2 OR c = :a")).toEqual(["a", "b_2", "a"]);
    expect(names(`SELECT ':x', "y:z", a::text, b FROM t -- :c\n WHERE d = 1 /* :e */`)).toEqual([]);
    expect(names("SELECT '12:30' AS t, x FROM t WHERE y = :y")).toEqual(["y"]);
  });

  it("reads Postgres's E'' and dollar-quoted strings", () => {
    expect(names(String.raw`SELECT E'it\'s :x' AS a, $$ :y $$ AS b, $q$ :z $q$ AS c WHERE d = :d`, true)).toEqual(["d"]);
  });

  it("doubles jsonb's ? only for a bound Postgres query", () => {
    const sql = `SELECT * FROM t WHERE data ? 'k' AND data ?| array['a'] AND data ?? 'j' AND n = :n`;
    expect(rewriteSqlParams(sql, () => "$", { pg: true, bound: true }).sql)
      .toBe(`SELECT * FROM t WHERE data ?? 'k' AND data ?| array['a'] AND data ?? 'j' AND n = $`);
    expect(rewriteSqlParams(sql, () => "$", { pg: true, bound: false }).sql).toContain("data ? 'k'");
    expect(rewriteSqlParams(sql, () => "$", { pg: false, bound: true }).sql).toContain("data ? 'k'");
  });
});

describe("declaring parameters", () => {
  const q = "SELECT * FROM vb_x WHERE a = :a";

  it("tidies a valid list", () => {
    expect(validateViewParams(q, [{ name: "a", type: "date", default: "2026-01-02T00:00:00Z" }]))
      .toEqual([{ name: "a", type: "date", default: Date.UTC(2026, 0, 2) / 1000 }]);
    expect(validateViewParams(q, JSON.stringify([{ name: "a", type: "text", from: "auth.id" }]))).toEqual([{ name: "a", type: "text", from: "auth.id" }]);
  });

  it("refuses what doesn't fit", () => {
    const bad = (params: unknown, query = q) => { try { validateViewParams(query, params); return null; } catch (e) { return (e as Error).message; } };
    expect(bad([])).toContain("uses :a, which isn't declared");
    expect(bad([{ name: "a", type: "text" }, { name: "b", type: "text" }])).toContain("'b' is declared but the query doesn't use :b");
    expect(bad([{ name: "a", type: "text" }, { name: "a", type: "text" }])).toContain("declared twice");
    expect(bad([{ name: "A", type: "text" }])).toContain("isn't a parameter name");
    expect(bad([{ name: "a", type: "uuid" }])).toContain("type must be one of");
    expect(bad([{ name: "a", type: "number", default: "lots" }])).toContain("the default must be a number");
    expect(bad([{ name: "a", type: "text", required: true, default: "x" }])).toContain("required parameter has no default");
    expect(bad([{ name: "a", type: "number", from: "auth.id" }])).toContain("from auth.id is text");
    expect(bad([{ name: "a", type: "text", from: "auth.email" }])).toContain(`from can only be "auth.id"`);
    expect(bad([{ name: "a", type: "text", from: "auth.id", required: true }])).toContain("can't be required");
    const many = Array.from({ length: 21 }, (_, i) => ({ name: `p${i}`, type: "text" }));
    expect(bad(many, `SELECT ${many.map((p) => `:${p.name}`).join(", ")}`)).toContain("at most 20");
  });

  it("a parameter named like a keyword isn't read as one", async () => {
    await seedOrders();
    await createCollection({
      name: "by_update", type: "view",
      view_query: "SELECT id, amount FROM vb_orders WHERE amount > :update",
      view_params: JSON.stringify([{ name: "update", type: "number", default: 0 }]),
      list_rule: null, view_rule: null,
    });
    expect((await listRecords("by_update", { viewParams: { update: "15" } })).totalItems).toBe(2);
  });
});

describe("converting values", () => {
  it("binds each type as stored", () => {
    expect(coerceViewParam("number", "7.5")).toBe(7.5);
    expect(coerceViewParam("bool", "true")).toBe(1);
    expect(coerceViewParam("bool", "0")).toBe(0);
    expect(coerceViewParam("date", "2026-01-01")).toBe(T0);
    expect(coerceViewParam("date", "1767225600")).toBe(1767225600);
    expect(() => coerceViewParam("number", "")).toThrow();
    expect(() => coerceViewParam("bool", "yes")).toThrow();
    expect(() => coerceViewParam("date", "soon")).toThrow();
    expect(() => coerceViewParam("text", "x".repeat(1001))).toThrow();
  });

  it("resolves a read's values", () => {
    const params: ViewParam[] = [
      { name: "a", type: "number", default: 3 },
      { name: "b", type: "text", required: true },
      { name: "me", type: "text", from: "auth.id" },
    ];
    expect([...resolveViewParams(params, { b: "x" }, "u1")]).toEqual([["b", "x"], ["a", 3], ["me", "u1"]]);
    expect(resolveViewParams(params, { b: "x" }, null).get("me")).toBeNull();
    const err = (given: Record<string, unknown>) => { try { resolveViewParams(params, given, "u1"); return null; } catch (e) { return e; } };
    expect(err({})).toBeInstanceOf(ViewParamError);
    expect((err({}) as Error).message).toBe("parameter 'b' is required");
    expect((err({ b: "x", zz: "1" }) as Error).message).toBe("unknown parameter 'zz'");
    expect((err({ b: "x", me: "u2" }) as Error).message).toContain("can't be set");
    expect((err({ b: "x", a: "many" }) as Error).message).toBe("parameter 'a' must be a number");
  });

  it("reads params[name] from a query string", () => {
    expect(viewParamsFromUrl(new URLSearchParams("filter=x&params[a]=1&params[b]=two&params[a]=3"))).toEqual({ a: "3", b: "two" });
    expect(viewParamsFromUrl(new URLSearchParams("filter=x"))).toBeNull();
  });
});

describe("reading a view with parameters", () => {
  it("lists for the values given, and for the defaults without them", async () => {
    await seedOrders();
    await revenueView();
    let r = await get("/revenue");
    expect(r.status).toBe(200);
    expect(ids(r.body.data)).toEqual(["u1", "u2"]);
    expect(r.body.totalItems).toBe(2);
    r = await get(`/revenue?params[since]=2026-02-01&sort=-total`);
    expect(r.body.data).toEqual([
      expect.objectContaining({ id: "u1", orders: 1, total: 20 }),
      expect.objectContaining({ id: "u2", orders: 1, total: 5 }),
    ]);
    r = await get(`/revenue?params[status]=void`);
    expect(r.body.data).toEqual([expect.objectContaining({ id: "u3", total: 100 })]);
    r = await get(`/revenue?params[since]=2026-02-01&filter=${encodeURIComponent("total > 6")}`);
    expect(ids(r.body.data)).toEqual(["u1"]);
    expect(r.body.totalItems).toBe(1);
  });

  it("refuses unknown, mistyped and missing values with 400", async () => {
    await seedOrders();
    await revenueView();
    expect(await get("/revenue?params[nope]=1")).toMatchObject({ status: 400, body: { error: "unknown parameter 'nope'" } });
    expect(await get("/revenue?params[since]=soon")).toMatchObject({ status: 400, body: { error: "parameter 'since' must be a date (ISO 8601) or Unix seconds" } });
    expect((await get("/orders?params[a]=1")).body.error).toBe("'orders' takes no parameters");
    await updateCollection("revenue", { view_params: JSON.stringify([REVENUE_PARAMS[0], { name: "status", type: "text", required: true }]) });
    expect(await get("/revenue")).toMatchObject({ status: 400, body: { error: "parameter 'status' is required" } });
    expect((await get("/revenue?params[status]=paid")).status).toBe(200);
  });

  it("get-one and aggregates take them too", async () => {
    await seedOrders();
    await revenueView();
    expect((await get("/revenue/u1")).body.data).toMatchObject({ id: "u1", total: 30 });
    expect((await get("/revenue/u1?params[since]=2026-02-01")).body.data).toMatchObject({ id: "u1", total: 20 });
    expect((await get("/revenue/u3")).status).toBe(404);
    expect((await get("/revenue/u3?params[status]=void")).status).toBe(200);
    const agg = await get("/revenue/_aggregate?agg=sum(total)&params[since]=2026-02-01", adminToken);
    expect(agg.status).toBe(200);
    expect(agg.body.data).toEqual([{ sum_total: 25 }]);
  });

  it("a rule can read a parameter", async () => {
    await seedOrders();
    await revenueView(`@request.query.params.status != "void"`);
    expect((await get("/revenue?params[status]=paid")).body.data.length).toBe(2);
    expect((await get("/revenue?params[status]=void")).body.data).toEqual([]);
  });

  it("binds values, so text can't change the query", async () => {
    await seedOrders();
    await revenueView();
    const evil = encodeURIComponent("paid' OR '1'='1");
    expect((await get(`/revenue?params[status]=${evil}`)).body.data).toEqual([]);
    const drop = encodeURIComponent("x'); DROP TABLE vb_orders; --");
    expect((await get(`/revenue?params[status]=${drop}`)).status).toBe(200);
    expect((await listRecords("orders")).totalItems).toBe(5);
  });

  it("a default with a quote is written into the database view safely", async () => {
    await seedOrders();
    await createRecord("orders", { owner: "o'brien", status: "paid", amount: 1, note: "O'Brien" });
    await createCollection({
      name: "by_note", type: "view", view_query: "SELECT id, owner FROM vb_orders WHERE note = :note",
      view_params: JSON.stringify([{ name: "note", type: "text", default: "O'Brien" }]),
      list_rule: null, view_rule: null,
    });
    const rows = await db.all<{ owner: string }>(`SELECT owner FROM vb_by_note`);
    expect(rows).toEqual([{ owner: "o'brien" }]);
  });

  it("other views read the database view, with the defaults", async () => {
    await seedOrders();
    await revenueView();
    await createCollection({ name: "big_spenders", type: "view", view_query: "SELECT id, total FROM vb_revenue WHERE total > 20", list_rule: null, view_rule: null });
    expect((await listRecords("big_spenders")).data).toEqual([expect.objectContaining({ id: "u1", total: 30 })]);
    // Internal reads (no request) of the view itself get the defaults too.
    expect(await getRecord("revenue", "u2")).toMatchObject({ total: 5 });
  });
});

describe("a parameter from the signed-in user", () => {
  async function mineView() {
    await createCollection({
      name: "my_orders", type: "view", view_query: "SELECT id, amount, status FROM vb_orders WHERE owner = :me",
      view_params: JSON.stringify([{ name: "me", type: "text", from: "auth.id" }]),
      list_rule: null, view_rule: null,
    });
  }

  it("reads the caller's rows, and none for a guest", async () => {
    await seedOrders();
    await mineView();
    await seedAuthUser({ collection: "users", id: "u1", email: "u1@test.local" });
    await seedAuthUser({ collection: "users", id: "u2", email: "u2@test.local" });
    const t1 = await signUserJwt("u1", "u1@test.local", "users", SECRET);
    const t2 = await signUserJwt("u2", "u2@test.local", "users", SECRET);
    expect((await get("/my_orders", t1)).body.data.map((r) => r["amount"]).sort()).toEqual([10, 20]);
    expect((await get("/my_orders", t2)).body.data.map((r) => r["amount"]).sort()).toEqual([5, 7]);
    expect((await get("/my_orders")).body.data).toEqual([]);
  });

  it("can't be set from the request", async () => {
    await seedOrders();
    await mineView();
    await seedAuthUser({ collection: "users", id: "u2", email: "u2@test.local" });
    const t2 = await signUserJwt("u2", "u2@test.local", "users", SECRET);
    const r = await get("/my_orders?params[me]=u1", t2);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("can't be set");
  });
});

describe("changing a view's parameters", () => {
  it("validates against the query, and only views take them", async () => {
    await seedOrders();
    await revenueView();
    const err = async (fn: () => Promise<unknown>) => { try { await fn(); return null; } catch (e) { return e; } };
    const e1 = await err(() => updateCollection("revenue", { view_params: JSON.stringify([REVENUE_PARAMS[0]]) }));
    expect(e1).toBeInstanceOf(CollectionValidationError);
    expect((e1 as CollectionValidationError).details["view_params"]).toContain("uses :status, which isn't declared");
    const e2 = await err(() => updateCollection("orders", { view_params: JSON.stringify(REVENUE_PARAMS) }));
    expect((e2 as CollectionValidationError).details["view_params"]).toBe("Only view collections take parameters");
    // A new query and its parameters together.
    await updateCollection("revenue", {
      view_query: "SELECT owner AS id, SUM(amount) AS total FROM vb_orders WHERE amount >= :min GROUP BY owner",
      view_params: JSON.stringify([{ name: "min", type: "number", default: 10 }]),
    });
    expect(ids((await get("/revenue")).body.data)).toEqual(["u1", "u3"]);
    expect(ids((await get("/revenue?params[min]=6")).body.data)).toEqual(["u1", "u2", "u3"]);
  });

  it("a snapshot carries them", async () => {
    await seedOrders();
    await revenueView();
    const col = (await getCollection("revenue"))!;
    const snap: CollectionSnapshot = { name: "revenue2", type: "view", fields: [], view_query: col.view_query, view_params: JSON.parse(col.view_params!) };
    const res = await applySnapshot({ generated_at: "", version: 1, collections: [snap] } as never, { mode: "additive" });
    expect(res.created).toEqual(["revenue2"]);
    expect(JSON.parse((await getCollection("revenue2"))!.view_params!)).toEqual(JSON.parse(col.view_params!));
  });
});

describe("review findings", () => {
  async function byOwner(rule: string) {
    await createCollection({
      name: "byowner", type: "view", view_query: "SELECT id, owner, amount FROM vb_orders WHERE owner = :owner",
      view_params: JSON.stringify([{ name: "owner", type: "text", default: "u3" }]),
      list_rule: rule, view_rule: rule,
    });
    await seedAuthUser({ collection: "users", id: "u1", email: "u1@test.local" });
    return await signUserJwt("u1", "u1@test.local", "users", SECRET);
  }

  it("a literal params.x key doesn't satisfy a rule the view doesn't follow", async () => {
    await seedOrders();
    const t1 = await byOwner("@request.query.params.owner = @request.auth.id");
    // The rule would see u1, the query would read the default (u3).
    expect((await get("/byowner?params.owner=u1", t1)).body.data).toEqual([]);
    const one = (await listRecords("orders", { filter: `owner = "u3"` })).data[0]!.id;
    expect((await get(`/byowner/${one}?params.owner=u1`, t1)).status).toBe(403);
    // The legitimate path: the value the query uses is the one checked.
    expect((await get("/byowner?params[owner]=u1", t1)).body.data.map((r) => r["amount"]).sort()).toEqual([10, 20]);
  });

  it("leaving a parameter out can't get past a rule on its default", async () => {
    await seedOrders();
    const t1 = await byOwner(`@request.query.params.owner != "u3"`);
    expect((await get("/byowner", t1)).body.data).toEqual([]);
    expect((await get("/byowner?params[owner]=u2", t1)).body.data.length).toBe(2);
  });

  it("a batch refuses a view with parameters", async () => {
    await seedOrders();
    const t1 = await byOwner("@request.query.params.owner = @request.auth.id");
    const res = await makeBatchPlugin(SECRET).handle(new Request("http://localhost/batch?params[owner]=u1", {
      method: "POST", headers: { authorization: `Bearer ${t1}`, "content-type": "application/json" },
      body: JSON.stringify({ requests: [{ method: "GET", url: "/api/v1/byowner?params[owner]=u1" }] }),
    }));
    const body = await res.json() as unknown;
    // Refused for the whole batch: its URL carries params[...].
    expect(res.status).toBe(400);
    expect(JSON.stringify(body)).toContain("A batch request takes no params");
    expect(JSON.stringify(body)).not.toContain('"amount"');
    // Without them on the batch URL, the op is still refused on its own.
    const op = await makeBatchPlugin(SECRET).handle(new Request("http://localhost/batch", {
      method: "POST", headers: { authorization: `Bearer ${t1}`, "content-type": "application/json" },
      body: JSON.stringify({ requests: [{ method: "GET", url: "/api/v1/byowner?params[owner]=u1" }] }),
    }));
    expect(JSON.stringify(await op.json())).toContain("takes parameters: read it with GET /api/v1/byowner, not in a batch");
  });

  it("nearVector is refused on a view with parameters", async () => {
    await seedOrders();
    await revenueView();
    const r = await get("/revenue?nearVector=[1]&nearVectorField=x");
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("nearVector isn't available");
  });

  it("numbers come back as numbers, and a date out of range is a 400", async () => {
    await seedOrders();
    await createCollection({
      name: "echo", type: "view", view_query: "SELECT id, :n AS n, :d AS d FROM vb_orders LIMIT CAST(:lim AS integer)",
      view_params: JSON.stringify([{ name: "n", type: "number", default: 1.5 }, { name: "d", type: "date", default: 0 }, { name: "lim", type: "number", default: 2 }]),
      list_rule: null, view_rule: null,
    });
    const r = await get("/echo?params[n]=2.25&params[lim]=1");
    expect(r.body.data).toEqual([expect.objectContaining({ n: 2.25, d: 0 })]);
    expect((await get("/echo?params[d]=99999999999999999999")).status).toBe(400);
    expect(JSON.parse((await getCollection("echo"))!.fields).find((f: { name: string }) => f.name === "n").type).toBe("number");
  });

  it("a hand-written snapshot with a date default is in sync once applied", async () => {
    await seedOrders();
    // Keys in another order, and the date default as written by hand.
    const view_params = JSON.parse(`[{"type":"date","name":"since","default":"2026-01-01"},{"default":"paid","name":"status","type":"text"}]`) as ViewParam[];
    const snap: CollectionSnapshot = { name: "revenue", type: "view", fields: [], view_query: REVENUE, view_params };
    const first = await applySnapshot({ generated_at: "", version: 1, collections: [snap] } as never, { mode: "sync" });
    expect(first.errors).toEqual([]);
    expect(first.created).toEqual(["revenue"]);
    snap.fields = JSON.parse((await getCollection("revenue"))!.fields);
    expect((await applySnapshot({ generated_at: "", version: 1, collections: [snap] } as never, { mode: "sync" })).unchanged).toEqual(["revenue"]);
  });
});

describe.skipIf(onSqlite)("Postgres array slices", () => {
  it("aren't read as parameters", async () => {
    await seedOrders();
    await createCollection({
      name: "slices", type: "view",
      view_query: "SELECT id, (ARRAY[1,2,3])[1:2] AS first_two FROM vb_orders WHERE amount >= :min",
      view_params: JSON.stringify([{ name: "min", type: "number", default: 0 }]),
      list_rule: null, view_rule: null,
    });
    expect((await listRecords("slices", { viewParams: { min: 20 } })).totalItems).toBe(2);
  });
});

describe("the admin API and OpenAPI", () => {
  const admin = (method: string, path: string, body?: unknown) => makeCollectionsPlugin(SECRET).handle(new Request(`http://localhost${path}`, {
    method, headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));

  it("creates a view with parameters, and refuses a mismatch with 422", async () => {
    await seedOrders();
    const ok = await admin("POST", "/collections", { name: "revenue", type: "view", view_query: REVENUE, view_params: REVENUE_PARAMS, list_rule: null, view_rule: null });
    expect(ok.status).toBe(200);
    expect(JSON.parse((await getCollection("revenue"))!.view_params!)).toEqual([
      { name: "since", type: "date", default: T0 }, { name: "status", type: "text", default: "paid" },
    ]);
    const bad = await admin("POST", "/collections", { name: "revenue2", type: "view", view_query: REVENUE, view_params: [REVENUE_PARAMS[0]] });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(await bad.json())).toContain("uses :status");
    expect(await getCollection("revenue2")).toBeNull();
  });

  it("previews rows with test values", async () => {
    await seedOrders();
    const res = await admin("POST", "/admin/collections/preview-view-rows", {
      view_query: REVENUE, view_params: REVENUE_PARAMS, params: { status: "void" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { columns: string[]; rows: Array<Record<string, unknown>> } };
    expect(body.data.columns).toEqual(["id", "orders", "total"]);
    expect(body.data.rows).toEqual([expect.objectContaining({ id: "u3", total: 100 })]);
    const fields = await admin("POST", "/admin/collections/preview-view", { view_query: REVENUE, view_params: REVENUE_PARAMS });
    expect(fields.status).toBe(200);
  });

  it("describes them in OpenAPI, leaving out the one from auth", async () => {
    await seedOrders();
    await revenueView();
    await createCollection({
      name: "my_orders", type: "view", view_query: "SELECT id, amount FROM vb_orders WHERE owner = :me AND amount > :min",
      view_params: JSON.stringify([{ name: "me", type: "text", from: "auth.id" }, { name: "min", type: "number", required: true }]),
      list_rule: null, view_rule: null,
    });
    const spec = buildOpenApi(await listCollections()) as { paths: Record<string, { get: { parameters: Array<{ name: string; required: boolean }> } }> };
    const names = (path: string) => spec.paths[path]!.get.parameters.map((p) => p.name);
    expect(names("/api/v1/revenue")).toEqual(expect.arrayContaining(["params[since]", "params[status]"]));
    expect(names("/api/v1/my_orders")).toContain("params[min]");
    expect(names("/api/v1/my_orders")).not.toContain("params[me]");
    expect(spec.paths["/api/v1/my_orders"]!.get.parameters.find((p) => p.name === "params[min]")!.required).toBe(true);
  });
});

describe.skipIf(onSqlite)("Postgres", () => {
  it("a view with jsonb's ? operator takes parameters", async () => {
    await createCollection({
      name: "docs", type: "base", fields: JSON.stringify([{ name: "meta", type: "json" }, { name: "n", type: "number" }]),
      list_rule: null, view_rule: null, create_rule: null, update_rule: null, delete_rule: null,
    });
    await createRecord("docs", { meta: { k: 1 }, n: 1 });
    await createRecord("docs", { meta: { j: 1 }, n: 2 });
    await createRecord("docs", { meta: { k: 2 }, n: 3 });
    await createCollection({
      name: "with_k", type: "view", view_query: "SELECT id, n FROM vb_docs WHERE meta::jsonb ? 'k' AND n >= :min",
      view_params: JSON.stringify([{ name: "min", type: "number", default: 0 }]),
      list_rule: null, view_rule: null,
    });
    expect((await listRecords("with_k")).totalItems).toBe(2);
    expect((await listRecords("with_k", { viewParams: { min: 2 } })).data.map((r) => r["n"])).toEqual([3]);
  });
});
