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
import { db } from "../db/index.ts";

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

  it("checks each version with the request's own values, parsing the rule once", async () => {
    const alice = await seedAuthUser({ collection: "users", email: "alice@test.local" });
    const c = await createCollection({
      name: "notes",
      fields: JSON.stringify([{ name: "team", type: "text" }, { name: "body", type: "text" }]),
      view_rule: "team = @request.headers.x_team",
    });
    await updateCollection(c.id, { history_enabled: 1 } as Parameters<typeof updateCollection>[1]);
    const rec = await createRecord("notes", { team: "red", body: "v1" }, null);
    await updateRecord("notes", rec.id, { team: "blue", body: "v2" }, null);
    await updateRecord("notes", rec.id, { team: "red", body: "v3" }, null);
    const jwt = await signUserJwt(alice, "alice@test.local", "users", SECRET);
    const res = await makeRecordsPlugin(SECRET).handle(new Request(`http://localhost/notes/${rec.id}/history`, {
      headers: { authorization: `Bearer ${jwt}`, "x-team": "red" },
    }));
    const body = await res.json() as { data: { data: Array<{ snapshot: Record<string, unknown> }>; totalItems: number } };
    expect(body.data.data.map((e) => e.snapshot["body"]).sort()).toEqual(["v1", "v3"]);
    expect(body.data.totalItems).toBe(2);
  });

  it("pages in the database when there's no view rule", async () => {
    // Every version passes, so non-admins don't read up to 2,000 of them to
    // check each one; that read also stopped counting at 2,000.
    const alice = await seedAuthUser({ collection: "users", email: "alice@test.local" });
    const c = await createCollection({
      name: "notes",
      fields: JSON.stringify([{ name: "body", type: "text" }]),
      view_rule: null,
    });
    await updateCollection(c.id, { history_enabled: 1 } as Parameters<typeof updateCollection>[1]);
    const rec = await createRecord("notes", { body: "v0" }, null);
    await db.transaction(async () => {
      for (let i = 1; i <= 2_000; i++) {
        await db.run(
          `INSERT INTO vaultbase_record_history (id, collection, record_id, op, snapshot, at, seq) VALUES (?, 'notes', ?, 'update', ?, ?, ?)`,
          [crypto.randomUUID(), rec.id, JSON.stringify({ id: rec.id, body: `v${i}` }), 1_000 + i, i],
        );
      }
    });
    const jwt = await signUserJwt(alice, "alice@test.local", "users", SECRET);
    const res = await makeRecordsPlugin(SECRET).handle(new Request(`http://localhost/notes/${rec.id}/history?perPage=5&page=2`, {
      headers: { authorization: `Bearer ${jwt}` },
    }));
    const body = await res.json() as { data: { data: unknown[]; totalItems: number } };
    expect(body.data.data).toHaveLength(5);
    expect(body.data.totalItems).toBe(2_001);
  });
});
