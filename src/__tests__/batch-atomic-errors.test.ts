/**
 * A write batch is all or nothing for every kind of failure. A missing record
 * or collection used to come back as a per-op 404 while the ops before it
 * committed; it now rolls the whole batch back, like a validation error does.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createRecord, listRecords } from "../core/records.ts";
import { makeBatchPlugin } from "../api/batch.ts";
import { createPublicCollection } from "./_helpers.ts";

const SECRET = "test-secret-batch-atomic";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  await createPublicCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
});

afterEach(async () => { await closeDb(); });

const batch = (requests: unknown[]) => makeBatchPlugin(SECRET).handle(new Request("http://localhost/batch", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requests }),
}));

const titles = async () => (await listRecords("posts", { perPage: 100 })).data.map((r) => (r as unknown as { title: string }).title).sort();

describe("write batch atomicity", () => {
  it("rolls back when a later op patches a missing record", async () => {
    const res = await batch([
      { method: "POST", url: "/api/v1/posts", body: { title: "kept?" } },
      { method: "PATCH", url: "/api/v1/posts/does-not-exist", body: { title: "x" } },
    ]);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("request 1");
    expect(await titles()).toEqual([]);
  });

  it("rolls back when a later op deletes a missing record", async () => {
    const res = await batch([
      { method: "POST", url: "/api/v1/posts", body: { title: "a" } },
      { method: "DELETE", url: "/api/v1/posts/does-not-exist" },
    ]);
    expect(res.status).toBe(404);
    expect(await titles()).toEqual([]);
  });

  it("rolls back when a later op names a missing collection", async () => {
    const r = await createRecord("posts", { title: "before" }, null);
    const res = await batch([
      { method: "PATCH", url: `/api/v1/posts/${r.id}`, body: { title: "after" } },
      { method: "POST", url: "/api/v1/nope", body: {} },
    ]);
    expect(res.status).toBe(404);
    expect(await titles()).toEqual(["before"]);
  });

  it("rolls back when a get inside a write batch misses", async () => {
    const res = await batch([
      { method: "POST", url: "/api/v1/posts", body: { title: "a" } },
      { method: "GET", url: "/api/v1/posts/does-not-exist" },
    ]);
    expect(res.status).toBe(404);
    expect(await titles()).toEqual([]);
  });

  it("commits when every op succeeds", async () => {
    const res = await batch([
      { method: "POST", url: "/api/v1/posts", body: { title: "a" } },
      { method: "POST", url: "/api/v1/posts", body: { title: "b" } },
    ]);
    expect(res.status).toBe(200);
    expect(await titles()).toEqual(["a", "b"]);
  });

  it("a read-only batch still reports a miss per op", async () => {
    const res = await batch([{ method: "GET", url: "/api/v1/posts/does-not-exist" }]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: Array<{ status: number }> }).data[0]!.status).toBe(404);
  });
});
