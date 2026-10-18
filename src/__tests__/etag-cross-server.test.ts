/**
 * If-Match across servers. Several servers on one Postgres each held only
 * their own per-record lock, so two PATCHes with the same ETag on two
 * servers both passed their check and both wrote. On Postgres a guarded
 * write now holds the record's row lock from its check to its commit:
 * another server's write waits, then sees the new version and fails its own
 * check. The request's own hooks still write the record (same connection),
 * and realtime / webhooks wait for the commit.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { SQL } from "bun";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createRecord, getRecord } from "../core/records.ts";
import { registerHook } from "../core/hooks.ts";
import { on as onEvent } from "../core/events.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { createPublicCollection, onSqlite } from "./_helpers.ts";

const SECRET = "test-secret-etag-cross-server";
const cleanup: Array<() => void> = [];

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  await createPublicCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
});

afterEach(async () => { for (const f of cleanup.splice(0)) f(); await closeDb(); });

const app = () => makeRecordsPlugin(SECRET);
const etagOf = async (id: string) => (await app().handle(new Request(`http://localhost/posts/${id}`))).headers.get("etag")!;
const patch = (id: string, title: string, etag?: string) => app().handle(new Request(`http://localhost/posts/${id}`, {
  method: "PATCH", headers: { "content-type": "application/json", ...(etag ? { "if-match": etag } : {}) }, body: JSON.stringify({ title }),
}));

/** A beforeUpdate hook that waits until released. */
function pauseUpdates(): { reached: Promise<void>; release: () => void } {
  let reach!: () => void, release!: () => void;
  const reached = new Promise<void>((r) => { reach = r; });
  const gate = new Promise<void>((r) => { release = r; });
  let first = true;
  cleanup.push(registerHook({ collection: "posts", event: "beforeUpdate", name: "pause", run: async () => {
    if (!first) return;
    first = false; reach(); await gate;
  } }));
  return { reached, release };
}

describe.skipIf(onSqlite)("If-Match across servers (Postgres)", () => {
  it("holds the row lock from the check to the commit, so another server's write waits", async () => {
    const r = await createRecord("posts", { title: "v0" }, null);
    const etag = await etagOf(r.id);
    const p = pauseUpdates();
    const a = patch(r.id, "from server A", etag);
    await p.reached;
    // Server B, on its own connection.
    const other = new SQL(process.env["VAULTBASE_TEST_DB"]!);
    try {
      let locked = false;
      try { await other.unsafe(`SELECT 1 FROM vb_posts WHERE id = $1 FOR UPDATE NOWAIT`, [r.id]); } catch { locked = true; }
      expect(locked).toBe(true);
      p.release();
      expect((await a).status).toBe(200);
      // Now B's check sees A's version: the same ETag no longer matches.
      expect((await patch(r.id, "from server B", etag)).status).toBe(412);
      expect(((await getRecord("posts", r.id)) as unknown as { title: string }).title).toBe("from server A");
    } finally {
      await other.close();
    }
  });

  it("doesn't announce a guarded write before it commits", async () => {
    const r = await createRecord("posts", { title: "v0" }, null);
    const etag = await etagOf(r.id);
    const seen: string[] = [];
    cleanup.push(onEvent("record.updated", (e) => { seen.push(String((e.record as { title: string }).title)); }));
    const p = pauseUpdates();
    const a = patch(r.id, "v1", etag);
    await p.reached;
    expect(seen).toEqual([]);
    p.release();
    expect((await a).status).toBe(200);
    await Bun.sleep(20);
    expect(seen).toEqual(["v1"]);
  });
});

describe("guarded writes on either driver", () => {
  it("a beforeUpdate hook may still write the same record under If-Match", async () => {
    const r = await createRecord("posts", { title: "v0" }, null);
    let once = true;
    cleanup.push(registerHook({ collection: "posts", event: "beforeUpdate", name: "touch", run: async (ctx) => {
      if (!once) return;
      once = false;
      await ctx.helpers.sql!.exec(`UPDATE vb_posts SET title = 'touched' WHERE id = ?`, [r.id]);
    } }));
    expect((await patch(r.id, "v1", await etagOf(r.id))).status).toBe(200);
  });

  it("two guarded PATCHes with one ETag: one 200, one 412", async () => {
    const r = await createRecord("posts", { title: "v0" }, null);
    const etag = await etagOf(r.id);
    const statuses = (await Promise.all([patch(r.id, "a", etag), patch(r.id, "b", etag)])).map((x) => x.status).sort();
    expect(statuses).toEqual([200, 412]);
  });
});
