/**
 * Collections must not be public unless someone asks for that.
 *
 * `evaluateRule` (core/rules.ts) reads `null` as public and `""` as
 * admin-only. Omitted rules used to store NULL, so a collection created from
 * the admin UI — which sent no rules at all — was world-readable and
 * world-writable: anyone could list an auth collection's emails, PATCH a
 * user's role, or DELETE them.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, _resetCollectionCache } from "../core/collections.ts";
import { makeCollectionsPlugin } from "../api/collections.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { createRecord } from "../core/records.ts";
import { signAuthToken } from "../core/sec.ts";
import { getDb } from "../db/client.ts";
import { admin } from "../db/schema.ts";

const SECRET = "test-secret-rule-defaults";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  _resetCollectionCache();
});
afterEach(() => closeDb());

async function adminToken(): Promise<string> {
  // The principal re-check looks the admin row up, so a bare JWT isn't enough.
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(admin).values({
    id: "admin-1",
    email: "a@test.local",
    password_hash: "x",
    password_reset_at: 0,
    created_at: now,
  }).onConflictDoNothing();
  const { token } = await signAuthToken({
    payload: { id: "admin-1", email: "a@test.local" },
    audience: "admin",
    expiresInSeconds: 3600,
    jwtSecret: SECRET,
  });
  return token;
}

describe("collection rule defaults", () => {
  it("stores admin-only for every rule the caller omits", async () => {
    const col = await createCollection({
      name: "posts",
      fields: JSON.stringify([{ name: "title", type: "text" }]),
    });
    expect(col.list_rule).toBe("");
    expect(col.view_rule).toBe("");
    expect(col.create_rule).toBe("");
    expect(col.update_rule).toBe("");
    expect(col.delete_rule).toBe("");
  });

  it("still honours an explicit null as public", async () => {
    const col = await createCollection({
      name: "open",
      fields: JSON.stringify([{ name: "title", type: "text" }]),
      list_rule: null,
      view_rule: null,
    });
    expect(col.list_rule).toBeNull();
    expect(col.view_rule).toBeNull();
    // Untouched rules keep the safe default.
    expect(col.create_rule).toBe("");
  });

  it("denies anonymous list, read, create, update and delete", async () => {
    await createCollection({
      name: "posts",
      fields: JSON.stringify([{ name: "title", type: "text" }]),
    });
    const rec = await createRecord("posts", { title: "secret" });
    const api = makeRecordsPlugin(SECRET);
    const base = "http://localhost";

    const list = await api.handle(new Request(`${base}/posts`));
    expect(list.status).toBe(403);

    const read = await api.handle(new Request(`${base}/posts/${rec["id"]}`));
    expect(read.status).toBe(403);

    const create = await api.handle(new Request(`${base}/posts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "mine" }),
    }));
    expect(create.status).toBe(403);

    const patch = await api.handle(new Request(`${base}/posts/${rec["id"]}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "theirs" }),
    }));
    expect(patch.status).toBe(403);

    const del = await api.handle(new Request(`${base}/posts/${rec["id"]}`, { method: "DELETE" }));
    expect(del.status).toBe(403);
  });

  it("still lets an admin through", async () => {
    await createCollection({
      name: "posts",
      fields: JSON.stringify([{ name: "title", type: "text" }]),
    });
    await createRecord("posts", { title: "secret" });
    const res = await makeRecordsPlugin(SECRET).handle(
      new Request("http://localhost/posts", {
        headers: { authorization: `Bearer ${await adminToken()}` },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("an auth collection created through the API is not world-readable", async () => {
    // The exact shape the admin UI's New collection modal posts: no rules.
    const create = await makeCollectionsPlugin(SECRET).handle(
      new Request("http://localhost/collections", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${await adminToken()}`,
        },
        body: JSON.stringify({ name: "members", type: "auth", fields: [] }),
      }),
    );
    expect(create.status).toBe(200);
    const body = await create.json() as { data: { list_rule: string | null } };
    expect(body.data.list_rule).toBe("");

    _resetCollectionCache();
    const anon = await makeRecordsPlugin(SECRET).handle(new Request("http://localhost/members"));
    expect(anon.status).toBe(403);
  });
});
