/**
 * Deleting a record cascades to the records that reference it, and those
 * were deleted (or had the reference nulled) without asking their own
 * collection's rules: a user allowed to delete their own `project` could
 * wipe every `task` in it — other people's included — even where the tasks'
 * delete rule says only the task's owner may. A cascade now has to pass each
 * affected row's rule, or the whole delete is refused.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection } from "../core/collections.ts";
import { createRecord, getRecord } from "../core/records.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { makeBatchPlugin } from "../api/batch.ts";
import { seedAuthUser, signUserJwt } from "./_helpers.ts";

const SECRET = "test-secret-cascade-rules";
let alice: string;
let bob: string;
let aliceJwt: string;

async function setup(cascade: "cascade" | "setNull") {
  await createCollection({
    name: "projects", fields: JSON.stringify([{ name: "owner", type: "text" }]),
    list_rule: null, view_rule: null, delete_rule: "owner = @request.auth.id",
  });
  await createCollection({
    name: "tasks",
    fields: JSON.stringify([
      { name: "owner", type: "text" },
      { name: "project", type: "relation", collection: "projects", options: { cascade } },
    ]),
    list_rule: null, view_rule: null,
    delete_rule: "owner = @request.auth.id", update_rule: "owner = @request.auth.id",
  });
  const project = await createRecord("projects", { owner: alice }, null);
  const mine = await createRecord("tasks", { owner: alice, project: project.id }, null);
  const theirs = await createRecord("tasks", { owner: bob, project: project.id }, null);
  return { project, mine, theirs };
}

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  alice = await seedAuthUser({ collection: "users", email: "alice@test.local" });
  bob = await seedAuthUser({ collection: "users", email: "bob@test.local" });
  aliceJwt = await signUserJwt(alice, "alice@test.local", "users", SECRET);
});

afterEach(() => closeDb());

const del = (path: string) => makeRecordsPlugin(SECRET).handle(new Request(`http://localhost${path}`, {
  method: "DELETE", headers: { authorization: `Bearer ${aliceJwt}` },
}));

describe("cascade delete follows the child collection's rules", () => {
  it("refuses a delete that would cascade into someone else's records", async () => {
    const { project, theirs } = await setup("cascade");
    const res = await del(`/projects/${project.id}`);
    expect(res.status).toBe(403);
    // The refusal doesn't name the collection the caller can't see into.
    expect(JSON.stringify(await res.json())).not.toContain("tasks");
    expect(await getRecord("tasks", theirs.id)).not.toBeNull();
    expect(await getRecord("projects", project.id)).not.toBeNull();
  });

  it("the same via batch", async () => {
    const { project, theirs } = await setup("cascade");
    const res = await makeBatchPlugin(SECRET).handle(new Request("http://localhost/batch", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${aliceJwt}` },
      body: JSON.stringify({ requests: [{ method: "DELETE", url: `/api/v1/projects/${project.id}` }] }),
    }));
    expect(res.status).toBe(403);
    expect(await getRecord("tasks", theirs.id)).not.toBeNull();
  });

  it("setNull needs the child's update rule", async () => {
    const { project, theirs } = await setup("setNull");
    expect((await del(`/projects/${project.id}`)).status).toBe(403);
    expect((await getRecord("tasks", theirs.id))!["project"]).toBe(project.id);
  });

  it("cascades into the caller's own records still work (legitimate path)", async () => {
    const { project, mine, theirs } = await setup("cascade");
    // Bob's task moves out first, so only Alice's is left to cascade.
    const { updateRecord } = await import("../core/records.ts");
    await updateRecord("tasks", theirs.id, { project: null }, null);
    expect((await del(`/projects/${project.id}`)).status).toBe(200);
    expect(await getRecord("tasks", mine.id)).toBeNull();
  });
});

describe("restrict refusals don't name hidden collections", () => {
  it("a batch delete blocked by restrict answers 409 without the referencing collection", async () => {
    await createCollection({
      name: "projects", fields: JSON.stringify([{ name: "owner", type: "text" }]),
      list_rule: null, view_rule: null, delete_rule: "owner = @request.auth.id",
    });
    await createCollection({
      name: "secret_audits",
      fields: JSON.stringify([{ name: "project", type: "relation", collection: "projects", options: { cascade: "restrict" } }]),
    });
    const project = await createRecord("projects", { owner: alice }, null);
    await createRecord("secret_audits", { project: project.id }, null);
    const batch = (auth: string) => makeBatchPlugin(SECRET).handle(new Request("http://localhost/batch", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
      body: JSON.stringify({ requests: [{ method: "DELETE", url: `/api/v1/projects/${project.id}` }] }),
    }));
    const res = await batch(aliceJwt);
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).not.toContain("secret_audits");
    expect(await getRecord("projects", project.id)).not.toBeNull();

    // Admins still get the details.
    const { signAuthToken } = await import("../core/sec.ts");
    const { getDb } = await import("../db/client.ts");
    const { admin } = await import("../db/schema.ts");
    await getDb().insert(admin).values({ id: "a1", email: "a1@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
    const { token } = await signAuthToken({ payload: { id: "a1" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET });
    const adminRes = await batch(token);
    expect(adminRes.status).toBe(409);
    expect(JSON.stringify(await adminRes.json())).toContain("secret_audits");
  });
});
