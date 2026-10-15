/**
 * autodate fields are server-managed timestamps. They used to be computed
 * and then skipped on insert and update, with no column at all, so they
 * were never stored.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache, getCollection, updateCollection } from "../core/collections.ts";
import { createRecord, getRecord, updateRecord, listRecords } from "../core/records.ts";
import { createPublicCollection } from "./_helpers.ts";

const fields = JSON.stringify([
  { name: "title", type: "text" },
  { name: "published_at", type: "autodate", onCreate: true, onUpdate: false },
  { name: "touched_at", type: "autodate", onCreate: true, onUpdate: true },
  { name: "never", type: "autodate" },
]);

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  await createPublicCollection({ name: "posts", fields });
});

afterEach(() => {
  _resetCollectionCache();
  closeDb();
});

describe("autodate", () => {
  it("is stored on create and refreshed on update only when it opts in", async () => {
    const before = Math.floor(Date.now() / 1000);
    const rec = await createRecord("posts", { title: "a" });
    const stored = (await getRecord("posts", rec.id))!;
    expect(stored["published_at"]).toBeGreaterThanOrEqual(before);
    expect(stored["touched_at"]).toBeGreaterThanOrEqual(before);
    expect(stored["never"]).toBeNull();
    getRawClient().prepare(`UPDATE "vb_posts" SET "touched_at" = 1, "published_at" = 1 WHERE "id" = ?`).run(rec.id);
    await updateRecord("posts", rec.id, { title: "b" });
    const after = (await getRecord("posts", rec.id))!;
    expect(after["published_at"]).toBe(1);
    expect(after["touched_at"]).toBeGreaterThanOrEqual(before);
  });

  it("ignores a value the client sends", async () => {
    const rec = await createRecord("posts", { title: "a", published_at: 5, never: 7 });
    const stored = (await getRecord("posts", rec.id))!;
    expect(stored["published_at"]).not.toBe(5);
    expect(stored["never"]).toBeNull();
    await updateRecord("posts", rec.id, { never: 9, published_at: 3 });
    const after = (await getRecord("posts", rec.id))!;
    expect(after["never"]).toBeNull();
    expect(after["published_at"]).toBe(stored["published_at"]);
  });

  it("can be filtered and sorted like a date, and added or removed later", async () => {
    const rec = await createRecord("posts", { title: "a" });
    const hit = await listRecords("posts", { filter: "published_at <= @now", sort: "-touched_at" });
    expect(hit.data.map((r) => r.id)).toEqual([rec.id]);
    const col = (await getCollection("posts"))!;
    await updateCollection(col.id, { fields: JSON.stringify([...JSON.parse(fields), { name: "seen_at", type: "autodate", onUpdate: true }]) });
    await updateRecord("posts", rec.id, { title: "c" });
    expect((await getRecord("posts", rec.id))!["seen_at"]).toBeGreaterThan(0);
  });

  it("gets its column at boot on a collection created before the fix", async () => {
    getRawClient().exec(`ALTER TABLE "vb_posts" DROP COLUMN "published_at"`);
    await runMigrations();
    const cols = (getRawClient().query(`PRAGMA table_info("vb_posts")`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("published_at");
  });
});
