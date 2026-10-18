/**
 * Inline code that doesn't compile is refused when it is saved (hooks,
 * routes, jobs, workers; admin API and MCP), and an enabled before-hook
 * that can't compile anyway (stored by an older version) blocks the write
 * instead of being skipped.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as jose from "jose";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { admin as adminTable, hooks } from "../db/schema.ts";
import { makeHooksPlugin } from "../api/hooks.ts";
import { makeRoutesPlugin } from "../api/routes.ts";
import { makeJobsPlugin } from "../api/jobs.ts";
import { makeQueuesPlugin } from "../api/queues.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { invalidateHookCache } from "../core/hooks.ts";
import { ValidationError } from "../core/validate.ts";
import { createPublicCollection } from "./_helpers.ts";

const SECRET = "test-secret-code-compile-guard";
const BROKEN = "if (ctx.record.title ===) { }";
let token: string;

beforeEach(async () => {
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
  invalidateHookCache();
  _resetCollectionCache();
  await closeDb();
});

function call(plugin: { handle(r: Request): Promise<Response> }, method: string, path: string, body: unknown) {
  return plugin.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

describe("saving inline code", () => {
  const kinds = [
    { name: "hook", plugin: () => makeHooksPlugin(SECRET), path: "/admin/hooks", body: { event: "beforeCreate", collection_name: "posts" } },
    { name: "route", plugin: () => makeRoutesPlugin(SECRET), path: "/admin/routes", body: { method: "GET", path: "/hello" } },
    { name: "job", plugin: () => makeJobsPlugin(SECRET), path: "/admin/jobs", body: { cron: "*/5 * * * *" } },
    { name: "worker", plugin: () => makeQueuesPlugin(SECRET), path: "/admin/workers", body: { queue: "emails" } },
  ];
  for (const k of kinds) {
    it(`refuses a ${k.name} that doesn't compile, on create and on update`, async () => {
      const plugin = k.plugin();
      const bad = await call(plugin, "POST", k.path, { ...k.body, code: BROKEN });
      expect(bad.status).toBe(422);
      expect(((await bad.json()) as { error: string }).error).toContain("does not compile");

      const ok = await call(plugin, "POST", k.path, { ...k.body, code: "return 1;" });
      expect(ok.status).toBe(200);
      const id = ((await ok.json()) as { data: { id: string } }).data.id;
      const patch = await call(plugin, "PATCH", `${k.path}/${id}`, { code: BROKEN });
      expect(patch.status).toBe(422);
      const rename = await call(plugin, "PATCH", `${k.path}/${id}`, { name: "renamed" });
      expect(rename.status).toBe(200);
    });
  }
});

describe("a before-hook that doesn't compile", () => {
  async function storeBroken(event: string) {
    const now = Math.floor(Date.now() / 1000);
    // Written directly, as an older version could have stored it.
    await getDb().insert(hooks).values({ id: crypto.randomUUID(), name: "quota", collection_name: "posts", event, code: BROKEN, enabled: 1, created_at: now, updated_at: now });
    invalidateHookCache();
  }

  it("blocks the write it would have guarded", async () => {
    await createPublicCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    await storeBroken("beforeCreate");
    const err = await createRecord("posts", { title: "x" }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(JSON.stringify((err as ValidationError).details ?? (err as Error).message)).toContain("does not compile");
  });

  it("an after-hook that doesn't compile doesn't fail the write", async () => {
    await createPublicCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    await storeBroken("afterCreate");
    const rec = await createRecord("posts", { title: "x" });
    expect(rec.id).toBeTruthy();
  });
});
