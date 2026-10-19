/**
 * Collection writes that used to break the collection or answer 500:
 *  - a field named like a system column (`created_at`) failed after the
 *    collection row was saved, leaving a collection with no table;
 *  - a field named `created` replaced the timestamp in every record;
 *  - a singleton with a required field couldn't be created (its record
 *    starts empty, which NOT NULL refused);
 *  - changing a field's type answered 500;
 *  - PATCH by name answered 500, and DELETE by name dropped the table but
 *    kept the collection.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { admin } from "../db/schema.ts";
import { createCollection, getCollection, _resetCollectionCache, CollectionValidationError } from "../core/collections.ts";
import { createRecord, listRecords } from "../core/records.ts";
import { signAuthToken } from "../core/sec.ts";
import { makeCollectionsPlugin } from "../api/collections.ts";
import { makeRecordsPlugin } from "../api/records.ts";

const SECRET = "test-secret-collection-guards";
let token: string;

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  await getDb().insert(admin).values({ id: "a1", email: "a@x", password_hash: "x", password_reset_at: 0, created_at: 0 });
  token = (await signAuthToken({ payload: { id: "a1", email: "a@x" }, audience: "admin", expiresInSeconds: 600, jwtSecret: SECRET })).token;
});
afterEach(async () => { _resetCollectionCache(); await closeDb(); });

const api = async (method: string, path: string, body?: unknown) => {
  const res = await makeCollectionsPlugin(SECRET).handle(new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
};

describe("collection schema guards", () => {
  it("system names are refused before anything is saved", async () => {
    for (const name of ["created_at", "created", "id", "collectionName", "expand"]) {
      await expect(createCollection({ name: `bad_${name.toLowerCase()}`, fields: JSON.stringify([{ name, type: "text" }]) }))
        .rejects.toBeInstanceOf(CollectionValidationError);
      expect(await getCollection(`bad_${name.toLowerCase()}`)).toBeNull();
    }
  });

  it("a singleton with a required field is created, its record empty", async () => {
    await createCollection({ name: "site", type: "singleton", fields: JSON.stringify([{ name: "title", type: "text", required: true }]), view_rule: null, update_rule: null });
    const rec = (await listRecords("site", {})).data[0] as unknown as { title: unknown };
    expect(rec.title ?? null).toBeNull();
    const patch = await makeRecordsPlugin(SECRET).handle(new Request("http://localhost/site", {
      method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ title: "" }),
    }));
    expect(patch.status).toBe(422); // required still holds on writes
  });

  it("changing a field's type is a 422", async () => {
    const col = await createCollection({ name: "notes", fields: JSON.stringify([{ name: "n", type: "text" }]) });
    const r = await api("PATCH", `/collections/${col.id}`, { fields: [{ name: "n", type: "number" }] });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.json.details)).toContain("Cannot change type");
  });

  it("PATCH and DELETE take a name as well as an id", async () => {
    await createCollection({ name: "byname", fields: JSON.stringify([{ name: "t", type: "text" }]) });
    await createRecord("byname", { t: "kept" });
    const p = await api("PATCH", "/collections/byname", { list_rule: null });
    expect(p.status).toBe(200);
    expect((await getCollection("byname"))?.list_rule).toBeNull();
    const d = await api("DELETE", "/collections/byname");
    expect(d.status).toBe(200);
    _resetCollectionCache();
    expect(await getCollection("byname")).toBeNull();
  });

  it("an unknown collection is a 404", async () => {
    expect((await api("PATCH", "/collections/nope", { list_rule: null })).status).toBe(404);
    expect((await api("DELETE", "/collections/nope")).status).toBe(404);
  });
});
