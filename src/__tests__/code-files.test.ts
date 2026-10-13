/**
 * Hooks, routes, jobs and workers as files in the hooks folder: loaded,
 * mirrored into their tables, reloaded on change, and written by the admin
 * UI's create / update / delete.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { eq } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { hooks, jobs, routes, workers } from "../db/schema.ts";
import { createCollection } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { invalidateHookCache } from "../core/hooks.ts";
import { dispatchCustomRoute } from "../core/routes.ts";
import {
  _resetCodeFiles, codeFileErrors, codeFileVersion, createCodeFile, deleteCodeFile, renderCodeFile,
  resolveCodeFilesDir, setCodeFileProps, startCodeFiles, syncCodeFiles, updateCodeFile,
  CodeFileConflictError, CodeFileError,
} from "../core/code-files.ts";

let tmp: string;
let dir: string;

function put(rel: string, source: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), source);
}

const STAMP = `import { defineHook } from "vaultbase";
import { suffix } from "../lib/suffix.ts";

export default defineHook({
  name: "posts: stamp",
  collection: "posts",
  event: "beforeCreate",
  async run(ctx) {
    ctx.record.title = ctx.record.title + suffix();
  },
});
`;

async function titleOfNewPost(): Promise<string> {
  invalidateHookCache();
  return (await createRecord("posts", { title: "t" }, null) as unknown as { title: string }).title;
}

const hookRows = async () => await getDb().select().from(hooks);
const now = () => Math.floor(Date.now() / 1000);

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "vaultbase-code-files-"));
  dir = join(tmp, "vb_hooks");
  setLogsDir(tmp);
  initDb(":memory:");
  await runMigrations();
  await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
});

afterEach(() => {
  _resetCodeFiles();
  invalidateHookCache();
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

describe("choosing the folder", () => {
  it("uses VAULTBASE_HOOKS_DIR, else vb_hooks next to the data dir when it exists", () => {
    const data = join(tmp, "data");
    expect(resolveCodeFilesDir(data, {})).toBeNull();
    mkdirSync(dir);
    expect(resolveCodeFilesDir(data, {})).toBe(dir);
    expect(resolveCodeFilesDir(data, { VAULTBASE_HOOKS_DIR: "off" })).toBeNull();
    expect(resolveCodeFilesDir(data, { VAULTBASE_HOOKS_DIR: join(tmp, "x") })).toBe(join(tmp, "x"));
  });
});

describe("loading files", () => {
  it("runs a hook file that imports shared code, and mirrors it as a row", async () => {
    put("lib/suffix.ts", `export const suffix = () => " (stamped)";`);
    put("hooks/stamp.ts", STAMP);
    await startCodeFiles(dir, { pollMs: 0 });

    const rows = await hookRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      origin: "file", file_path: "hooks/stamp.ts", name: "posts: stamp", collection_name: "posts",
      event: "beforeCreate", enabled: 1, code: STAMP, file_error: null,
    });
    expect(await titleOfNewPost()).toBe("t (stamped)");
    expect(existsSync(join(dir, "vaultbase.d.ts"))).toBe(true);
  });

  it("reloads a changed file, or a changed import, keeping the row's id", async () => {
    put("lib/suffix.ts", `export const suffix = () => " v1";`);
    put("hooks/stamp.ts", STAMP);
    await startCodeFiles(dir, { pollMs: 0 });
    const id = (await hookRows())[0]!.id;

    put("lib/suffix.ts", `export const suffix = () => " v2";`);
    await syncCodeFiles();
    expect(await titleOfNewPost()).toBe("t v2");

    put("hooks/stamp.ts", STAMP.replace('"posts: stamp"', '"renamed"'));
    await syncCodeFiles();
    const rows = await hookRows();
    expect(rows.map((r) => [r.id, r.name])).toEqual([[id, "renamed"]]);
  });

  it("keeps the last good version running when a file breaks, with the error on its row", async () => {
    put("lib/suffix.ts", `export const suffix = () => " ok";`);
    put("hooks/stamp.ts", STAMP);
    await startCodeFiles(dir, { pollMs: 0 });

    put("hooks/stamp.ts", STAMP.replace("async run(ctx) {", "async run(ctx) {{"));
    await syncCodeFiles();
    expect(await titleOfNewPost()).toBe("t ok");
    const row = (await hookRows())[0]!;
    expect(row.file_error).toBeTruthy();
    expect(codeFileErrors().map((e) => e.path)).toEqual(["hooks/stamp.ts"]);

    put("hooks/stamp.ts", STAMP);
    await syncCodeFiles();
    expect((await hookRows())[0]!.file_error).toBeNull();
    expect(codeFileErrors()).toEqual([]);
  });

  it("drops the row when the file is deleted", async () => {
    put("lib/suffix.ts", `export const suffix = () => "";`);
    put("hooks/stamp.ts", STAMP);
    await startCodeFiles(dir, { pollMs: 0 });
    unlinkSync(join(dir, "hooks/stamp.ts"));
    await syncCodeFiles();
    expect(await hookRows()).toHaveLength(0);
  });

  it("explains a file that defines nothing, and refuses invalid settings", async () => {
    put("hooks/empty.ts", `export default { hello: 1 };`);
    put("hooks/bad-event.ts", `import { defineHook } from "vaultbase";\nexport default defineHook({ event: "onSave", run() {} });`);
    await startCodeFiles(dir, { pollMs: 0 });
    const errs = Object.fromEntries(codeFileErrors().map((e) => [e.path, e.error]));
    expect(errs["hooks/empty.ts"]).toContain("export default defineHook");
    expect(errs["hooks/bad-event.ts"]).toContain("event must be one of");
    expect(await hookRows()).toHaveLength(0);
  });

  it("loads routes, jobs and workers too", async () => {
    put("routes/hello.ts", `import { defineRoute } from "vaultbase";
export default defineRoute({ name: "hello", method: "get", path: "/hello/:who", handle: (ctx) => ({ hi: ctx.params.who }) });`);
    put("jobs/nightly.ts", `import { defineJob } from "vaultbase";
export default defineJob({ name: "nightly", cron: "0 3 * * *", run() {} });`);
    put("workers/mail.ts", `import { defineWorker } from "vaultbase";
export default defineWorker({ queue: "mail", concurrency: 2, backoff: "fixed", run() {} });`);
    await startCodeFiles(dir, { pollMs: 0 });

    const res = await dispatchCustomRoute(new Request("http://localhost/api/v1/custom/hello/sam"), "/hello/sam", "s");
    expect(res?.body).toEqual({ hi: "sam" });
    expect((await getDb().select().from(routes))[0]).toMatchObject({ method: "GET", path: "/hello/:who", origin: "file" });
    const job = (await getDb().select().from(jobs))[0]!;
    expect(job).toMatchObject({ name: "nightly", cron: "0 3 * * *", mode: "inline", origin: "file" });
    expect(job.next_run_at).toBeGreaterThan(now());
    expect((await getDb().select().from(workers))[0]).toMatchObject({ queue: "mail", concurrency: 2, retry_backoff: "fixed", retry_max: 3 });
  });
});

describe("the admin UI writing files", () => {
  beforeEach(async () => {
    await startCodeFiles(dir, { pollMs: 0 });
  });

  it("creates a file from the form and function body", async () => {
    const row = await createCodeFile("hook", { name: "Upper titles", collection_name: "posts", event: "beforeCreate" },
      "ctx.record.title = String(ctx.record.title).toUpperCase();");
    expect(row.file_path).toBe("hooks/upper-titles.ts");
    expect(readFileSync(join(dir, "hooks/upper-titles.ts"), "utf8")).toBe(renderCodeFile("hook",
      { name: "Upper titles", collection_name: "posts", event: "beforeCreate", enabled: 1 },
      "ctx.record.title = String(ctx.record.title).toUpperCase();"));
    expect(await titleOfNewPost()).toBe("T");

    const second = await createCodeFile("hook", { name: "Upper titles", event: "afterCreate" }, "");
    expect(second.file_path).toBe("hooks/upper-titles-2.ts");
  });

  it("refuses a body that doesn't compile, and writes nothing", async () => {
    await expect(createCodeFile("hook", { name: "broken", event: "beforeCreate" }, "if (")).rejects.toBeInstanceOf(CodeFileError);
    expect(existsSync(join(dir, "hooks/broken.ts"))).toBe(false);
  });

  it("writes settings into the file and leaves the rest as it was", async () => {
    put("lib/suffix.ts", `export const suffix = () => "!";`);
    put("hooks/stamp.ts", STAMP);
    await syncCodeFiles();
    const row = (await hookRows())[0]! as never as Parameters<typeof updateCodeFile>[1];

    const updated = await updateCodeFile("hook", row, { enabled: 0, event: "beforeUpdate" }, undefined);
    expect(updated).toMatchObject({ enabled: 0, event: "beforeUpdate" });
    expect(readFileSync(join(dir, "hooks/stamp.ts"), "utf8")).toBe(
      STAMP.replace(`event: "beforeCreate",`, `event: "beforeUpdate",`)
        .replace(`export default defineHook({`, `export default defineHook({\n  enabled: false,`),
    );
  });

  it("replaces the whole file with code, unless it changed on disk since it was opened", async () => {
    const row = await createCodeFile("hook", { name: "x", collection_name: "posts", event: "beforeCreate" }, "");
    const seen = codeFileVersion(String(row["code"]));
    put("hooks/x.ts", String(row["code"]).replace("// ...", "ctx.record.title = 'edited in an editor';"));
    await syncCodeFiles();

    const mine = renderCodeFile("hook", { name: "x", collection_name: "posts", event: "beforeCreate" }, "ctx.record.title = 'mine';");
    await expect(updateCodeFile("hook", row, {}, mine, seen)).rejects.toBeInstanceOf(CodeFileConflictError);
    const fresh = (await hookRows())[0]! as never as Parameters<typeof updateCodeFile>[1];
    await updateCodeFile("hook", fresh, {}, mine, codeFileVersion(String(fresh["code"])));
    expect(await titleOfNewPost()).toBe("mine");
  });

  it("deletes the file, and the row with it", async () => {
    const row = await createCodeFile("route", { name: "ping", method: "GET", path: "/ping" }, `return "pong";`);
    await deleteCodeFile(row);
    expect(existsSync(join(dir, "routes/ping.ts"))).toBe(false);
    expect(await getDb().select().from(routes)).toHaveLength(0);
  });
});

describe("moving existing admin UI code to files", () => {
  it("writes inline rows out as files on first start, keeping their ids; leaves runtime jobs alone", async () => {
    const id = crypto.randomUUID();
    await getDb().insert(hooks).values({
      id, name: "legacy", collection_name: "posts", event: "beforeCreate",
      code: `ctx.record.title = "legacy";`, enabled: 1, created_at: now(), updated_at: now(),
    });
    await getDb().insert(hooks).values({
      id: crypto.randomUUID(), name: "won't parse", collection_name: "posts", event: "afterCreate",
      code: "const x = <div>;", enabled: 1, created_at: now(), updated_at: now(),
    });
    await getDb().insert(jobs).values({
      id: crypto.randomUUID(), name: "from cron.add", cron: "* * * * *", code: "", origin: "runtime",
      created_at: now(), updated_at: now(),
    });
    await startCodeFiles(dir, { pollMs: 0 });

    const legacy = (await getDb().select().from(hooks).where(eq(hooks.id, id)))[0]!;
    expect(legacy).toMatchObject({ origin: "file", file_path: "hooks/legacy.ts" });
    expect(await titleOfNewPost()).toBe("legacy");
    const kept = (await hookRows()).find((r) => r.name === "won't parse")!;
    expect(kept.origin).toBe("inline");
    expect((await getDb().select().from(jobs))[0]!.origin).toBe("runtime");
  });
});

describe("setCodeFileProps", () => {
  it("refuses to overwrite a setting written as an expression", () => {
    const src = `import { defineHook } from "vaultbase";\nconst E = "beforeCreate";\nexport default defineHook({\n  event: E,\n  run() {},\n});\n`;
    expect(() => setCodeFileProps(src, "hook", { event: "afterCreate" })).toThrow(/expression/);
    expect(setCodeFileProps(src, "hook", { name: "n" })).toContain(`defineHook({\n  name: "n",\n  event: E,`);
  });
});
