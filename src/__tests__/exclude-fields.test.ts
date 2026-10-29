/**
 * `exclude` leaves fields out of a record response (issue #6), the opposite
 * of `fields`. It applies after `fields`, `id` always stays, and it works
 * everywhere `fields` does: lists, get-one, batch (list and get) and the MCP
 * list tool.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, _resetCollectionCache } from "../core/collections.ts";
import { createRecord, listRecords } from "../core/records.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { makeBatchPlugin } from "../api/batch.ts";
import { registerCollectionTools } from "../mcp/collection-tools.ts";
import { signAuthToken } from "../core/sec.ts";
import { admin } from "../db/schema.ts";

const SECRET = "test-secret-exclude-fields";
let postId = "";
let adminToken = "";

async function get(path: string) {
  const r = await makeRecordsPlugin(SECRET).handle(new Request(`http://localhost${path}`));
  return { status: r.status, json: await r.json() as any };
}

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  _resetCollectionCache();
  await getDb().insert(admin).values({ id: "admin-1", email: "a@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
  await createCollection({ name: "teams", fields: JSON.stringify([{ name: "title", type: "text" }]), list_rule: null, view_rule: null });
  await createCollection({
    name: "posts",
    fields: JSON.stringify([
      { name: "title", type: "text" },
      { name: "body", type: "text" },
      { name: "meta", type: "json" },
      { name: "team", type: "relation", collection: "teams" },
    ]),
    list_rule: null,
    view_rule: null,
  });
  _resetCollectionCache();
  const team = await createRecord("teams", { title: "Core" });
  postId = (await createRecord("posts", { title: "Hello", body: "Long text", meta: { a: 1 }, team: team["id"] }))["id"] as string;
  adminToken = (await signAuthToken({ payload: { id: "admin-1", email: "a@test.local" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET })).token;
});
afterEach(async () => { _resetCollectionCache(); await closeDb(); });

describe("exclude", () => {
  it("leaves the named fields out of a list and keeps the rest", async () => {
    const r = await get("/posts?exclude=body,meta");
    expect(r.status).toBe(200);
    const item = r.json.data[0];
    expect(item).not.toHaveProperty("body");
    expect(item).not.toHaveProperty("meta");
    expect(item).toMatchObject({ id: postId, title: "Hello" });
    expect(item).toHaveProperty("team");
    expect(item).toHaveProperty("created");
  });

  it("leaves the named fields out of get-one", async () => {
    const r = await get(`/posts/${postId}?exclude=body`);
    expect(r.status).toBe(200);
    expect(r.json.data).not.toHaveProperty("body");
    expect(r.json.data).toMatchObject({ id: postId, title: "Hello" });
  });

  it("applies after fields", async () => {
    const r = await get(`/posts/${postId}?fields=title,body&exclude=body`);
    expect(r.json.data).toEqual({ id: postId, title: "Hello" });
  });

  it("never drops id", async () => {
    const r = await get("/posts?exclude=id,body");
    expect(r.json.data[0].id).toBe(postId);
    expect(r.json.data[0]).not.toHaveProperty("body");
  });

  it("can leave out expand, and works next to it", async () => {
    const kept = await get(`/posts/${postId}?expand=team&exclude=body`);
    expect(kept.json.data.expand.team).toMatchObject({ title: "Core" });
    expect(kept.json.data).not.toHaveProperty("body");
    const dropped = await get(`/posts/${postId}?expand=team&exclude=expand`);
    expect(dropped.json.data).not.toHaveProperty("expand");
  });

  it("ignores unknown names and blanks", async () => {
    const r = await get("/posts?exclude=nope,, ,body");
    expect(r.status).toBe(200);
    expect(r.json.data[0]).not.toHaveProperty("body");
    expect(r.json.data[0].title).toBe("Hello");
  });

  it("works on listRecords directly", async () => {
    const r = await listRecords("posts", { exclude: "body" });
    expect(r.data[0]).not.toHaveProperty("body");
    expect(r.data[0]).toHaveProperty("title");
  });

  it("works in a batch, on list and get-one", async () => {
    const res = await makeBatchPlugin(SECRET).handle(new Request("http://localhost/batch", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ requests: [
        { method: "GET", url: "/api/v1/posts?exclude=body" },
        { method: "GET", url: `/api/v1/posts/${postId}?exclude=body,meta` },
        { method: "GET", url: `/api/v1/posts/${postId}?fields=title&expand=team` },
      ] }),
    }));
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    const [list, one, shaped] = json.data;
    const listBody = list.body ?? list;
    const oneBody = one.body ?? one;
    expect(listBody.data[0]).not.toHaveProperty("body");
    expect(listBody.data[0].title).toBe("Hello");
    expect(oneBody).not.toHaveProperty("body");
    expect(oneBody).not.toHaveProperty("meta");
    expect(oneBody.title).toBe("Hello");
    expect(shaped.body ?? shaped).toEqual({ id: postId, title: "Hello", expand: { team: expect.objectContaining({ title: "Core" }) } });
  });

  it("is offered by the MCP list tool", async () => {
    const tools = new Map<string, any>();
    await registerCollectionTools({ register: (t: any) => tools.set(t.definition.name, t) } as any);
    const list = tools.get("vaultbase.list_posts");
    expect(list.definition.inputSchema.properties.exclude.type).toBe("string");
    const out = await list.handler({ exclude: "body" });
    const text = JSON.stringify(out);
    expect(text).toContain("Hello");
    expect(text).not.toContain("Long text");
  });
});
