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
  await initDb(":memory:");
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

describe("If-Match follow-ups (review 09)", () => {
  it("a beforeUpdate hook that writes the same row doesn't make the request fail", async () => {
    const { getDb } = await import("../db/client.ts");
    const { hooks } = await import("../db/schema.ts");
    const { invalidateHookCache } = await import("../core/hooks.ts");
    await getDb().insert(hooks).values({
      id: "h-touch", name: "touch", collection_name: "posts", event: "beforeUpdate", enabled: 1,
      code: "await ctx.helpers.sql.exec(`UPDATE vb_posts SET title = 'touched-by-hook' WHERE id = ?`, [ctx.existing.id]);",
    });
    invalidateHookCache();
    try {
      const r = await createRecord("posts", { title: "v0" }, null);
      const res = await app().handle(new Request(`http://localhost/posts/${r.id}`, {
        method: "PATCH", headers: { "content-type": "application/json", "if-match": await etagOf(r.id) }, body: JSON.stringify({ title: "v1" }),
      }));
      expect(res.status).toBe(200);
    } finally {
      invalidateHookCache();
    }
  });

  it("If-Match: * only requires the record to exist; concurrent writers all succeed", async () => {
    const r = await createRecord("posts", { title: "v0" }, null);
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) =>
      app().handle(new Request(`http://localhost/posts/${r.id}`, {
        method: "PATCH", headers: { "content-type": "application/json", "if-match": "*" }, body: JSON.stringify({ title: `w${i}` }),
      }))));
    expect(results.map((x) => x.status)).toEqual([200, 200, 200, 200]);
  });
});

describe("record write locks (review 10)", () => {
  async function hook(id: string, collection: string, code: string) {
    const { getDb } = await import("../db/client.ts");
    const { hooks } = await import("../db/schema.ts");
    const { invalidateHookCache } = await import("../core/hooks.ts");
    await getDb().insert(hooks).values({ id, name: id, collection_name: collection, event: "beforeUpdate", enabled: 1, code });
    invalidateHookCache();
  }

  it("a write already in flight can't slip between an If-Match check and its write", async () => {
    const r = await createRecord("posts", { title: "v0" }, null);
    const etag = await etagOf(r.id);
    await hook("h-slow", "posts", "if (ctx.record.title === 'slow') await new Promise((res) => setTimeout(res, 150));");
    try {
      const slow = app().handle(new Request(`http://localhost/posts/${r.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "slow" }),
      }));
      await Bun.sleep(30); // the unconditional write is now inside its hook
      const guarded = await app().handle(new Request(`http://localhost/posts/${r.id}`, {
        method: "PATCH", headers: { "content-type": "application/json", "if-match": etag }, body: JSON.stringify({ title: "guarded" }),
      }));
      expect((await slow).status).toBe(200);
      expect(guarded.status).toBe(412);
    } finally {
      (await import("../core/hooks.ts")).invalidateHookCache();
    }
  });

  it("restore answers 409, not 500, when the record stays busy", async () => {
    const { _setRecordLockWaitForTests, getCollection, updateCollection } = await import("../core/records.ts").then(async (m) => ({
      ...m, ...(await import("../core/collections.ts")),
    }));
    const { getDb } = await import("../db/client.ts");
    const { admin } = await import("../db/schema.ts");
    const { signAuthToken } = await import("../core/sec.ts");
    await getDb().insert(admin).values({ id: "a1", email: "a1@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
    const { token } = await signAuthToken({ payload: { id: "a1" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET });
    const col = await getCollection("posts");
    await updateCollection(col!.id, { history_enabled: 1 } as Parameters<typeof updateCollection>[1]);
    const r = await createRecord("posts", { title: "v0" }, null);
    await hook("h-hold", "posts", "if (ctx.record.title === 'hold') await new Promise((res) => setTimeout(res, 600));");
    _setRecordLockWaitForTests(100);
    try {
      const slow = app().handle(new Request(`http://localhost/posts/${r.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "hold" }),
      }));
      await Bun.sleep(30);
      const at = Math.floor(Date.now() / 1000) + 5;
      const res = await app().handle(new Request(`http://localhost/posts/${r.id}/restore?at=${at}`, {
        method: "POST", headers: { authorization: `Bearer ${token}` },
      }));
      expect(res.status).toBe(409);
      expect((await slow).status).toBe(200);
    } finally {
      _setRecordLockWaitForTests(10_000);
      (await import("../core/hooks.ts")).invalidateHookCache();
    }
  });

  it("hooks writing each other's records fail fast instead of hanging", async () => {
    const { _setRecordLockWaitForTests } = await import("../core/records.ts");
    _setRecordLockWaitForTests(300);
    const a = await createRecord("posts", { title: "a" }, null);
    const b = await createRecord("posts", { title: "b" }, null);
    // Each update pauses, then touches the other record through the API.
    await hook("h-cross", "posts", `
      if (ctx.record.title === "go-a" || ctx.record.title === "go-b") {
        await new Promise((res) => setTimeout(res, 50));
        const other = ctx.record.title === "go-a" ? "${b.id}" : "${a.id}";
        await ctx.helpers.query("posts", { filter: "id = '" + other + "'" });
        const { updateRecord } = await import("${new URL("../core/records.ts", import.meta.url).pathname}");
        await updateRecord("posts", other, { title: "touched" }, null);
      }`);
    try {
      const t0 = Date.now();
      const results = await Promise.all([
        app().handle(new Request(`http://localhost/posts/${a.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "go-a" }) })),
        app().handle(new Request(`http://localhost/posts/${b.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "go-b" }) })),
      ]);
      // One side gives up after the lock wait (raised inside its hook, so it
      // surfaces as the hook's error status); neither request hangs.
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(results.filter((x) => x.status !== 200).length).toBeGreaterThanOrEqual(1);
    } finally {
      _setRecordLockWaitForTests(10_000);
      (await import("../core/hooks.ts")).invalidateHookCache();
    }
  });
});

describe("record write locks for internal writers (review 13)", () => {
  it("two internal writes to one record don't interleave", async () => {
    const { updateRecord } = await import("../core/records.ts");
    const { getDb } = await import("../db/client.ts");
    const { hooks } = await import("../db/schema.ts");
    const { invalidateHookCache } = await import("../core/hooks.ts");
    const r = await createRecord("posts", { title: "v0" }, null);
    await getDb().insert(hooks).values({
      id: "h-slow-int", name: "slow", collection_name: "posts", event: "beforeUpdate", enabled: 1,
      code: "if (ctx.record.title === 'first') await new Promise((res) => setTimeout(res, 150));",
    });
    invalidateHookCache();
    try {
      const existing = (await (await import("../core/records.ts")).getRecord("posts", r.id))!;
      const first = updateRecord("posts", r.id, { title: "first" }, null, { ifUnchanged: existing as unknown as Record<string, unknown> });
      await Bun.sleep(30);
      const second = updateRecord("posts", r.id, { title: "second" }, null);
      await Promise.all([first, second]);
      // The second write waited for the first instead of landing inside it.
      expect((await (await import("../core/records.ts")).getRecord("posts", r.id))!["title"]).toBe("second");
    } finally {
      invalidateHookCache();
    }
  });
});
