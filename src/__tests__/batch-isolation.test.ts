import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { hooks } from "../db/schema.ts";
import { createCollection } from "../core/collections.ts";
import { createRecord, listRecords } from "../core/records.ts";
import { invalidateHookCache } from "../core/hooks.ts";
import { makeBatchPlugin } from "../api/batch.ts";
import { _reset as resetRealtime, setSSESubscriptions } from "../realtime/manager.ts";
import { openSSEStream } from "../realtime/sse.ts";
import { createPublicCollection } from "./_helpers.ts";

// /batch ran BEGIN ... COMMIT on the single shared connection and awaited
// hooks in between, so writes from other requests landed inside the batch's
// transaction and were rolled back with it; a second concurrent batch
// failed with "cannot start a transaction within a transaction"; and
// realtime / webhook / after-hook side effects fired for rows that were
// then rolled back.

const SECRET = "test-secret-batch-isolation";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  await createPublicCollection({ name: "slow", fields: JSON.stringify([{ name: "v", type: "text" }]) });
  await createPublicCollection({
    name: "posts",
    fields: JSON.stringify([{ name: "title", type: "text", required: true }]),
  });
  // A slow beforeCreate hook gives other requests a window to interleave.
  await getDb().insert(hooks).values({
    id: "h1", name: "slow", collection_name: "slow", event: "beforeCreate", enabled: 1,
    code: "await new Promise((r) => setTimeout(r, 200));",
  });
  invalidateHookCache();
  resetRealtime();
});

afterEach(() => {
  invalidateHookCache();
  closeDb();
});

function batch(requests: Array<{ method: string; url: string; body?: unknown }>) {
  return makeBatchPlugin(SECRET).handle(new Request("http://localhost/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requests }),
  }));
}

const FAILING_BATCH = [
  { method: "POST", url: "/api/v1/slow", body: { v: "x" } },
  { method: "POST", url: "/api/v1/posts", body: {} }, // missing required title → rollback
];

describe("batch transaction isolation", () => {
  it("a write from another request survives a failing batch", async () => {
    const batchDone = batch(FAILING_BATCH);
    await Bun.sleep(50); // batch is now inside its slow hook, transaction open
    await createRecord("posts", { title: "independent" });
    const res = await batchDone;
    expect(res.status).toBe(422);
    const posts = await listRecords("posts");
    expect(posts.data.map((p) => p["title"])).toEqual(["independent"]);
  });

  it("two concurrent batches both succeed", async () => {
    const ok = [{ method: "POST", url: "/api/v1/slow", body: { v: "y" } }];
    const [a, b] = await Promise.all([batch(ok), batch(ok)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((await listRecords("slow")).totalItems).toBe(2);
  });

  it("realtime events fire only for committed batches", async () => {
    const { response, clientId } = openSSEStream();
    setSSESubscriptions(clientId, ["slow"]);
    // One reader for the whole test; collect frames as they arrive.
    const reader = response.body!.getReader();
    const dec = new TextDecoder();
    let received = "";
    void (async () => {
      for (;;) {
        const r = await reader.read();
        if (r.done) return;
        received += dec.decode(r.value);
      }
    })();

    expect((await batch(FAILING_BATCH)).status).toBe(422);
    await Bun.sleep(100);
    expect(received).not.toContain('"type":"create"');

    expect((await batch([{ method: "POST", url: "/api/v1/slow", body: { v: "ok" } }])).status).toBe(200);
    await Bun.sleep(100);
    expect(received).toContain('"type":"create"');
    void reader.cancel();
  });
});
