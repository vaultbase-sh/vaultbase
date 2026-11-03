/**
 * Regressions for the fourth November 2026 security audit pass (run-4):
 * read paths through joins, expand, batch and the list-total cache. Each
 * block reproduces the reported path and expects the fixed behavior.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { makeBatchPlugin } from "../api/batch.ts";
import { createCollection, getCollection, _resetCollectionCache } from "../core/collections.ts";
import {
  _countCacheStats, canSeeAs, collectionHiddenByRules, createRecord, hiddenFrom, listRecords, shapeRecords,
} from "../core/records.ts";
import { parseFilter } from "../core/filter.ts";
import type { AuthContext } from "../core/rules.ts";
import { createPublicCollection, onSqlite, seedAuthUser, signUserJwt } from "./_helpers.ts";

const SECRET = "test-secret-audit-run4-read-paths";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
});

afterEach(async () => {
  _resetCollectionCache();
  await closeDb();
});

function req(path: string, init: { method?: string; token?: string | null; body?: unknown } = {}): Request {
  const headers: Record<string, string> = {};
  if (init.token) headers["authorization"] = `Bearer ${init.token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new Request(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
}
const rec = (path: string, token: string | null = null) => makeRecordsPlugin(SECRET).handle(req(path, { token }));
const batch = (requests: unknown[], token: string | null = null, query = "") =>
  makeBatchPlugin(SECRET).handle(req(`/batch${query}`, { method: "POST", token, body: { requests } }));

async function userToken(id: string): Promise<string> {
  await seedAuthUser({ collection: "users", id, email: `${id}@x.io` });
  return signUserJwt(id, `${id}@x.io`, "users", SECRET);
}
const user = (id: string): AuthContext => ({ id, type: "user", email: `${id}@x.io` }) as AuthContext;

// ── Joined @collection comparisons on hidden rows ───────────────────────────

describe("a joined @collection comparison never runs on rows the target's rules hide", () => {
  async function fixture(): Promise<string> {
    await createCollection({
      name: "notes", type: "base",
      fields: JSON.stringify(["owner", "a", "b", "c", "email", "body"].map((name) => ({ name, type: "text" }))),
      list_rule: "owner = @request.auth.id", view_rule: "owner = @request.auth.id",
      create_rule: null, update_rule: null, delete_rule: null,
    });
    await createRecord("notes", { owner: "u3", email: "victim@example.test", body: "plain text" }, null);
    await createRecord("notes", { owner: "u1", email: "u1@example.test", body: "{\"k\":1}" }, null);
    await createPublicCollection({ name: "open", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    await createRecord("open", { title: "x" }, null);
    return userToken("u1");
  }

  const probes = [
    (email: string) => `@collection.notes.email = "${email}" && @collection.notes.body.k = 1`,
    (email: string) => `@collection.notes.body.k = 1 && @collection.notes.email = "${email}"`,
    (email: string) => `@collection.notes.email = "${email}" && @collection.notes.body:length > 0`,
    (email: string) => `@collection.notes.email = "${email}" && @collection.notes.body ?= "x"`,
    (email: string) => `@collection.notes.email = "${email}" && @collection.notes.body:each = "x"`,
  ];

  it("answers the same for a guess that matches a hidden row and one that matches nothing", async () => {
    const token = await fixture();
    const visible = await (await rec("/notes", token)).json() as { data: Array<{ owner: string }> };
    expect(visible.data.map((r) => r.owner)).toEqual(["u1"]);
    for (const probe of probes) {
      const hit = await rec(`/open?filter=${encodeURIComponent(probe("victim@example.test"))}`, token);
      const miss = await rec(`/open?filter=${encodeURIComponent(probe("nobody@example.test"))}`, token);
      expect({ probe: probe("?"), status: hit.status }).toEqual({ probe: probe("?"), status: miss.status });
      expect(hit.status).toBe(200);
      expect(((await hit.json()) as { totalItems: number }).totalItems).toBe(0);
    }
  });

  it("still matches the caller's own visible row", async () => {
    const token = await fixture();
    const own = await rec(`/open?filter=${encodeURIComponent(`@collection.notes.email = "u1@example.test" && @collection.notes.body.k = 1`)}`, token);
    expect(own.status).toBe(200);
    expect(((await own.json()) as { totalItems: number }).totalItems).toBe(1);
  });

  it("keeps a LEFT JOIN's empty row: `title = \"x\" || @collection…` holds with no visible match", async () => {
    const token = await fixture();
    const res = await rec(`/open?filter=${encodeURIComponent(`title = "x" || @collection.notes.body.k = 99`)}`, token);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { totalItems: number }).totalItems).toBe(1);
  });

  it("gates the negated and _via_ forms the same way", async () => {
    await createPublicCollection({ name: "open", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    const host = await createRecord("open", { title: "x" }, null);
    await createCollection({
      name: "notes", type: "base",
      fields: JSON.stringify([{ name: "owner", type: "text" }, { name: "email", type: "text" }, { name: "body", type: "text" }, { name: "post", type: "relation", collection: "open" }]),
      list_rule: "owner = @request.auth.id", view_rule: null,
      create_rule: null, update_rule: null, delete_rule: null,
    });
    await createRecord("notes", { owner: "u3", email: "victim@example.test", body: "plain text", post: host.id }, null);
    await createRecord("notes", { owner: "u1", email: "u1@example.test", body: "{\"k\":1}", post: host.id }, null);
    const token = await userToken("u1");
    const forms = [
      (email: string) => `notes_via_post.email ?= "${email}" && notes_via_post.body.k ?= 1`,
      (email: string) => `@collection.notes.body.k != "${email}"`,
    ];
    for (const form of forms) {
      const hit = await rec(`/open?filter=${encodeURIComponent(form("victim@example.test"))}`, token);
      const miss = await rec(`/open?filter=${encodeURIComponent(form("nobody@example.test"))}`, token);
      expect({ form: form("?"), status: hit.status }).toEqual({ form: form("?"), status: miss.status });
    }
  });
});

// ── View parameters reaching joined and expanded view rules ─────────────────

describe("joined and expanded parameterized views see the parameters their rows were read with", () => {
  /** Returns u3's row id in the view. */
  async function fixture(): Promise<string> {
    await createCollection({
      name: "orders", type: "base",
      fields: JSON.stringify([{ name: "owner", type: "text" }, { name: "amount", type: "number" }]),
      list_rule: "", view_rule: "", create_rule: "", update_rule: "", delete_rule: "",
    });
    await createRecord("orders", { owner: "u1", amount: 7 }, null);
    const hidden = await createRecord("orders", { owner: "u3", amount: 300 }, null);
    await createCollection({
      name: "byowner", type: "view",
      view_query: "SELECT id, owner, amount FROM vb_orders WHERE owner = :owner",
      view_params: JSON.stringify([{ name: "owner", type: "text", default: "u3" }]),
      list_rule: "@request.query.params.owner = @request.auth.id",
      view_rule: "@request.query.params.owner = @request.auth.id",
    });
    await createPublicCollection({ name: "pub", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    await createRecord("pub", { title: "x" }, null);
    await createPublicCollection({ name: "links", fields: JSON.stringify([{ name: "ref", type: "relation", collection: "byowner" }]) });
    await createRecord("links", { ref: hidden.id }, null);
    return hidden.id;
  }
  const outer = { query: { "params.owner": "u1" } };

  it("a batch refuses view parameters on its own URL", async () => {
    await fixture();
    const token = await userToken("u1");
    for (const url of ["/api/v1/pub?filter=@collection.byowner.amount%20%3D%20300", "/api/v1/links?expand=ref"]) {
      const res = await batch([{ method: "GET", url }], token, "?params[owner]=u1");
      expect({ url, status: res.status }).toEqual({ url, status: 400 });
    }
    const plain = await batch([{ method: "GET", url: "/api/v1/links?expand=ref" }], token);
    expect(plain.status).toBe(200);
    const body = await plain.json() as { data: Array<{ body: { data: Array<{ expand?: unknown }> } }> };
    expect(body.data[0]!.body.data[0]!.expand).toBeUndefined();
  });

  it("an @collection join into the view ignores params.* from the outer request", async () => {
    await fixture();
    for (const filter of ["@collection.byowner.amount = 300", "@collection.byowner.owner = \"u3\""]) {
      const r = await listRecords("pub", { filter, auth: user("u1"), request: outer });
      expect(r.totalItems).toBe(0);
    }
  });

  it("expand into the view ignores params.* from the outer request", async () => {
    await fixture();
    const list = await listRecords("links", { expand: "ref", auth: user("u1"), request: outer });
    expect(list.data[0]!.expand).toBeUndefined();
    const col = (await getCollection("links"))!;
    const [shaped] = await shapeRecords(col, list.data, { expand: "ref", auth: user("u1"), request: outer });
    expect(shaped!.expand).toBeUndefined();
  });

  it("a relation into the view is checked against its default rows, not params.*", async () => {
    const hiddenId = await fixture();
    const target = (await getCollection("byowner"))!;
    expect(await canSeeAs(user("u1"), outer)(target, hiddenId)).toBe(false);
    // The rule still holds for the caller the defaults belong to.
    expect(await canSeeAs(user("u3"), null)(target, hiddenId)).toBe(true);
  });
});

// ── Hidden singletons and views ─────────────────────────────────────────────

describe("singletons and views are hidden by the rules that apply to them", () => {
  async function fixture(): Promise<void> {
    await createCollection({
      name: "app_cfg", type: "singleton",
      fields: JSON.stringify([{ name: "smtp_pass", type: "text" }]),
      list_rule: null, create_rule: null, view_rule: "", update_rule: "", delete_rule: "",
    });
    await createCollection({
      name: "base_t", type: "base", fields: JSON.stringify([{ name: "secret_col", type: "text" }]),
      list_rule: "", view_rule: "", create_rule: "", update_rule: "", delete_rule: "",
    });
    await createCollection({
      name: "rep_view", type: "view", view_query: "SELECT id, secret_col FROM vb_base_t",
      list_rule: "", view_rule: "", create_rule: null,
    });
    await createPublicCollection({ name: "open", fields: JSON.stringify([{ name: "title", type: "text" }]) });
  }

  it("answers 404 like an absent collection", async () => {
    await fixture();
    const absent = await rec("/absent_x");
    expect(absent.status).toBe(404);
    for (const path of ["/app_cfg", "/rep_view", "/rep_view/x"]) {
      const res = await rec(path);
      expect({ path, status: res.status }).toEqual({ path, status: 404 });
    }
    for (const url of ["/api/v1/app_cfg", "/api/v1/rep_view"]) {
      const res = await batch([{ method: "GET", url }]);
      const op = ((await res.json()) as { data: Array<{ status: number }> }).data[0]!;
      expect({ url, status: op.status }).toEqual({ url, status: 404 });
    }
    const create = await makeRecordsPlugin(SECRET).handle(req("/rep_view", { method: "POST", body: {} }));
    expect(create.status).toBe(404);
  });

  it("a client filter can't tell them from an absent collection", async () => {
    await fixture();
    const absent = await (await rec(`/open?filter=${encodeURIComponent("@collection.absent_x.id = \"1\"")}`)).text();
    for (const name of ["app_cfg", "rep_view"]) {
      const res = await rec(`/open?filter=${encodeURIComponent(`@collection.${name}.id = "1"`)}`);
      expect(res.status).toBe(400);
      expect((await res.text()).split(name).join("absent_x")).toBe(absent);
    }
  });

  it("collectionHiddenByRules and hiddenFrom judge each type by its own rules", async () => {
    const singleton = { type: "singleton" as const, list_rule: null, create_rule: null, view_rule: "", update_rule: "" };
    expect(collectionHiddenByRules(singleton)).toBe(true);
    expect(hiddenFrom(singleton, null, null)).toBe(true);
    expect(collectionHiddenByRules({ ...singleton, update_rule: "@request.auth.id != \"\"" })).toBe(false);
    const view = { type: "view" as const, list_rule: "", view_rule: "", create_rule: null };
    expect(hiddenFrom(view, null, null)).toBe(true);
    expect(hiddenFrom({ ...view, view_rule: null }, null, null)).toBe(false);
    // Base and auth: list, view and create, plus the action's own rule.
    const base = { type: "base" as const, list_rule: "", view_rule: "", create_rule: "" };
    expect(hiddenFrom(base, null, "")).toBe(true);
    expect(hiddenFrom(base, null, null)).toBe(false);
    expect(hiddenFrom({ ...base, create_rule: null }, null, "")).toBe(false);
    expect(hiddenFrom(singleton, { id: "a1", type: "admin" } as AuthContext, "")).toBe(false);
  });
});

// ── Postgres clock literals and the count cache ─────────────────────────────

describe.skipIf(onSqlite)("Postgres strftime literals that read the clock are never counted from cache", () => {
  for (const literal of ["today 12:00", "TODAY+01", "today UTC", "Tomorrow 00:00", "now"]) {
    it(`'${literal}'`, async () => {
      await createPublicCollection({ name: "ticks", fields: JSON.stringify([{ name: "title", type: "text" }]) });
      await createRecord("ticks", { title: "x" }, null);
      const rule = `strftime('%Y-%m-%d', '${literal}') != '1999-01-01'`;
      expect(parseFilter(rule, "vb_ticks")!.sql).toContain("now()");
      const before = _countCacheStats();
      for (let i = 0; i < 2; i++) {
        const r = await listRecords("ticks", { accessRule: rule, auth: user("u1") });
        expect(r.totalItems).toBe(1);
      }
      const after = _countCacheStats();
      expect(after.hits - before.hits).toBe(0);
      expect(after.misses - before.misses).toBe(0);
    });
  }

  it("an absolute timestamp still compiles and matches", async () => {
    await createPublicCollection({ name: "ticks", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    await createRecord("ticks", { title: "x" }, null);
    const r = await listRecords("ticks", { accessRule: "strftime('%Y', '2024-06-01 12:00:00') = '2024'", auth: user("u1") });
    expect(r.totalItems).toBe(1);
  });
});
