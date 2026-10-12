/**
 * Relation fields were validated for existence only. A caller could point a
 * relation at a record they can't view — linking to someone else's private
 * record — and the "does not exist" error (naming the id) told them which
 * ids exist in a collection they can't read. A relation now has to point at
 * a record the caller can view, and missing / not visible get one answer.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, _resetCollectionCache } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { makeBatchPlugin } from "../api/batch.ts";
import { seedAuthUser, signUserJwt } from "./_helpers.ts";

const SECRET = "test-secret-relation-visibility";
let alice: string;
let jwt: string;
let mine: string;
let theirs: string;

beforeEach(async () => {
  _resetCollectionCache();
  initDb(":memory:");
  await runMigrations();
  alice = await seedAuthUser({ collection: "users", email: "alice@test.local" });
  jwt = await signUserJwt(alice, "alice@test.local", "users", SECRET);
  await createCollection({
    name: "notes", fields: JSON.stringify([{ name: "owner", type: "text" }]),
    view_rule: "owner = @request.auth.id", list_rule: "owner = @request.auth.id",
  });
  await createCollection({
    name: "links",
    fields: JSON.stringify([{ name: "note", type: "relation", collection: "notes" }]),
    create_rule: "@request.auth.id != ''", list_rule: null, view_rule: null,
  });
  mine = (await createRecord("notes", { owner: alice }, null)).id;
  theirs = (await createRecord("notes", { owner: "bob" }, null)).id;
});

afterEach(() => closeDb());

const create = (note: string) => makeRecordsPlugin(SECRET).handle(new Request("http://localhost/links", {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` }, body: JSON.stringify({ note }),
}));

describe("relation targets", () => {
  it("can't point at a record the caller can't view, and the error doesn't say it exists", async () => {
    const hidden = await create(theirs);
    const missing = await create(crypto.randomUUID());
    expect(hidden.status).toBe(422);
    expect(missing.status).toBe(422);
    const [h, m] = [await hidden.json(), await missing.json()] as Array<{ details: Record<string, string> }>;
    expect(h!.details).toEqual(m!.details);
    expect(JSON.stringify(h)).not.toContain(theirs);
  });

  it("the same through batch", async () => {
    const res = await makeBatchPlugin(SECRET).handle(new Request("http://localhost/batch", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ requests: [{ method: "POST", url: "/api/v1/links", body: { note: theirs } }] }),
    }));
    expect(res.status).toBe(422);
  });

  it("pointing at your own record works (legitimate path)", async () => {
    expect((await create(mine)).status).toBe(200);
  });
});
