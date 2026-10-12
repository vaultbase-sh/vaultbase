/**
 * `If-Match` was checked before the write and then hooks, validation and
 * the write itself awaited in turn, so several requests carrying the same
 * ETag could all pass the check and all write — a lost update the header
 * exists to prevent. The write now re-checks inside its own critical step.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createRecord } from "../core/records.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { createPublicCollection } from "./_helpers.ts";

const SECRET = "test-secret-etag-atomic";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  await createPublicCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
});

afterEach(() => closeDb());

const app = () => makeRecordsPlugin(SECRET);

async function etagOf(id: string): Promise<string> {
  return (await app().handle(new Request(`http://localhost/posts/${id}`))).headers.get("etag")!;
}

describe("If-Match is atomic with the write", () => {
  it("of several PATCHes with the same ETag, exactly one wins", async () => {
    const r = await createRecord("posts", { title: "v0" }, null);
    const etag = await etagOf(r.id);
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      app().handle(new Request(`http://localhost/posts/${r.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "if-match": etag },
        body: JSON.stringify({ title: `writer-${i}` }),
      }))));
    const statuses = results.map((x) => x.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 412)).toHaveLength(5);
  });

  it("a PATCH and a DELETE with the same ETag: only one happens", async () => {
    const r = await createRecord("posts", { title: "v0" }, null);
    const etag = await etagOf(r.id);
    const [patch, del] = await Promise.all([
      app().handle(new Request(`http://localhost/posts/${r.id}`, {
        method: "PATCH", headers: { "content-type": "application/json", "if-match": etag }, body: JSON.stringify({ title: "edited" }),
      })),
      app().handle(new Request(`http://localhost/posts/${r.id}`, { method: "DELETE", headers: { "if-match": etag } })),
    ]);
    expect([patch.status, del.status].filter((s) => s === 412)).toHaveLength(1);
  });

  it("a single conditional PATCH still works (legitimate path)", async () => {
    const r = await createRecord("posts", { title: "v0" }, null);
    const res = await app().handle(new Request(`http://localhost/posts/${r.id}`, {
      method: "PATCH", headers: { "content-type": "application/json", "if-match": await etagOf(r.id) }, body: JSON.stringify({ title: "v1" }),
    }));
    expect(res.status).toBe(200);
  });
});
