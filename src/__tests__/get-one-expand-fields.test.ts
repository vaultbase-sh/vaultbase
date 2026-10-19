/**
 * GET /api/v1/<collection>/<id> takes `expand` and `fields`, as a list does.
 *
 * The OpenAPI spec and the docs offered both on get-one, but the handler
 * returned the stored record as is: `?expand=author` came back without
 * `expand`, `?fields=id,title` with every field. Both now go through the
 * same step as a list (shapeRecords), so the related collection's view rule
 * still decides what's expanded. A projection keeps `expand` when expanding
 * was asked for, on lists too.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, ensureSingletonRecord, _resetCollectionCache } from "../core/collections.ts";
import { createRecord, listRecords, updateRecord } from "../core/records.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { signAuthToken } from "../core/sec.ts";
import { admin } from "../db/schema.ts";
import { seedAuthUser } from "./_helpers.ts";

const SECRET = "test-secret-get-one-shape";
const OWNER = "u-owner";
const OTHER = "u-other";

let ownerToken = "";
let adminToken = "";
let postId = "";

const app = () => makeRecordsPlugin(SECRET);
async function get(path: string, token?: string, headers: Record<string, string> = {}) {
  const r = await app().handle(new Request(`http://localhost${path}`, {
    headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) },
  }));
  const text = await r.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json, etag: r.headers.get("etag") };
}

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  _resetCollectionCache();
  await getDb().insert(admin).values({ id: "admin-1", email: "a@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });

  // Users see only themselves; posts and their tags are public.
  await createCollection({ name: "users", type: "auth", fields: JSON.stringify([{ name: "name", type: "text" }]), list_rule: null, view_rule: "id = @request.auth.id" });
  await createCollection({ name: "orgs", fields: JSON.stringify([{ name: "title", type: "text" }]), list_rule: null, view_rule: null });
  await createCollection({ name: "teams", fields: JSON.stringify([{ name: "title", type: "text" }, { name: "org", type: "relation", collection: "orgs" }]), list_rule: null, view_rule: null });
  await createCollection({
    name: "posts",
    fields: JSON.stringify([
      { name: "title", type: "text" },
      { name: "body", type: "text" },
      { name: "author", type: "relation", collection: "users" },
      { name: "team", type: "relation", collection: "teams" },
    ]),
    list_rule: null,
    view_rule: null,
  });
  _resetCollectionCache();

  await seedAuthUser({ collection: "users", id: OWNER, email: "owner@test.local" });
  await seedAuthUser({ collection: "users", id: OTHER, email: "other@test.local" });
  const org = await createRecord("orgs", { title: "Acme" });
  const team = await createRecord("teams", { title: "Core", org: org["id"] });
  postId = (await createRecord("posts", { title: "Hello", body: "Long text", author: OWNER, team: team["id"] }))["id"] as string;

  ownerToken = (await signAuthToken({ payload: { id: OWNER, collection: "users" }, audience: "user", expiresInSeconds: 60, jwtSecret: SECRET })).token;
  adminToken = (await signAuthToken({ payload: { id: "admin-1", email: "a@test.local" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET })).token;
});
afterEach(async () => { _resetCollectionCache(); await closeDb(); });

describe("get one: expand and fields", () => {
  it("expands a relation", async () => {
    const r = await get(`/posts/${postId}?expand=team`);
    expect(r.status).toBe(200);
    expect(r.json.data.expand.team).toMatchObject({ title: "Core" });
  });

  it("expands several relations and nested paths", async () => {
    const r = await get(`/posts/${postId}?expand=team.org,author`, ownerToken);
    expect(r.json.data.expand.team.expand.org).toMatchObject({ title: "Acme" });
    expect(r.json.data.expand.author.id).toBe(OWNER);
  });

  it("returns only the fields asked for, id always", async () => {
    const r = await get(`/posts/${postId}?fields=title`);
    expect(r.json.data).toEqual({ id: postId, title: "Hello" });
  });

  it("keeps expand when projecting, on get-one and on lists", async () => {
    const one = await get(`/posts/${postId}?fields=id,title&expand=team`);
    expect(one.json.data).toEqual({ id: postId, title: "Hello", expand: { team: expect.objectContaining({ title: "Core" }) } });
    const list = await listRecords("posts", { fields: "id,title", expand: "team" });
    expect(list.data[0]).toEqual({ id: postId, title: "Hello", expand: { team: expect.objectContaining({ title: "Core" }) } } as never);
  });

  it("doesn't expand a related record the caller can't view", async () => {
    await updateRecord("posts", postId, { author: OTHER }, null);
    const asOwner = await get(`/posts/${postId}?expand=author`, ownerToken);
    expect(asOwner.status).toBe(200);
    expect(asOwner.json.data.expand?.author).toBeUndefined();
    expect(asOwner.json.data.author).toBe(OTHER);
    const asNobody = await get(`/posts/${postId}?expand=author`);
    expect(asNobody.json.data.expand?.author).toBeUndefined();
    const asAdmin = await get(`/posts/${postId}?expand=author`, adminToken);
    expect(asAdmin.json.data.expand.author.id).toBe(OTHER);
    expect(asAdmin.json.data.expand.author).not.toHaveProperty("password_hash");
  });

  it("keeps the ETag of the full record, so If-None-Match and If-Match still agree", async () => {
    const plain = await get(`/posts/${postId}`);
    const shaped = await get(`/posts/${postId}?fields=title&expand=team`);
    expect(shaped.etag).toBe(plain.etag);
    expect((await get(`/posts/${postId}?fields=title`, undefined, { "if-none-match": plain.etag! })).status).toBe(304);
  });

  it("ignores unknown relations and fields instead of failing", async () => {
    const r = await get(`/posts/${postId}?expand=nope&fields=title,nope`);
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({ id: postId, title: "Hello" });
  });

  it("applies to singletons too", async () => {
    await createCollection({
      name: "site",
      type: "singleton",
      fields: JSON.stringify([{ name: "name", type: "text" }, { name: "owner", type: "relation", collection: "users" }]),
      view_rule: null,
      update_rule: null,
    });
    _resetCollectionCache();
    await updateRecord("site", await ensureSingletonRecord("site"), { name: "Acme", owner: OWNER }, null);
    const r = await get(`/site?fields=name&expand=owner`, ownerToken);
    expect(r.status).toBe(200);
    expect(Object.keys(r.json.data).sort()).toEqual(["expand", "id", "name"]);
    expect(r.json.data.expand.owner.id).toBe(OWNER);
  });
});
