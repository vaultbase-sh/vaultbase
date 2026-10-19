/**
 * Singleton collections: exactly one record, made with the collection, read
 * with GET and changed with PATCH at the collection's own path. It can't be
 * created again or deleted, by any route (HTTP, batch, hooks, MCP), and a
 * collection can't be turned into or out of a singleton.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, ensureSingletonRecord, getCollection, updateCollection, _resetCollectionCache } from "../core/collections.ts";
import { createRecord, deleteRecord, getRecord, listRecords, SingletonRecordError } from "../core/records.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { makeBatchPlugin } from "../api/batch.ts";
import { applySnapshot } from "../core/migrations.ts";
import { buildOpenApi } from "../core/openapi.ts";
import { buildRegistry } from "../mcp/server.ts";
import { on as onEvent } from "../core/events.ts";
import { signAuthToken } from "../core/sec.ts";
import { getDb } from "../db/client.ts";
import { admin } from "../db/schema.ts";
import { _reset as resetRealtime, subscribe as subscribeWs, type WSLike } from "../realtime/manager.ts";

const SECRET = "test-secret-singleton";
const fields = JSON.stringify([{ name: "site_name", type: "text" }, { name: "maintenance", type: "bool" }, { name: "limits", type: "json" }]);

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
});
afterEach(async () => { _resetCollectionCache(); await closeDb(); });

const app = () => makeRecordsPlugin(SECRET);
const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await app().handle(new Request(`http://localhost${path}`, {
    method, headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await r.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json, etag: r.headers.get("etag") };
};
const adminToken = async () => {
  await getDb().insert(admin).values({ id: "a1", email: "a@x", password_hash: "x", password_reset_at: 0, created_at: 0 }).onConflictDoNothing();
  return (await signAuthToken({ payload: { id: "a1", email: "a@x" }, audience: "admin", expiresInSeconds: 600, jwtSecret: SECRET })).token;
};
const settings = () => createCollection({ name: "settings_page", type: "singleton", fields, view_rule: null, update_rule: null });

describe("singleton collections", () => {
  it("are created with their one record, fields empty", async () => {
    await settings();
    const list = await listRecords("settings_page", {});
    expect(list.totalItems).toBe(1);
    expect(list.data[0]).toMatchObject({ site_name: null, maintenance: null, limits: null });
  });

  it("answer GET at their own path with the record, not a list", async () => {
    await settings();
    const r = await call("GET", "/settings_page");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.data)).toBe(false);
    expect(r.json.data.id).toBeTruthy();
    expect(r.etag).toBeTruthy();
  });

  it("update with PATCH at their own path, If-Match included", async () => {
    await settings();
    const first = await call("GET", "/settings_page");
    const r = await call("PATCH", "/settings_page", { site_name: "Acme", maintenance: true, limits: { uploads: 10 } }, { "if-match": first.etag! });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ id: first.json.data.id, site_name: "Acme", maintenance: true, limits: { uploads: 10 } });
    expect((await call("PATCH", "/settings_page", { site_name: "Stale" }, { "if-match": first.etag! })).status).toBe(412);
    expect((await call("GET", "/settings_page")).json.data.site_name).toBe("Acme");
  });

  it("follow their view and update rules", async () => {
    await createCollection({ name: "locked", type: "singleton", fields });
    expect((await call("GET", "/locked")).status).toBe(403);
    expect((await call("PATCH", "/locked", { site_name: "x" })).status).toBe(403);
    const token = await adminToken();
    expect((await call("PATCH", "/locked", { site_name: "by admin" }, { authorization: `Bearer ${token}` })).status).toBe(200);
  });

  it("still work by id, for generic clients such as the admin UI", async () => {
    await settings();
    const id = (await call("GET", "/settings_page")).json.data.id;
    expect((await call("GET", `/settings_page/${id}`)).status).toBe(200);
    expect((await call("PATCH", `/settings_page/${id}`, { site_name: "By id" })).status).toBe(200);
  });

  it("refuse creating and deleting their record, over HTTP and in the core", async () => {
    await settings();
    const id = (await call("GET", "/settings_page")).json.data.id;
    const post = await call("POST", "/settings_page", { site_name: "second" });
    expect(post.status).toBe(405);
    expect(post.json.error).toContain("singleton");
    expect((await call("DELETE", `/settings_page/${id}`)).status).toBe(405);
    await expect(createRecord("settings_page", {}, null)).rejects.toBeInstanceOf(SingletonRecordError);
    await expect(deleteRecord("settings_page", id, null)).rejects.toBeInstanceOf(SingletonRecordError);
    expect((await listRecords("settings_page", {})).totalItems).toBe(1);
  });

  it("refuse a create inside a batch, and roll the batch back", async () => {
    await settings();
    await createCollection({ name: "notes", fields: JSON.stringify([{ name: "t", type: "text" }]), create_rule: null, list_rule: null });
    const res = await makeBatchPlugin(SECRET).handle(new Request("http://localhost/batch", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ requests: [{ method: "POST", url: "/api/v1/notes", body: { t: "a" } }, { method: "POST", url: "/api/v1/settings_page", body: {} }] }),
    }));
    expect(res.status).toBe(405);
    expect((await listRecords("notes", {})).totalItems).toBe(0);
  });

  it("PATCH at a collection path is only for singletons", async () => {
    await createCollection({ name: "notes", fields: JSON.stringify([{ name: "t", type: "text" }]), update_rule: null });
    expect((await call("PATCH", "/notes", { t: "x" })).status).toBe(405);
  });

  it("announce updates to realtime like any record", async () => {
    await settings();
    const seen: string[] = [];
    const off = onEvent("record.updated", (e) => { seen.push(`${e.collection.name}:${String((e.record as { site_name?: string }).site_name)}`); });
    try {
      await call("PATCH", "/settings_page", { site_name: "Live" });
      await Bun.sleep(10);
      expect(seen).toEqual(["settings_page:Live"]);
    } finally { off(); }
  });

  it("reach non-admin subscribers of the collection: its view rule decides, not the unused list rule", async () => {
    // list_rule is left out, so it's stored admin-only; a singleton never uses it.
    await settings();
    resetRealtime();
    const got: string[] = [];
    const ws = { data: { connId: "anon-1" }, send: (m: string) => { got.push(m); } } as unknown as WSLike;
    subscribeWs(ws, ["settings_page"]);
    await call("PATCH", "/settings_page", { site_name: "Live" });
    await Bun.sleep(20);
    expect(got.map((m) => JSON.parse(m).record?.site_name)).toEqual(["Live"]);
    resetRealtime();
  });

  it("still keep updates from subscribers their view rule refuses", async () => {
    await createCollection({ name: "private_page", type: "singleton", fields, view_rule: "", update_rule: null });
    resetRealtime();
    const got: string[] = [];
    const ws = { data: { connId: "anon-2" }, send: (m: string) => { got.push(m); } } as unknown as WSLike;
    subscribeWs(ws, ["private_page"]);
    await call("PATCH", "/private_page", { site_name: "Hidden" });
    await Bun.sleep(20);
    expect(got).toEqual([]);
    resetRealtime();
  });

  it("can't be turned into a base collection or back", async () => {
    const s = await settings();
    await expect(updateCollection(s.id, { type: "base" } as Parameters<typeof updateCollection>[1])).rejects.toThrow(/singleton/);
    const b = await createCollection({ name: "plain", fields });
    await expect(updateCollection(b.id, { type: "singleton" } as Parameters<typeof updateCollection>[1])).rejects.toThrow(/singleton/);
  });

  it("get their record back if it was removed with raw SQL", async () => {
    await settings();
    await db.run(`DELETE FROM "vb_settings_page"`);
    const r = await call("GET", "/settings_page");
    expect(r.status).toBe(200);
    expect((await listRecords("settings_page", {})).totalItems).toBe(1);
    expect(await ensureSingletonRecord("settings_page")).toBe(r.json.data.id);
  });

  it("are created with their record when a snapshot makes them", async () => {
    const res = await applySnapshot({ version: 1, generated_at: "", collections: [{ name: "site", type: "singleton", fields: JSON.parse(fields), view_rule: null, update_rule: "" }] } as never, { mode: "additive" });
    expect(res.created).toEqual(["site"]);
    expect((await getCollection("site"))?.type).toBe("singleton");
    expect((await listRecords("site", {})).totalItems).toBe(1);
  });

  it("get read and update tools in MCP, no list, create or delete", async () => {
    await settings();
    const reg = await buildRegistry(false);
    const names = reg.list().map((t) => t.name).filter((n) => n.endsWith("_settings_page"));
    expect(names.sort()).toEqual(["vaultbase.get_settings_page", "vaultbase.update_settings_page"]);
    const ctx = { tokenId: "t", tokenName: "t", scopes: ["mcp:read", "mcp:write"], adminId: "a1", adminEmail: "a@x" };
    const upd = await reg.call("vaultbase.update_settings_page", { data: { site_name: "From MCP" } }, ctx);
    expect(upd.isError).toBeFalsy();
    const got = await reg.call("vaultbase.get_settings_page", {}, ctx);
    expect(JSON.stringify(got.content)).toContain("From MCP");
  });

  it("are described in OpenAPI as GET and PATCH on the collection path", async () => {
    await settings();
    const spec = buildOpenApi([(await getCollection("settings_page"))!]) as { paths: Record<string, Record<string, unknown>> };
    const p = spec.paths["/api/v1/settings_page"]!;
    expect(Object.keys(p).sort()).toEqual(["get", "patch"]);
    expect(spec.paths["/api/v1/settings_page/{id}"]).toBeUndefined();
    const params = (p["get"] as { parameters?: Array<{ name: string }> }).parameters ?? [];
    expect(params.map((x) => x.name)).toEqual(["expand", "fields"]);
  });

  it("keep their record across a restart", async () => {
    await settings();
    const id = (await call("GET", "/settings_page")).json.data.id;
    await runMigrations();
    _resetCollectionCache();
    expect((await getRecord("settings_page", id))?.id).toBe(id);
    expect((await listRecords("settings_page", {})).totalItems).toBe(1);
  });
});
