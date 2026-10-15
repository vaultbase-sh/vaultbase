/**
 * The hooks / routes / jobs / workers admin APIs in files mode: writes go to
 * files in the hooks folder, with If-Match against changes made on disk.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as jose from "jose";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { admin as adminTable, hooks, jobs } from "../db/schema.ts";
import { makeHooksPlugin } from "../api/hooks.ts";
import { makeQueuesPlugin } from "../api/queues.ts";
import { _resetCodeFiles, startCodeFiles, syncCodeFiles } from "../core/code-files.ts";
import { makeHookHelpers } from "../core/hooks.ts";

const SECRET = "test-secret-code-files-api";
let tmp: string;
let dir: string;
let token: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "vaultbase-code-files-api-"));
  dir = join(tmp, "vb_hooks");
  setLogsDir(tmp);
  await initDb(":memory:");
  await runMigrations();
  const id = crypto.randomUUID();
  await getDb().insert(adminTable).values({
    id, email: "admin@x.test", password_hash: await Bun.password.hash("pw"), password_reset_at: 0,
    created_at: Math.floor(Date.now() / 1000),
  });
  token = await new jose.SignJWT({ id, email: "admin@x.test" })
    .setProtectedHeader({ alg: "HS256" }).setIssuer("vaultbase").setAudience("admin")
    .setIssuedAt().setExpirationTime("1h").setJti(crypto.randomUUID())
    .sign(new TextEncoder().encode(SECRET));
  await startCodeFiles(dir, { pollMs: 0 });
});

afterEach(async () => {
  _resetCodeFiles();
  await closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

function call(plugin: { handle(r: Request): Promise<Response> }, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  return plugin.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

type HookRow = { id: string; origin: string; file_path: string; code: string; file_version: string; enabled: number };

describe("hooks API in files mode", () => {
  it("creates, edits (with If-Match) and deletes the file", async () => {
    const app = makeHooksPlugin(SECRET);
    const created = await call(app, "POST", "/admin/hooks", {
      name: "Stamp", collection_name: "posts", event: "beforeCreate", code: "ctx.record.x = 1;",
    });
    expect(created.status).toBe(200);
    const row = (await created.json() as { data: HookRow }).data;
    expect(row).toMatchObject({ origin: "file", file_path: "hooks/stamp.ts" });
    expect(readFileSync(join(dir, "hooks/stamp.ts"), "utf8")).toContain("ctx.record.x = 1;");

    // Toggling it off from the form writes `enabled: false` into the file.
    const off = await call(app, "PATCH", `/admin/hooks/${row.id}`, { enabled: false }, { "if-match": `"${row.file_version}"` });
    expect(off.status).toBe(200);
    const afterOff = (await off.json() as { data: HookRow }).data;
    expect(afterOff.enabled).toBe(0);
    expect(readFileSync(join(dir, "hooks/stamp.ts"), "utf8")).toContain("enabled: false,");

    // Someone edits the file; a save based on the old version is refused.
    writeFileSync(join(dir, "hooks/stamp.ts"), afterOff.code.replace("x = 1", "x = 2"));
    await syncCodeFiles();
    const stale = await call(app, "PATCH", `/admin/hooks/${row.id}`, { code: afterOff.code.replace("x = 1", "x = 3") }, { "if-match": `"${afterOff.file_version}"` });
    expect(stale.status).toBe(409);
    expect(readFileSync(join(dir, "hooks/stamp.ts"), "utf8")).toContain("x = 2");

    // The list carries the current version to save against.
    const list = (await (await call(app, "GET", "/admin/hooks")).json() as { data: HookRow[] }).data;
    const fresh = list[0]!;
    const saved = await call(app, "PATCH", `/admin/hooks/${row.id}`, { code: fresh.code.replace("x = 2", "x = 3") }, { "if-match": `"${fresh.file_version}"` });
    expect(saved.status).toBe(200);
    expect(readFileSync(join(dir, "hooks/stamp.ts"), "utf8")).toContain("x = 3");

    const del = await call(app, "DELETE", `/admin/hooks/${row.id}`);
    expect(del.status).toBe(200);
    expect(existsSync(join(dir, "hooks/stamp.ts"))).toBe(false);
    expect(await getDb().select().from(hooks)).toHaveLength(0);
  });

  it("answers 422 for code that doesn't compile", async () => {
    const res = await call(makeHooksPlugin(SECRET), "POST", "/admin/hooks", { name: "bad", event: "beforeCreate", code: "if (" });
    expect(res.status).toBe(422);
    expect(existsSync(join(dir, "hooks/bad.ts"))).toBe(false);
  });

  it("refuses to edit a file-backed hook on a server without the folder", async () => {
    const app = makeHooksPlugin(SECRET);
    const row = (await (await call(app, "POST", "/admin/hooks", { name: "x", event: "afterCreate", code: "" })).json() as { data: HookRow }).data;
    _resetCodeFiles();
    const res = await call(app, "PATCH", `/admin/hooks/${row.id}`, { enabled: false });
    expect(res.status).toBe(409);
  });
});

describe("workers API in files mode", () => {
  it("writes worker settings into the file", async () => {
    const app = makeQueuesPlugin(SECRET);
    const row = (await (await call(app, "POST", "/admin/workers", { name: "Mailer", queue: "mail", code: "" })).json() as { data: HookRow }).data;
    expect(row.file_path).toBe("workers/mailer.ts");
    const res = await call(app, "PATCH", `/admin/workers/${row.id}`, { concurrency: 4, retry_backoff: "fixed" });
    expect(res.status).toBe(200);
    const src = readFileSync(join(dir, "workers/mailer.ts"), "utf8");
    expect(src).toContain("concurrency: 4,");
    expect(src).toContain(`backoff: "fixed",`);
  });
});

describe("helpers.cron", () => {
  it("leaves jobs defined in files alone, and marks its own as runtime", async () => {
    writeFileSync(join(dir, "nightly.ts"), `import { defineJob } from "vaultbase";\nexport default defineJob({ name: "nightly", cron: "0 3 * * *", run() {} });\n`);
    await syncCodeFiles();
    const helpers = makeHookHelpers();
    await expect(helpers.cron.add({ name: "nightly", schedule: "* * * * *", code: "" })).rejects.toThrow(/defined in nightly.ts/);
    await helpers.cron.add({ name: "adhoc", schedule: "* * * * *", code: "" });
    const rows = await getDb().select().from(jobs);
    expect(rows.find((r) => r.name === "adhoc")?.origin).toBe("runtime");
    expect(rows.find((r) => r.name === "nightly")?.cron).toBe("0 3 * * *");
  });
});
