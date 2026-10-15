import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { hooks } from "../db/schema.ts";
import { createCollection } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { invalidateHookCache } from "../core/hooks.ts";

// Enabled hooks / webhooks are cached for ~1 s (they were most of a record
// write's cost). A change made in this process must apply at once; a change
// written by another cluster worker (here: straight to the DB, no
// invalidation) must apply once the cache expires, new code included.

const g = globalThis as unknown as { __hookTag?: string | undefined };

async function setHook(code: string, updatedAt: number) {
  await getDb().insert(hooks).values({
    id: "h1", name: "tag", collection_name: "posts", event: "beforeCreate", code,
    enabled: 1, created_at: updatedAt, updated_at: updatedAt,
  }).onConflictDoUpdate({ target: hooks.id, set: { code, updated_at: updatedAt } });
}

beforeEach(async () => {
  g.__hookTag = undefined;
  await initDb(":memory:");
  await runMigrations();
  await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
  invalidateHookCache();
});

afterEach(async () => {
  invalidateHookCache();
  await closeDb();
});

describe("hook lookup cache", () => {
  it("a local change with invalidation applies immediately", async () => {
    await setHook(`globalThis.__hookTag = "v1";`, 1);
    invalidateHookCache();
    await createRecord("posts", { title: "a" });
    expect(g.__hookTag).toBe("v1");
  });

  it("an edit from another worker (no invalidation) applies after expiry, with the new code", async () => {
    await setHook(`globalThis.__hookTag = "v1";`, 1);
    invalidateHookCache();
    await createRecord("posts", { title: "a" });
    expect(g.__hookTag).toBe("v1");

    // Another process edits the hook: new code, newer updated_at, no invalidation here.
    await getDb().update(hooks).set({ code: `globalThis.__hookTag = "v2";`, updated_at: 2 }).where(eq(hooks.id, "h1"));
    await Bun.sleep(1100);
    await createRecord("posts", { title: "b" });
    expect(g.__hookTag).toBe("v2");
  });
});
