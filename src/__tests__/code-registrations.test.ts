/**
 * Hooks, routes, cron jobs and workers registered from code run next to the
 * ones defined in the admin UI, and every kind compiles through one loader.
 */
import { describe, expect, it, beforeEach, afterEach, setSystemTime } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { hooks as hooksTable, routes as routesTable } from "../db/schema.ts";
import { createCollection } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { invalidateHookCache, registerHook } from "../core/hooks.ts";
import { dispatchCustomRoute, invalidateRoutesCache, registerRoute } from "../core/routes.ts";
import { _jobsTickOnce, registerJob } from "../core/jobs.ts";
import { compileCode, registerCodeLoader } from "../core/code-loader.ts";
import { ValidationError } from "../core/validate.ts";

let tmpDir: string;
const offs: Array<() => void> = [];

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-code-reg-"));
  setLogsDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
  invalidateHookCache();
  invalidateRoutesCache();
});

afterEach(() => {
  for (const off of offs.splice(0)) off();
  setSystemTime();
  invalidateHookCache();
  invalidateRoutesCache();
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const now = () => Math.floor(Date.now() / 1000);

describe("code loader", () => {
  it("compiles inline code, and code from a registered origin", async () => {
    expect(await compileCode<{ x: number }>({ id: "a", code: "return ctx.x * 2" })({ x: 3 })).toBe(6);
    offs.push(registerCodeLoader("test", (row) => async () => `loaded ${row.code}`));
    expect(await compileCode({ id: "b", code: "b.ts", origin: "test" })({})).toBe("loaded b.ts");
    expect(() => compileCode({ id: "c", code: "", origin: "nope" })).toThrow(/no code loader for origin 'nope'/);
  });
});

describe("registered hooks", () => {
  it("run after the admin UI's hooks, and can refuse a write", async () => {
    await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    await getDb().insert(hooksTable).values({
      id: crypto.randomUUID(), name: "ui", collection_name: "posts", event: "beforeCreate",
      code: `ctx.record.title = ctx.record.title + " ui";`, enabled: 1, created_at: now(), updated_at: now(),
    });
    invalidateHookCache();
    offs.push(registerHook({
      name: "ext", collection: "posts", event: "beforeCreate",
      run: (ctx) => {
        if (ctx.record["title"] === "no ui") throw new ValidationError({ title: "not allowed" });
        ctx.record["title"] = `${String(ctx.record["title"])} ext`;
      },
    }));

    const r = await createRecord("posts", { title: "a" }, null) as unknown as { title: string };
    expect(r.title).toBe("a ui ext");
    await expect(createRecord("posts", { title: "no" }, null)).rejects.toBeInstanceOf(ValidationError);
  });

  it("can listen on every collection, and after the write", async () => {
    await createCollection({ name: "a", fields: JSON.stringify([{ name: "t", type: "text" }]) });
    await createCollection({ name: "b", fields: JSON.stringify([{ name: "t", type: "text" }]) });
    const seen: string[] = [];
    offs.push(registerHook({ name: "all", event: "afterCreate", run: (ctx) => { seen.push(String(ctx.record["t"])); } }));
    await createRecord("a", { t: "1" }, null);
    await createRecord("b", { t: "2" }, null);
    await Bun.sleep(20);
    expect(seen).toEqual(["1", "2"]);
  });
});

describe("registered routes", () => {
  const call = (path: string, init: RequestInit = {}) =>
    dispatchCustomRoute(new Request(`http://localhost/api/v1/custom${path}`, init), path.split("?")[0]!, "test-secret");

  it("serve under /api/v1/custom with params, query and status", async () => {
    offs.push(registerRoute({
      name: "hello", method: "GET", path: "/hello/:who",
      handle: (ctx) => { ctx.set.status = 201; return { hi: ctx.params["who"], q: ctx.query["q"] }; },
    }));
    const r = await call("/hello/sam?q=1");
    expect(r).toMatchObject({ status: 201, body: { hi: "sam", q: "1" } });
    expect(await call("/nothing")).toBeNull();
  });

  it("enforce requireAuth, and give way to an admin UI route on the same path", async () => {
    offs.push(registerRoute({ name: "private", method: "GET", path: "/private", requireAuth: true, handle: () => "secret" }));
    expect((await call("/private"))?.status).toBe(401);

    offs.push(registerRoute({ name: "dup", method: "GET", path: "/dup", handle: () => "from code" }));
    await getDb().insert(routesTable).values({
      id: crypto.randomUUID(), name: "ui", method: "GET", path: "/dup", code: `return "from ui";`,
      enabled: 1, created_at: now(), updated_at: now(),
    });
    invalidateRoutesCache();
    expect((await call("/dup"))?.body).toBe("from ui");
  });

  it("refuse an unsupported method", () => {
    expect(() => registerRoute({ name: "x", method: "TRACE" as never, path: "/x", handle: () => null })).toThrow(/unsupported route method/);
  });
});

describe("registered cron jobs", () => {
  it("run on the scheduler when due, once per slot", async () => {
    setSystemTime(new Date("2026-01-01T00:00:30Z"));
    let runs = 0;
    offs.push(registerJob({ name: "tick", cron: "* * * * *", run: () => { runs++; } }));
    await _jobsTickOnce();
    expect(runs).toBe(0);
    setSystemTime(new Date("2026-01-01T00:01:05Z"));
    await Promise.all([_jobsTickOnce(), _jobsTickOnce()]);
    expect(runs).toBe(1);
  });

  it("refuse a bad cron expression", () => {
    expect(() => registerJob({ name: "bad", cron: "every day", run: () => {} })).toThrow(/job 'bad'/);
  });
});
