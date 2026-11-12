/**
 * Two things an offline client needs to sync safely.
 *
 * A create may bring its own `id` (a UUID). Until 0.46 the id was dropped in
 * silence and replaced, so a client that made records while offline went on
 * referring to ids the server never had.
 *
 * A create sent with `X-VB-Idempotency-Key` runs once: the same key again
 * answers with the first record. The header was in the CORS defaults for a
 * long time and did nothing.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, getCollection, updateCollection, _resetCollectionCache } from "../core/collections.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { makeBatchPlugin } from "../api/batch.ts";
import { pruneIdempotencyKeys } from "../api/idempotency.ts";
import { seedAuthUser, signUserJwt } from "./_helpers.ts";

const SECRET = "test-secret-client-ids";
const ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  _resetCollectionCache();
  for (const name of ["notes", "tasks"]) {
    await createCollection({
      name, type: "base", fields: JSON.stringify([{ name: "title", type: "text", required: true }]),
      list_rule: null, view_rule: null, create_rule: null, update_rule: null, delete_rule: null,
    });
  }
  await createCollection({
    name: "private", type: "base", fields: JSON.stringify([{ name: "title", type: "text" }]),
    list_rule: null, view_rule: null, create_rule: `@request.auth.id != ""`,
  });
  _resetCollectionCache();
});
afterEach(() => closeDb());

type Json = { data?: Record<string, unknown> | null; error?: string; code?: number; details?: Record<string, string> };

async function send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await makeRecordsPlugin(SECRET).handle(new Request(`http://localhost${path}`, {
    method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));
  return { status: res.status, replay: res.headers.get("vaultbase-idempotent-replay"), json: (await res.json()) as Json };
}
const create = (collection: string, body: unknown, headers: Record<string, string> = {}) => send("POST", `/${collection}`, body, headers);
const count = async (collection: string) => Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM vb_${collection}`))!.n);
const keys = async () => Number((await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM vaultbase_idempotency_keys`))!.n);

describe("a create with the client's own id", () => {
  it("keeps the id", async () => {
    const res = await create("notes", { id: ID, title: "offline" });
    expect(res.status).toBe(200);
    expect(res.json.data?.["id"]).toBe(ID);
    expect((await send("GET", `/notes/${ID}`)).json.data?.["title"]).toBe("offline");
  });

  it("makes one itself when none is sent", async () => {
    const res = await create("notes", { title: "plain" });
    expect(String(res.json.data?.["id"])).toMatch(UUID);
  });

  it("answers 409 when the id is taken, so a retried create is recognisable", async () => {
    expect((await create("notes", { id: ID, title: "first" })).status).toBe(200);
    const again = await create("notes", { id: ID.toUpperCase(), title: "second" });
    expect([again.status, again.json]).toEqual([409, { error: "A record with this id already exists", code: 409 }]);
    expect(await count("notes")).toBe(1);
    // The same id in another collection is another record.
    expect((await create("tasks", { id: ID, title: "other" })).status).toBe(200);
  });

  it("answers 422 for an id that isn't a UUID", async () => {
    const res = await create("notes", { id: "note-1", title: "x" });
    expect(res.status).toBe(422);
    expect(res.json.details).toEqual({ id: "id must be a UUID, for example 0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b" });
    expect(await count("notes")).toBe(0);
  });

  it("refuses the id of a deleted record whose history is kept", async () => {
    await updateCollection((await getCollection("notes"))!.id, { history_enabled: 1 });
    await updateCollection((await getCollection("tasks"))!.id, { history_enabled: 0 });
    _resetCollectionCache();
    for (const c of ["notes", "tasks"]) {
      expect((await create(c, { id: ID, title: "v1" })).status).toBe(200);
      expect((await send("DELETE", `/${c}/${ID}`)).status).toBe(200);
    }
    const kept = await create("notes", { id: ID, title: "v2" });
    expect([kept.status, kept.json.error]).toEqual([409, "This id belonged to a record that was deleted; use a new id"]);
    // No history, nothing to inherit: the id is free again.
    expect((await create("tasks", { id: ID, title: "v2" })).status).toBe(200);
  });

  it("works for creates in a batch", async () => {
    const batch = async (requests: unknown[]) => {
      const res = await makeBatchPlugin(SECRET).handle(new Request("http://localhost/batch", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requests }),
      }));
      return { status: res.status, json: (await res.json()) as { data?: Array<{ status: number; body: { id: string } }>; error?: string } };
    };
    const ok = await batch([{ method: "POST", url: "/api/v1/notes", body: { id: ID, title: "in a batch" } }]);
    expect([ok.status, ok.json.data?.[0]?.body.id]).toEqual([200, ID]);
    const taken = await batch([
      { method: "POST", url: "/api/v1/notes", body: { title: "rolled back with the rest" } },
      { method: "POST", url: "/api/v1/notes", body: { id: ID, title: "again" } },
    ]);
    expect([taken.status, taken.json.error]).toEqual([409, "Batch failed at request 1: A record with this id already exists"]);
    expect(await count("notes")).toBe(1);
  });
});

describe("a create with X-VB-Idempotency-Key", () => {
  const KEY = { "x-vb-idempotency-key": "5f1c9a1e-order-42" };

  it("runs once: the same key again answers with the first record", async () => {
    const first = await create("notes", { title: "once" }, KEY);
    expect([first.status, first.replay]).toEqual([200, null]);
    const again = await create("notes", { title: "once" }, KEY);
    expect([again.status, again.replay]).toEqual([200, "true"]);
    expect(again.json.data?.["id"]).toBe(first.json.data?.["id"]);
    expect(await count("notes")).toBe(1);
  });

  it("answers with the record as it is now", async () => {
    const first = await create("notes", { title: "draft" }, KEY);
    await send("PATCH", `/notes/${String(first.json.data?.["id"])}`, { title: "edited" });
    expect((await create("notes", { title: "draft" }, KEY)).json.data?.["title"]).toBe("edited");
  });

  it("answers 404 once that record is deleted, and doesn't make it again", async () => {
    const first = await create("notes", { title: "gone" }, KEY);
    await send("DELETE", `/notes/${String(first.json.data?.["id"])}`);
    const again = await create("notes", { title: "gone" }, KEY);
    expect([again.status, again.replay, again.json.error]).toEqual([404, "true", "Record not found"]);
    expect(await count("notes")).toBe(0);
  });

  it("answers 422 for the same key with another body", async () => {
    await create("notes", { title: "one" }, KEY);
    const other = await create("notes", { title: "two" }, KEY);
    expect([other.status, other.json.error]).toEqual([422, "This idempotency key was already used with a different request body"]);
    // Key order in the body doesn't make it another body.
    await create("tasks", { title: "t", id: ID }, KEY);
    expect((await create("tasks", { id: ID, title: "t" }, KEY)).replay).toBe("true");
  });

  it("is per collection and per caller", async () => {
    const userId = await seedAuthUser({ collection: "users", email: "ada@example.com" });
    const asUser = { ...KEY, authorization: `Bearer ${await signUserJwt(userId, "ada@example.com", "users", SECRET)}` };
    const a = await create("notes", { title: "same" }, KEY);
    const b = await create("tasks", { title: "same" }, KEY);
    const c = await create("notes", { title: "same" }, asUser);
    expect([a.replay, b.replay, c.replay]).toEqual([null, null, null]);
    expect([await count("notes"), await count("tasks")]).toEqual([2, 1]);
    expect((await create("notes", { title: "same" }, asUser)).json.data?.["id"]).toBe(c.json.data?.["id"]);
  });

  it("keeps the client's id, and a repeat answers 200 where a bare retry would answer 409", async () => {
    const first = await create("notes", { id: ID, title: "mine" }, KEY);
    expect(first.json.data?.["id"]).toBe(ID);
    const again = await create("notes", { id: ID, title: "mine" }, KEY);
    expect([again.status, again.replay, again.json.data?.["id"]]).toEqual([200, "true", ID]);
  });

  it("frees the key when the create fails, so a corrected request runs", async () => {
    expect((await create("notes", {}, KEY)).status).toBe(422);
    expect(await keys()).toBe(0);
    const fixed = await create("notes", { title: "fixed" }, KEY);
    expect([fixed.status, fixed.replay]).toEqual([200, null]);
  });

  it("claims nothing for a caller the create rule refuses", async () => {
    expect((await create("private", { title: "x" }, KEY)).status).toBe(403);
    expect(await keys()).toBe(0);
  });

  it("answers 400 for an empty or oversized key", async () => {
    for (const key of ["  ", "k".repeat(256)]) {
      const res = await create("notes", { title: "x" }, { "x-vb-idempotency-key": key });
      expect([res.status, res.json.error]).toEqual([400, "X-VB-Idempotency-Key must be 1 to 255 characters"]);
    }
    expect(await count("notes")).toBe(0);
  });

  it("a request that died: a quick retry waits, a later one finishes the create under the same id", async () => {
    const first = await create("notes", { title: "crash" }, KEY);
    const id = String(first.json.data?.["id"]);
    // As if the server stopped after claiming the key, before the insert.
    await db.run(`DELETE FROM vb_notes WHERE id = ?`, [id]);
    await db.run(`UPDATE vaultbase_idempotency_keys SET done = 0`);
    const soon = await create("notes", { title: "crash" }, KEY);
    expect([soon.status, soon.json.error]).toEqual([409, "A request with this idempotency key is still running"]);
    await db.run(`UPDATE vaultbase_idempotency_keys SET created_at = created_at - 300`);
    const later = await create("notes", { title: "crash" }, KEY);
    expect([later.status, later.replay, later.json.data?.["id"]]).toEqual([200, null, id]);
    expect(await count("notes")).toBe(1);
    // As if it stopped after the insert, before marking the key done.
    await db.run(`UPDATE vaultbase_idempotency_keys SET done = 0`);
    const found = await create("notes", { title: "crash" }, KEY);
    expect([found.status, found.replay, found.json.data?.["id"]]).toEqual([200, "true", id]);
    expect(await count("notes")).toBe(1);
  });

  it("is forgotten after a day", async () => {
    await create("notes", { title: "old" }, KEY);
    await db.run(`UPDATE vaultbase_idempotency_keys SET created_at = created_at - ?`, [24 * 60 * 60 + 5]);
    // Past its day but not pruned yet: already free.
    expect((await create("notes", { title: "old" }, KEY)).replay).toBeNull();
    expect(await count("notes")).toBe(2);
    await db.run(`UPDATE vaultbase_idempotency_keys SET created_at = created_at - ?`, [24 * 60 * 60 + 5]);
    expect(await pruneIdempotencyKeys()).toBe(1);
    expect(await keys()).toBe(0);
  });
});
