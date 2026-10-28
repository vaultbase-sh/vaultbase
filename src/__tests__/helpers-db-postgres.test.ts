/**
 * `helpers.db` is synchronous and SQLite-only. On Postgres, code that uses
 * it is refused when it is saved or enabled (admin API, MCP, helpers.cron.add,
 * hooks-folder files), with helpers.sql named; on SQLite it is saved as before.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import * as jose from "jose";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { admin as adminTable, hooks } from "../db/schema.ts";
import { makeHooksPlugin } from "../api/hooks.ts";
import { makeRoutesPlugin } from "../api/routes.ts";
import { makeJobsPlugin } from "../api/jobs.ts";
import { makeQueuesPlugin } from "../api/queues.ts";
import { invalidateHookCache } from "../core/hooks.ts";
import { databaseCodeError } from "../core/code-loader.ts";
import { makeExtraHelpers } from "../core/hook-helpers-extra.ts";
import { _resetCodeFiles, codeFileErrors, startCodeFiles } from "../core/code-files.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { buildRegistry, createDispatcher } from "../mcp/server.ts";
import type { JsonRpcSuccess, CallToolResult } from "../mcp/types.ts";
import { onSqlite } from "./_helpers.ts";

const SECRET = "test-secret-helpers-db";
const USES_DB = `const rows = ctx.helpers.db.query("SELECT 1");`;
let token: string;
let tmp: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "vaultbase-helpers-db-"));
  setLogsDir(tmp);
  await initDb(":memory:");
  await runMigrations();
  const id = crypto.randomUUID();
  await getDb().insert(adminTable).values({ id, email: "admin@x.test", password_hash: "x", password_reset_at: 0, created_at: 0 });
  token = await new jose.SignJWT({ id, email: "admin@x.test" })
    .setProtectedHeader({ alg: "HS256" }).setIssuer("vaultbase").setAudience("admin")
    .setIssuedAt().setExpirationTime("1h").setJti(crypto.randomUUID())
    .sign(new TextEncoder().encode(SECRET));
});

afterEach(async () => {
  _resetCodeFiles();
  invalidateHookCache();
  await closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

function call(plugin: { handle(r: Request): Promise<Response> }, method: string, path: string, body: unknown) {
  return plugin.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe.skipIf(onSqlite)("finding helpers.db (Postgres)", () => {
  it("finds the ways code reaches it", () => {
    for (const code of [
      USES_DB,
      `return ctx.helpers?.db.queryOne("SELECT 1");`,
      `const { db } = ctx.helpers; return db.query("SELECT 1");`,
      `const { db: sqlite, sql } = ctx.helpers;`,
      `const { helpers: { db } } = ctx;`,
      `const h = ctx.helpers; return h && helpers["db"];`,
      "return `rows: ${ctx.helpers.db.query(\"SELECT 1\").length}`;",
    ]) {
      expect(databaseCodeError(code)).toContain("helpers.sql");
    }
  });

  it("leaves helpers.sql, other names and comments alone", () => {
    for (const code of [
      `return await ctx.helpers.sql.query("SELECT 1", []);`,
      `const db = ctx.helpers.sql; return db.query("SELECT 1");`,
      `return ctx.helpers.dbx;`,
      `// helpers.db is the old way\n/* const { db } = ctx.helpers; */\nreturn 1;`,
      `return ctx.record.db;`,
      `ctx.helpers.log("helpers.db is gone; use helpers.sql");`,
      "return `see helpers.db in the docs`;",
      `const re = /helpers.db/; return re.test(ctx.body);`,
      `const o = { helpers: { name: "db" } }; return o;`,
    ]) {
      expect(databaseCodeError(code)).toBeNull();
    }
  });

  it("reads a module (a hooks-folder file) as a module", () => {
    expect(databaseCodeError(`export default { run({ helpers: { db } }) { return db; } };`, true)).toContain("helpers.sql");
    expect(databaseCodeError(`export default { run({ helpers }) { return helpers.sql; } };`, true)).toBeNull();
  });
});

describe("saving code that uses helpers.db", () => {
  const kinds = [
    { name: "hook", plugin: () => makeHooksPlugin(SECRET), path: "/admin/hooks", body: { event: "beforeCreate", collection_name: "posts" } },
    { name: "route", plugin: () => makeRoutesPlugin(SECRET), path: "/admin/routes", body: { method: "GET", path: "/hello" } },
    { name: "job", plugin: () => makeJobsPlugin(SECRET), path: "/admin/jobs", body: { cron: "*/5 * * * *" } },
    { name: "worker", plugin: () => makeQueuesPlugin(SECRET), path: "/admin/workers", body: { queue: "emails" } },
  ];
  for (const k of kinds) {
    it(`${onSqlite ? "saves" : "refuses"} a ${k.name} on create and on update`, async () => {
      const plugin = k.plugin();
      const create = await call(plugin, "POST", k.path, { ...k.body, code: USES_DB });
      const created = await call(plugin, "POST", k.path, { ...k.body, code: "return 1;" });
      const id = ((await created.json()) as { data: { id: string } }).data.id;
      const update = await call(plugin, "PATCH", `${k.path}/${id}`, { code: USES_DB });
      if (onSqlite) {
        expect(create.status).toBe(200);
        expect(update.status).toBe(200);
        return;
      }
      expect(create.status).toBe(422);
      expect(((await create.json()) as { error: string }).error).toContain("helpers.sql");
      expect(update.status).toBe(422);
      // Saving it disabled is refused too: it can't be enabled later.
      const disabled = await call(plugin, "POST", k.path, { ...k.body, code: USES_DB, enabled: false });
      expect(disabled.status).toBe(422);
    });
  }

  for (const k of kinds) {
    it.skipIf(onSqlite)(`refuses enabling a stored ${k.name} that uses it`, async () => {
      const plugin = k.plugin();
      const created = await call(plugin, "POST", k.path, { ...k.body, code: "return 1;", enabled: false });
      const id = ((await created.json()) as { data: { id: string } }).data.id;
      const table = { hook: "vaultbase_hooks", route: "vaultbase_routes", job: "vaultbase_jobs", worker: "vaultbase_workers" }[k.name]!;
      // As a version before the check could have stored it.
      await db.run(`UPDATE ${table} SET code = ? WHERE id = ?`, [USES_DB, id]);
      expect((await call(plugin, "PATCH", `${k.path}/${id}`, { enabled: true })).status).toBe(422);
      expect((await call(plugin, "PATCH", `${k.path}/${id}`, { enabled: false })).status).toBe(200);
    });
  }

  it.skipIf(onSqlite)("refuses enabling a stored hook that uses it, and lets other edits through", async () => {
    const now = Math.floor(Date.now() / 1000);
    const id = crypto.randomUUID();
    // Written directly, as a version before the check could have stored it.
    await getDb().insert(hooks).values({ id, name: "old", collection_name: "posts", event: "beforeCreate", code: USES_DB, enabled: 0, created_at: now, updated_at: now });
    const plugin = makeHooksPlugin(SECRET);
    const enable = await call(plugin, "PATCH", `/admin/hooks/${id}`, { enabled: true });
    expect(enable.status).toBe(422);
    expect(((await enable.json()) as { error: string }).error).toContain("helpers.db is not available on Postgres");
    expect((await call(plugin, "PATCH", `/admin/hooks/${id}`, { name: "renamed" })).status).toBe(200);
    // Enabled together with code that no longer uses it: allowed.
    const fixed = await call(plugin, "PATCH", `/admin/hooks/${id}`, { enabled: true, code: `await ctx.helpers.sql.query("SELECT 1", []);` });
    expect(fixed.status).toBe(200);
  });

  it(`${onSqlite ? "saves" : "refuses"} it through MCP: create_hook, create_route, create_job, update_hook`, async () => {
    const reg = await buildRegistry(false);
    const d = createDispatcher(reg, { tokenId: "t", tokenName: "t", scopes: ["mcp:admin"], adminId: "a1", adminEmail: "ops@test.local" });
    const tool = async (name: string, args: Record<string, unknown>) =>
      ((await d.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as JsonRpcSuccess).result as CallToolResult);
    const results = [
      await tool("vaultbase.create_hook", { name: "h", collection_name: "posts", event: "before_create", code: USES_DB }),
      await tool("vaultbase.create_route", { name: "r", method: "GET", path: "/x", code: USES_DB }),
      await tool("vaultbase.create_job", { name: "j", cron: "0 3 * * *", code: USES_DB }),
    ];
    const ok = await tool("vaultbase.create_hook", { name: "fine", collection_name: "posts", event: "before_create", code: "return 1;", enabled: false });
    expect(ok.isError).toBeFalsy();
    const id = (await getDb().select().from(hooks)).find((h) => h.name === "fine")!.id;
    results.push(await tool("vaultbase.update_hook", { id, code: USES_DB }));
    await db.run(`UPDATE vaultbase_hooks SET code = ? WHERE id = ?`, [USES_DB, id]);
    results.push(await tool("vaultbase.update_hook", { id, enabled: true }));
    for (const r of results) {
      if (onSqlite) {
        expect(r.isError).toBeFalsy();
        continue;
      }
      expect(r.isError).toBe(true);
      expect((r.content[0] as { text: string }).text).toContain("helpers.sql");
    }
  });

  it(`${onSqlite ? "saves" : "refuses"} it from helpers.cron.add, new or replacing a job`, async () => {
    const cron = makeExtraHelpers().cron;
    const add = cron.add({ name: "nightly", schedule: "0 3 * * *", code: USES_DB });
    if (onSqlite) await expect(add).resolves.toBeTruthy();
    else await expect(add).rejects.toThrow("helpers.sql");
    await cron.add({ name: "weekly", schedule: "0 3 * * 0", code: "return 1;" });
    const replace = cron.add({ name: "weekly", schedule: "0 3 * * 0", code: USES_DB });
    if (onSqlite) await expect(replace).resolves.toBeTruthy();
    else await expect(replace).rejects.toThrow("helpers.sql");
  });

  it(`${onSqlite ? "loads" : "doesn't load"} a hooks-folder file that uses it`, async () => {
    const dir = join(tmp, "vb_hooks");
    const file = join(dir, "hooks/old.ts");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `import { defineHook } from "vaultbase";
export default defineHook({
  name: "old", collection: "posts", event: "beforeCreate",
  async run({ helpers }) { helpers.db.query("SELECT 1"); },
});
`);
    await startCodeFiles(dir, { pollMs: 0 });
    const errors = codeFileErrors();
    if (onSqlite) {
      expect(errors).toEqual([]);
      return;
    }
    expect(errors.map((e) => e.path)).toEqual(["hooks/old.ts"]);
    expect(errors[0]!.error).toContain("helpers.sql");
  });
});
