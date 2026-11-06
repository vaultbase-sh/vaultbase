/**
 * Time limits on user scripts (script-limits.ts): a hook, custom route, cron
 * job or queue worker past its limit stops holding its caller, its outgoing
 * requests are aborted, and its later helper calls are refused, so a run
 * left behind can't write after its request ended.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { setSetting } from "../api/settings.ts";
import { invalidateEgressCache } from "../core/hook-egress.ts";
import { createCollection, _resetCollectionCache } from "../core/collections.ts";
import { createRecord, listRecords } from "../core/records.ts";
import { ValidationError } from "../core/validate.ts";
import { hooks, jobs, jobsLog, routes, workers } from "../db/schema.ts";
import { invalidateHookCache, registerHook } from "../core/hooks.ts";
import { invalidateRoutesCache, dispatchCustomRoute } from "../core/routes.ts";
import { runJob } from "../core/jobs.ts";
import { enqueue, invalidateWorkerCache, registerWorker, startQueueScheduler, stopQueueScheduler } from "../core/queues.ts";
import {
  DEFAULT_SCRIPT_TIMEOUT_MS, ScriptTimeoutError, guardHelpers, scriptTimeoutMs, validateScriptTimeout, withTimeLimit,
} from "../core/script-limits.ts";

let tmpDir: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-limits-"));
  setLogsDir(tmpDir);
  await initDb(":memory:");
  await runMigrations();
  _resetCollectionCache();
  invalidateHookCache();
  invalidateRoutesCache();
  invalidateWorkerCache();
});

afterEach(async () => {
  stopQueueScheduler();
  await closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("withTimeLimit", () => {
  it("rejects when the limit runs out, without waiting for the run", async () => {
    setSetting("routes.timeout_ms", "100");
    const t0 = Date.now();
    const err = await withTimeLimit("route", "slow", async () => { await sleep(2_000); return 1; }).catch((e) => e);
    expect(err).toBeInstanceOf(ScriptTimeoutError);
    expect((err as Error).message).toBe("route 'slow' timed out after 100 ms");
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("returns the run's result when it ends in time, and 0 means no limit", async () => {
    setSetting("routes.timeout_ms", "100");
    expect(await withTimeLimit("route", "quick", async () => 7)).toBe(7);
    setSetting("routes.timeout_ms", "0");
    expect(await withTimeLimit("route", "unbounded", async () => { await sleep(150); return 8; })).toBe(8);
  });

  it("uses the default when the setting is unset or invalid", () => {
    expect(scriptTimeoutMs("hook")).toBe(DEFAULT_SCRIPT_TIMEOUT_MS.hook);
    setSetting("hooks.timeout_ms", "nonsense");
    expect(scriptTimeoutMs("hook")).toBe(DEFAULT_SCRIPT_TIMEOUT_MS.hook);
    expect(validateScriptTimeout("50")).not.toBeNull();
    expect(validateScriptTimeout("0")).toBeNull();
    expect(validateScriptTimeout("250")).toBeNull();
  });

  it("refuses helpers, nested ones too, once the run is stopped", async () => {
    const ac = new AbortController();
    const h = guardHelpers({ a: () => 1, ns: { b: () => 2 } }, ac.signal);
    const b = h.ns.b;
    expect(h.a()).toBe(1);
    ac.abort(new ScriptTimeoutError("hook", "x", 1));
    expect(() => h.a()).toThrow("timed out");
    expect(() => b()).toThrow("timed out");
    expect(() => h.ns).toThrow("timed out");
  });
});

describe("hooks", () => {
  const installHook = async (event: string, code: string, name = "slow-hook") => {
    await getDb().insert(hooks).values({ id: crypto.randomUUID(), name, collection_name: "posts", event, code, enabled: 1, created_at: now(), updated_at: now() });
    invalidateHookCache();
  };

  beforeEach(async () => {
    await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    await createCollection({ name: "audit", fields: JSON.stringify([{ name: "note", type: "text" }]) });
    _resetCollectionCache();
  });

  it("a before-hook past its limit fails the write with a 422 naming it, and can't write afterwards", async () => {
    // Waits, then writes elsewhere. Within the limit the write goes through.
    const write = `await ctx.helpers.sql.exec("INSERT INTO vb_audit (id, note) VALUES (?, ?)", [crypto.randomUUID(), "from hook"]);`;
    setSetting("hooks.timeout_ms", "1000");
    await installHook("beforeCreate", `await new Promise((r) => setTimeout(r, 20)); ${write}`, "quick-hook");
    await createRecord("posts", { title: "ok" });
    expect((await listRecords("audit")).data).toHaveLength(1);
    await getDb().delete(hooks);
    invalidateHookCache();

    setSetting("hooks.timeout_ms", "150");
    await installHook("beforeCreate", `await new Promise((r) => setTimeout(r, 400)); ${write}`);
    const err = await createRecord("posts", { title: "t" }).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).details["_hook"]).toBe("hook 'slow-hook' timed out after 150 ms");
    expect((await listRecords("posts")).data.map((r) => r["title"])).toEqual(["ok"]);
    await sleep(600);
    expect((await listRecords("audit")).data).toHaveLength(1);
  });

  it("aborts the outgoing request of a hook past its limit", async () => {
    setSetting("hooks.timeout_ms", "150");
    setSetting("hooks.http.deny", "off");
    // The egress list is cached for a few seconds: an earlier test's read of
    // it would otherwise still block 127.0.0.1 here.
    invalidateEgressCache();
    let aborted = false;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        req.signal.addEventListener("abort", () => { aborted = true; });
        return new Promise<Response>(() => { /* never answers */ });
      },
    });
    try {
      await installHook("beforeCreate", `await ctx.helpers.fetch("http://127.0.0.1:${server.port}/hang");`);
      const err = await createRecord("posts", { title: "t" }).catch((e) => e);
      expect((err as ValidationError).details["_hook"]).toContain("timed out after 150 ms");
      for (let i = 0; i < 50 && !aborted; i++) await sleep(20);
      expect(aborted).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  it("gives up a transaction the hook holds, so other writers don't wait for it", async () => {
    setSetting("hooks.timeout_ms", "150");
    await installHook("beforeCreate", `await ctx.helpers.sql.transaction(async () => { await new Promise((r) => setTimeout(r, 1500)); });`);
    const t0 = Date.now();
    const slow = createRecord("posts", { title: "t" }).catch((e) => e);
    await sleep(300);
    const t1 = Date.now();
    await createRecord("audit", { note: "unrelated" });
    const waited = Date.now() - t1;
    const err = await slow;
    expect((err as ValidationError).details["_hook"]).toContain("timed out after 150 ms");
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(waited).toBeLessThan(500);
  });

  it("a hook registered from code has no limit", async () => {
    setSetting("hooks.timeout_ms", "100");
    const off = registerHook({ name: "code-hook", collection: "posts", event: "beforeCreate", run: async (ctx) => {
      await sleep(250);
      (ctx.record as Record<string, unknown>)["title"] = "from code";
    } });
    try {
      expect((await createRecord("posts", { title: "t" }))["title"]).toBe("from code");
    } finally {
      off();
    }
  });

  it("a hook that ends in time isn't affected", async () => {
    setSetting("hooks.timeout_ms", "1000");
    await installHook("beforeCreate", `await new Promise((r) => setTimeout(r, 20)); ctx.record.title = "hooked";`);
    expect((await createRecord("posts", { title: "t" }))["title"]).toBe("hooked");
  });
});

describe("custom routes", () => {
  it("answer 504 when the route runs out of time", async () => {
    setSetting("routes.timeout_ms", "150");
    await getDb().insert(routes).values({
      id: crypto.randomUUID(), name: "slow-route", method: "GET", path: "/slow",
      code: `await new Promise((r) => setTimeout(r, 2000)); return { done: true };`, enabled: 1, created_at: now(), updated_at: now(),
    });
    invalidateRoutesCache();
    const res = await dispatchCustomRoute(new Request("http://localhost/custom/slow"), "/slow", "secret");
    expect(res!.status).toBe(504);
    expect(res!.body).toEqual({ error: "route 'slow-route' timed out after 150 ms", code: 504 });
  });
});

describe("cron jobs", () => {
  it("record a run past its limit as failed", async () => {
    setSetting("jobs.timeout_ms", "150");
    const id = crypto.randomUUID();
    await getDb().insert(jobs).values({ id, name: "nightly", cron: "0 3 * * *", code: `await new Promise((r) => setTimeout(r, 2000));`, enabled: 1, created_at: now(), updated_at: now() });
    const r = await runJob(id);
    expect(r).toEqual({ ok: false, error: "cron job 'nightly' timed out after 150 ms" });
    const row = (await getDb().select().from(jobs).where(eq(jobs.id, id)))[0]!;
    expect(row.last_status).toBe("error");
  });
});

describe("queue workers", () => {
  it("keep a job's slot while its script runs on past the limit, so runs left behind don't pile up", async () => {
    setSetting("queues.timeout_ms", "200");
    // Counts the runs going at once: each waits 300 ms, past its limit but
    // inside the extra limit the slot is held for.
    (globalThis as Record<string, unknown>)["__vbRuns"] = { now: 0, peak: 0 };
    await getDb().insert(workers).values({
      id: crypto.randomUUID(), name: "hanging", queue: "hang",
      code: `const c = globalThis.__vbRuns; c.now++; c.peak = Math.max(c.peak, c.now); await new Promise((r) => setTimeout(r, 300)); c.now--;`,
      enabled: 1, concurrency: 1, retry_max: 1, retry_backoff: "fixed", retry_delay_ms: 10, created_at: now(), updated_at: now(),
    });
    invalidateWorkerCache();
    for (let i = 0; i < 4; i++) await enqueue("hang", { i });
    startQueueScheduler();
    await sleep(1_500);
    expect(((globalThis as Record<string, unknown>)["__vbRuns"] as { peak: number }).peak).toBe(1);
    // Let every run end and record its result before the database closes.
    for (let i = 0; i < 60; i++) {
      const rows = await getDb().select({ status: jobsLog.status }).from(jobsLog).where(eq(jobsLog.queue, "hang"));
      if (rows.every((r) => r.status === "dead") && ((globalThis as Record<string, unknown>)["__vbRuns"] as { now: number }).now === 0) break;
      await sleep(50);
    }
  });

  it("free a job's slot one more limit after it, when its script never ends", async () => {
    setSetting("queues.timeout_ms", "100");
    (globalThis as Record<string, unknown>)["__vbStuck"] = 0;
    await getDb().insert(workers).values({
      id: crypto.randomUUID(), name: "stuck", queue: "stuck",
      code: `globalThis.__vbStuck++; await new Promise(() => {});`,
      enabled: 1, concurrency: 1, retry_max: 1, retry_backoff: "fixed", retry_delay_ms: 10, created_at: now(), updated_at: now(),
    });
    invalidateWorkerCache();
    await enqueue("stuck", { i: 1 });
    await enqueue("stuck", { i: 2 });
    startQueueScheduler();
    for (let i = 0; i < 60 && ((globalThis as Record<string, unknown>)["__vbStuck"] as number) < 2; i++) await sleep(50);
    expect((globalThis as Record<string, unknown>)["__vbStuck"]).toBe(2);
    // Let the second run hit its limit before the database closes.
    for (let i = 0; i < 40; i++) {
      const rows = await getDb().select({ status: jobsLog.status }).from(jobsLog).where(eq(jobsLog.queue, "stuck"));
      if (rows.every((r) => r.status === "dead")) break;
      await sleep(50);
    }
  });

  it("a worker registered from code has no limit", async () => {
    setSetting("queues.timeout_ms", "100");
    let finished = false;
    const off = registerWorker({ queue: "code-q", fn: async () => { await sleep(300); finished = true; } });
    try {
      const { jobId } = await enqueue("code-q", {});
      startQueueScheduler();
      let job: typeof jobsLog.$inferSelect | undefined;
      for (let i = 0; i < 40; i++) {
        job = (await getDb().select().from(jobsLog).where(eq(jobsLog.id, jobId)))[0];
        if (job?.status === "succeeded") break;
        await sleep(50);
      }
      expect(job?.status).toBe("succeeded");
      expect(finished).toBe(true);
    } finally {
      off();
    }
  });

  it("fail a job past its limit, which is then retried as the worker says", async () => {
    setSetting("queues.timeout_ms", "150");
    await getDb().insert(workers).values({
      id: crypto.randomUUID(), name: "slow-worker", queue: "q", code: `await new Promise((r) => setTimeout(r, 2000));`,
      enabled: 1, concurrency: 1, retry_max: 1, retry_backoff: "fixed", retry_delay_ms: 10, created_at: now(), updated_at: now(),
    });
    invalidateWorkerCache();
    const { jobId } = await enqueue("q", { n: 1 });
    startQueueScheduler();
    let job: typeof jobsLog.$inferSelect | undefined;
    for (let i = 0; i < 100; i++) {
      job = (await getDb().select().from(jobsLog).where(eq(jobsLog.id, jobId)))[0];
      if (job?.status === "dead") break;
      await sleep(50);
    }
    expect(job?.status).toBe("dead");
    expect(job?.error).toBe("queue worker 'slow-worker' timed out after 150 ms");
  });
});
