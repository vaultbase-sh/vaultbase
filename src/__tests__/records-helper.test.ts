/**
 * helpers.records (0.43): record writes from hooks, routes, jobs and workers
 * that go through the records path, so they get validation, hooks, record
 * history, realtime and webhooks (helpers.sql gets none of that). Nesting is
 * capped so a hook that triggers itself fails instead of looping.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { createCollection, updateCollection } from "../core/collections.ts";
import { createRecord, getRecord, listRecords } from "../core/records.ts";
import { listRecordHistory } from "../core/record-history.ts";
import { hooks as hooksTable } from "../db/schema.ts";
import { invalidateHookCache, makeHookHelpers } from "../core/hooks.ts";
import { MAX_RECORDS_HELPER_DEPTH } from "../core/records-helper.ts";
import { ValidationError } from "../core/validate.ts";
import { until } from "./_wait.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vb-records-helper-"));
  setLogsDir(tmpDir);
  await initDb(":memory:");
  await runMigrations();
  const posts = await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text", required: true }, { name: "n", type: "number" }]) });
  await updateCollection(posts.id, { history_enabled: 1 } as Parameters<typeof updateCollection>[1]);
  const logs = await createCollection({ name: "logs", fields: JSON.stringify([{ name: "msg", type: "text" }]) });
  await updateCollection(logs.id, { history_enabled: 1 } as Parameters<typeof updateCollection>[1]);
  invalidateHookCache();
});

afterEach(async () => {
  await closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

async function hook(collection: string, event: string, code: string) {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(hooksTable).values({ id: crypto.randomUUID(), name: `${collection}-${event}`, collection_name: collection, event, code, enabled: 1, created_at: now, updated_at: now });
  invalidateHookCache();
}

describe("helpers.records", () => {
  it("create, update and delete write record history", async () => {
    const records = makeHookHelpers().records;
    const rec = await records.create("posts", { title: "a" });
    await records.update("posts", rec.id, { title: "b" });
    const history = await listRecordHistory("posts", rec.id);
    expect(history.data.map((h) => h.op)).toEqual(expect.arrayContaining(["create", "update"]));
    await records.delete("posts", rec.id);
    expect(await getRecord("posts", rec.id)).toBeNull();
    expect((await listRecordHistory("posts", rec.id)).data.map((h) => h.op)).toContain("delete");
  });

  it("validates like the API", async () => {
    await expect(makeHookHelpers().records.create("posts", { n: 1 })).rejects.toBeInstanceOf(ValidationError);
  });

  it("runs the target collection's hooks", async () => {
    await hook("logs", "beforeCreate", "ctx.record.msg = 'seen: ' + ctx.record.msg;");
    const rec = await makeHookHelpers().records.create("logs", { msg: "x" });
    expect(rec["msg"]).toBe("seen: x");
  });

  it("from a hook: a write to another collection lands with history", async () => {
    await hook("posts", "afterCreate", "await ctx.helpers.records.create('logs', { msg: 'created ' + ctx.record.title });");
    await createRecord("posts", { title: "hello" }, null);
    const found = await until(async () => {
      const r = await listRecords("logs", { filter: 'msg = "created hello"' } as Parameters<typeof listRecords>[1]);
      return r.data[0] ?? null;
    });
    expect((await listRecordHistory("logs", String(found.id))).data[0]?.op).toBe("create");
  });

  it("a hook that triggers itself stops at the nesting limit instead of looping", async () => {
    // Each update bumps n and updates the same record again.
    await hook("posts", "beforeUpdate", "if ((ctx.record.n ?? 0) < 100) await ctx.helpers.records.update('posts', ctx.existing.id, { n: (ctx.record.n ?? 0) + 1 });");
    const rec = await createRecord("posts", { title: "loop", n: 0 }, null);
    // A hook's error reaches the caller as a 422 with the message under `_hook`.
    const err = await makeHookHelpers().records.update("posts", rec.id, { n: 1 }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(JSON.stringify((err as ValidationError).details)).toContain("nested inside one another");
    const after = await getRecord("posts", rec.id);
    expect(Number(after?.["n"] ?? 0)).toBeLessThanOrEqual(MAX_RECORDS_HELPER_DEPTH + 1);
  });

  it("an after-hook that triggers itself stops too", async () => {
    await hook("posts", "afterUpdate", "await ctx.helpers.records.update('posts', ctx.record.id, { n: (ctx.record.n ?? 0) + 1 });");
    const rec = await createRecord("posts", { title: "loop2", n: 0 }, null);
    await makeHookHelpers().records.update("posts", rec.id, { n: 1 });
    // settle: give a runaway loop time to show itself
    await Bun.sleep(300);
    const n = Number((await getRecord("posts", rec.id))?.["n"] ?? 0);
    expect(n).toBeGreaterThan(1);
    expect(n).toBeLessThanOrEqual(MAX_RECORDS_HELPER_DEPTH + 1);
  });
});
