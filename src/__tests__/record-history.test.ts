import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, updateCollection } from "../core/collections.ts";
import { createRecord, updateRecord, deleteRecord } from "../core/records.ts";
import {
  listRecordHistory,
  getHistoryAt,
  pruneHistoryOlderThan,
} from "../core/record-history.ts";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

const FIELDS = [{ name: "title", type: "text" }, { name: "body", type: "text" }];

describe("record history — opt-in", () => {
  it("does NOT record when history_enabled is 0 (default)", async () => {
    await createCollection({ name: "posts", fields: JSON.stringify(FIELDS) });
    const r = await createRecord("posts", { title: "a", body: "b" }, null);
    await updateRecord("posts", r.id, { title: "a2" }, null);
    await deleteRecord("posts", r.id, null);
    const list = await listRecordHistory("posts", r.id);
    expect(list.totalItems).toBe(0);
  });
});

describe("record history — enabled", () => {
  async function withHistory() {
    const c = await createCollection({ name: "posts", fields: JSON.stringify(FIELDS) });
    await updateCollection(c.id, { history_enabled: 1 } as Parameters<typeof updateCollection>[1]);
  }

  it("records create / update / delete in order", async () => {
    await withHistory();
    const r = await createRecord("posts", { title: "v1", body: "b1" }, null);
    await updateRecord("posts", r.id, { title: "v2" }, null);
    await updateRecord("posts", r.id, { title: "v3" }, null);
    await deleteRecord("posts", r.id, null);
    const list = await listRecordHistory("posts", r.id);
    expect(list.totalItems).toBe(4);
    // ordered DESC by `at` — but sub-second writes can tie; assert ops set + count.
    const ops = list.data.map((e) => e.op).sort();
    expect(ops).toEqual(["create", "delete", "update", "update"]);
  });

  it("records actor when auth context is provided", async () => {
    await withHistory();
    const r = await createRecord("posts", { title: "x", body: "y" }, { id: "u-42", type: "user", email: "x@y.z" });
    const list = await listRecordHistory("posts", r.id);
    expect(list.data[0]?.actor_id).toBe("u-42");
    expect(list.data[0]?.actor_type).toBe("user");
  });

  it("records null actor when no auth context", async () => {
    await withHistory();
    const r = await createRecord("posts", { title: "x", body: "y" }, null);
    const list = await listRecordHistory("posts", r.id);
    expect(list.data[0]?.actor_id).toBeNull();
    expect(list.data[0]?.actor_type).toBeNull();
  });

  it("snapshot reflects post-write state on update", async () => {
    await withHistory();
    const r = await createRecord("posts", { title: "v1", body: "b1" }, null);
    await updateRecord("posts", r.id, { title: "v2" }, null);
    const list = await listRecordHistory("posts", r.id);
    const updates = list.data.filter((e) => e.op === "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.snapshot["title"]).toBe("v2");
    expect(updates[0]?.snapshot["body"]).toBe("b1");
  });

  it("snapshot on delete captures pre-delete state", async () => {
    await withHistory();
    const r = await createRecord("posts", { title: "to-die", body: "z" }, null);
    await deleteRecord("posts", r.id, null);
    const list = await listRecordHistory("posts", r.id);
    const del = list.data.find((e) => e.op === "delete");
    expect(del?.snapshot["title"]).toBe("to-die");
    expect(del?.snapshot["body"]).toBe("z");
  });

  it("getHistoryAt returns the most recent entry at-or-before cutoff", async () => {
    await withHistory();
    const r = await createRecord("posts", { title: "v1", body: "b1" }, null);
    const t0 = Math.floor(Date.now() / 1000);
    // Wait so the next write has a strictly later `at` (1-second resolution).
    await new Promise((res) => setTimeout(res, 1100));
    await updateRecord("posts", r.id, { title: "v2" }, null);
    const before = await getHistoryAt("posts", r.id, t0);
    expect(before?.snapshot["title"]).toBe("v1");
    const after = await getHistoryAt("posts", r.id, Math.floor(Date.now() / 1000));
    expect(after?.snapshot["title"]).toBe("v2");
    const ancient = await getHistoryAt("posts", r.id, t0 - 1000);
    expect(ancient).toBeNull();
  });

  it("pruneHistoryOlderThan deletes ancient rows", async () => {
    await withHistory();
    const r = await createRecord("posts", { title: "v1", body: "b1" }, null);
    expect((await listRecordHistory("posts", r.id)).totalItems).toBe(1);
    const future = Math.floor(Date.now() / 1000) + 100;
    const removed = await pruneHistoryOlderThan(future);
    expect(removed).toBe(1);
    expect((await listRecordHistory("posts", r.id)).totalItems).toBe(0);
  });
});
