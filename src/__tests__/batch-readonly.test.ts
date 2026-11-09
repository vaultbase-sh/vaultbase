/**
 * A batch that only reads took the exclusive write gate, waiting for every
 * write in flight and blocking all writes until it finished. Read-only
 * batches now run without it.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createRecord } from "../core/records.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { makeBatchPlugin } from "../api/batch.ts";
import { hooks } from "../db/schema.ts";
import { invalidateHookCache } from "../core/hooks.ts";
import { createPublicCollection } from "./_helpers.ts";
import { freshGate, dropGate } from "./_wait.ts";

const SECRET = "test-secret-batch-readonly";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  await createPublicCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
});

afterEach(async () => { invalidateHookCache(); await closeDb(); });

const batch = (requests: unknown[]) => makeBatchPlugin(SECRET).handle(new Request("http://localhost/batch", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requests }),
}));

describe("read-only batches", () => {
  it("don't wait behind a write in flight", async () => {
    const r = await createRecord("posts", { title: "a" }, null);
    const g = freshGate("batch-readonly");
    await getDb().insert(hooks).values({
      id: "h-slow", name: "slow", collection_name: "posts", event: "beforeUpdate", enabled: 1,
      code: "await globalThis.__gate('batch-readonly').arrive();",
    });
    invalidateHookCache();
    // Safety net: a batch stuck behind the write would otherwise hang here.
    const release = setTimeout(() => g.open(), 3000);
    try {
      const slow = makeRecordsPlugin(SECRET).handle(new Request(`http://localhost/posts/${r.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "b" }),
      }));
      await g.waitReached(); // the PATCH is inside its hook, write in flight
      const res = await batch([{ method: "GET", url: "/api/v1/posts" }, { method: "GET", url: `/api/v1/posts/${r.id}` }]);
      // The batch finished while the write was still held.
      const finishedWhileHeld = !g.isOpen;
      g.open();
      expect(res.status).toBe(200);
      const body = await res.json() as { data: unknown[] };
      expect(body.data).toHaveLength(2);
      expect(finishedWhileHeld).toBe(true);
      expect((await slow).status).toBe(200);
    } finally {
      clearTimeout(release);
      dropGate("batch-readonly");
    }
  });

  it("still report errors per request (legitimate path)", async () => {
    const res = await batch([{ method: "GET", url: "/api/v1/posts?filter=" + encodeURIComponent("nope ===") }]);
    expect(res.status).toBe(400);
  });
});
