/**
 * Rules have to see the request body, and update rules have to see the record
 * the write would produce.
 *
 * `buildRequestContext` always received a `null` body, so `@request.body.x`
 * was null everywhere: `:isset` returned false and any `@request.body.x = …`
 * comparison denied. A rule like `@request.body.role:isset = false`, written
 * to stop privilege escalation, passed unconditionally.
 *
 * Update rules were also evaluated only against the record as it stood. An
 * owner-scoped rule passes against the row you already own, so nothing stopped
 * you handing the row to somebody else in the same request.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, _resetCollectionCache } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { makeBatchPlugin } from "../api/batch.ts";
import { signAuthToken } from "../core/sec.ts";
import { admin } from "../db/schema.ts";
import { seedAuthUser } from "./_helpers.ts";

const SECRET = "test-secret-rule-body";
let userToken: string;

const USER_ID = "u-owner";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  _resetCollectionCache();
  await getDb().insert(admin).values({
    id: "admin-1", email: "a@test.local", password_hash: "x",
    password_reset_at: 0, created_at: Math.floor(Date.now() / 1000),
  });
  await createCollection({
    name: "users",
    type: "auth",
    fields: JSON.stringify([]),
    list_rule: null, view_rule: null,
  });
  _resetCollectionCache();
  // The principal re-check looks the user row up; a bare JWT is not enough.
  await seedAuthUser({ collection: "users", id: USER_ID, email: "o@test.local" });
  const { token } = await signAuthToken({
    payload: { id: USER_ID, email: "o@test.local", collection: "users" },
    audience: "user",
    expiresInSeconds: 3600,
    jwtSecret: SECRET,
  });
  userToken = token;
});
afterEach(() => closeDb());

async function collection(rules: Partial<{ create: string; update: string }>) {
  await createCollection({
    name: "docs",
    type: "base",
    fields: JSON.stringify([
      { name: "title", type: "text" },
      { name: "owner", type: "text" },
      { name: "role", type: "text" },
    ]),
    list_rule: null,
    view_rule: null,
    create_rule: rules.create ?? null,
    update_rule: rules.update ?? null,
    delete_rule: null,
  });
  _resetCollectionCache();
}

const api = () => makeRecordsPlugin(SECRET);

async function post(body: unknown): Promise<Response> {
  return api().handle(new Request("http://localhost/docs", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${userToken}` },
    body: JSON.stringify(body),
  }));
}

async function patch(id: string, body: unknown): Promise<Response> {
  return api().handle(new Request(`http://localhost/docs/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${userToken}` },
    body: JSON.stringify(body),
  }));
}

describe("create rules can read the request body", () => {
  it("enforces @request.body.<field>:isset = false", async () => {
    await collection({ create: `@request.body.role:isset = false` });
    expect((await post({ title: "ok" })).status).toBe(200);
    // Previously passed: a null body made :isset false whatever was sent.
    expect((await post({ title: "nope", role: "admin" })).status).toBe(403);
  });

  it("enforces a value comparison against the body", async () => {
    await collection({ create: `@request.body.owner = @request.auth.id` });
    expect((await post({ title: "mine", owner: USER_ID })).status).toBe(200);
    expect((await post({ title: "theirs", owner: "someone-else" })).status).toBe(403);
  });
});

describe("update rules see the record the write would produce", () => {
  it("refuses to let an owner hand the record to someone else", async () => {
    await collection({ update: `owner = @request.auth.id` });
    const rec = await createRecord("docs", { title: "t", owner: USER_ID });
    const id = rec["id"] as string;

    // Editing your own record is still fine.
    expect((await patch(id, { title: "renamed" })).status).toBe(200);

    // Reassignment passes against the existing row and must fail on the result.
    expect((await patch(id, { owner: "someone-else" })).status).toBe(403);
  });

  it("still refuses when the current record already fails the rule", async () => {
    await collection({ update: `owner = @request.auth.id` });
    const rec = await createRecord("docs", { title: "t", owner: "someone-else" });
    expect((await patch(rec["id"] as string, { title: "x" })).status).toBe(403);
  });

  it("treats the patch as partial — untouched fields keep their value", async () => {
    await collection({ update: `owner = @request.auth.id` });
    const rec = await createRecord("docs", { title: "t", owner: USER_ID });
    // `owner` is absent from the body, so the merged record keeps it.
    expect((await patch(rec["id"] as string, { title: "still mine" })).status).toBe(200);
  });

  it("supports :isset on the body for pinning a field shut", async () => {
    await collection({ update: `owner = @request.auth.id && @request.body.owner:isset = false` });
    const rec = await createRecord("docs", { title: "t", owner: USER_ID });
    const id = rec["id"] as string;
    expect((await patch(id, { title: "fine" })).status).toBe(200);
    // Even setting it to the *same* value is refused — the field is pinned.
    expect((await patch(id, { owner: USER_ID })).status).toBe(403);
  });
});

describe("the batch endpoint enforces the same rules", () => {
  async function batch(ops: unknown[]): Promise<Response> {
    return makeBatchPlugin(SECRET).handle(new Request("http://localhost/batch", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ requests: ops }),
    }));
  }

  it("applies the body to create rules", async () => {
    await collection({ create: `@request.body.role:isset = false` });
    const res = await batch([{ method: "POST", url: "/api/v1/docs", body: { title: "x", role: "admin" } }]);
    const text = await res.text();
    // Assert the shape is understood, so this can't pass vacuously.
    expect(res.status).toBeLessThan(500);
    expect(text).toMatch(/403|Forbidden/);
    expect(text).not.toContain('"status":200');
  });

  it("blocks owner reassignment on update", async () => {
    await collection({ update: `owner = @request.auth.id` });
    const rec = await createRecord("docs", { title: "t", owner: USER_ID });
    const res = await batch([
      { method: "PATCH", url: `/api/v1/docs/${rec["id"]}`, body: { owner: "someone-else" } },
    ]);
    const text = await res.text();
    expect(res.status).toBeLessThan(500);
    expect(text).toMatch(/403|Forbidden/);
    // And the row must be untouched.
    const after = await (await import("../core/records.ts")).getRecord("docs", rec["id"] as string);
    expect(after?.["owner"]).toBe(USER_ID);
  });
});
