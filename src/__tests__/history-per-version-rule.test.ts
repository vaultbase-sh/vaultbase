/**
 * Record history was readable by anyone who passed the view rule against
 * the record *as it is now*. When a record changes hands (an `owner` field
 * reassigned), the new owner could read every earlier version — the previous
 * owner's data included. Each version is now checked against the view rule
 * as that version stood, and other people's actor ids are hidden.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, updateCollection } from "../core/collections.ts";
import { createRecord, updateRecord } from "../core/records.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { seedAuthUser, signUserJwt } from "./_helpers.ts";

const SECRET = "test-secret-history-rule";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

async function history(id: string, jwt: string) {
  const res = await makeRecordsPlugin(SECRET).handle(new Request(`http://localhost/notes/${id}/history`, {
    headers: { authorization: `Bearer ${jwt}` },
  }));
  return { status: res.status, body: await res.json() as { data: { data: Array<{ snapshot: Record<string, unknown>; actor_id: string | null }> } } };
}

describe("record history", () => {
  it("a new owner doesn't see versions from before the handover", async () => {
    const alice = await seedAuthUser({ collection: "users", email: "alice@test.local" });
    const bob = await seedAuthUser({ collection: "users", email: "bob@test.local" });
    const c = await createCollection({
      name: "notes",
      fields: JSON.stringify([{ name: "owner", type: "text" }, { name: "body", type: "text" }]),
      view_rule: "owner = @request.auth.id",
    });
    await updateCollection(c.id, { history_enabled: 1 } as Parameters<typeof updateCollection>[1]);
    const rec = await createRecord("notes", { owner: alice, body: "alice's diary" }, null);
    await updateRecord("notes", rec.id, { owner: bob, body: "handed to bob" }, null);

    const { status, body } = await history(rec.id, await signUserJwt(bob, "bob@test.local", "users", SECRET));
    expect(status).toBe(200);
    const bodies = body.data.data.map((e) => e.snapshot["body"]);
    expect(bodies).toContain("handed to bob");
    expect(bodies).not.toContain("alice's diary");
  });

  it("the owner still sees their own versions (legitimate path)", async () => {
    const alice = await seedAuthUser({ collection: "users", email: "alice@test.local" });
    const c = await createCollection({
      name: "notes",
      fields: JSON.stringify([{ name: "owner", type: "text" }, { name: "body", type: "text" }]),
      view_rule: "owner = @request.auth.id",
    });
    await updateCollection(c.id, { history_enabled: 1 } as Parameters<typeof updateCollection>[1]);
    const rec = await createRecord("notes", { owner: alice, body: "v1" }, null);
    await updateRecord("notes", rec.id, { owner: alice, body: "v2" }, { id: "someone-else", type: "user" });
    const { body } = await history(rec.id, await signUserJwt(alice, "alice@test.local", "users", SECRET));
    expect(body.data.data.map((e) => e.snapshot["body"]).sort()).toEqual(["v1", "v2"]);
    // Who else edited it isn't the caller's business.
    expect(body.data.data.map((e) => e.actor_id)).not.toContain("someone-else");
  });
});
