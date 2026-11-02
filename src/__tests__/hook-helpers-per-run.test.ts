/**
 * Each hook run gets its own helpers, made when a hook runs: every record
 * write used to make a full set it never used, whether the collection had
 * hooks or not. Shared ones would let one script change them for the next
 * (and frozen ones break the time-limit guard's proxy).
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, _resetCollectionCache } from "../core/collections.ts";
import { createRecord, getRecord } from "../core/records.ts";
import { invalidateHookCache } from "../core/hooks.ts";
import { hooks } from "../db/schema.ts";

const now = () => Math.floor(Date.now() / 1000);

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  invalidateHookCache();
});

afterEach(async () => {
  _resetCollectionCache();
  invalidateHookCache();
  await closeDb();
});

describe("hook helpers", () => {
  it("one hook can't change them for the next", async () => {
    await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }, { name: "seen", type: "text" }]) });
    await getDb().insert(hooks).values({
      id: crypto.randomUUID(), name: "meddle", collection_name: "posts", event: "beforeCreate", enabled: 1, created_at: now(), updated_at: now(),
      code: `const h = ctx.helpers; if (ctx.record.title === "one") { h.util.planted = "x"; h.sql.query = () => "hijacked"; } else { ctx.record.seen = typeof h.util.planted + "/" + String(h.sql.query).includes("hijacked"); }`,
    });
    invalidateHookCache();
    await createRecord("posts", { title: "one" });
    const second = await createRecord("posts", { title: "two" });
    expect((await getRecord("posts", second.id))?.["seen"]).toBe("undefined/false");
  });
});
