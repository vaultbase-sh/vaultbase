/**
 * The four code-entity admin APIs (hooks, routes, jobs, workers) share
 * their row handling (api/_code-files.ts). Each answers the same way:
 * list, create, update, a missing one, refused code, delete.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as jose from "jose";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { admin as adminTable } from "../db/schema.ts";
import { makeHooksPlugin } from "../api/hooks.ts";
import { makeRoutesPlugin } from "../api/routes.ts";
import { makeJobsPlugin } from "../api/jobs.ts";
import { makeQueuesPlugin } from "../api/queues.ts";
import { invalidateHookCache } from "../core/hooks.ts";

const SECRET = "test-secret-code-entities";
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
  await closeDb();
});

const ENTITIES = [
  { path: "hooks", noun: "Hook", plugin: () => makeHooksPlugin(SECRET), body: { name: "h", event: "beforeCreate", collection_name: "posts", code: "return;" } },
  { path: "routes", noun: "Route", plugin: () => makeRoutesPlugin(SECRET), body: { name: "r", method: "GET", path: "/hello", code: "return 1;" } },
  { path: "jobs", noun: "Job", plugin: () => makeJobsPlugin(SECRET), body: { name: "j", cron: "0 * * * *", code: "return;" } },
  { path: "workers", noun: "Worker", plugin: () => makeQueuesPlugin(SECRET), body: { name: "w", queue: "mail", code: "return;" } },
] as const;

async function call(plugin: { handle(r: Request): Promise<Response> }, method: string, path: string, body?: unknown) {
  const res = await plugin.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));
  return { status: res.status, body: await res.json() as { data?: Record<string, unknown> | Array<Record<string, unknown>> | null; error?: string } };
}

describe("code-entity admin APIs", () => {
  for (const e of ENTITIES) {
    it(`${e.path}: list, create, update, missing, refused code, delete`, async () => {
      const p = e.plugin();
      const base = `/admin/${e.path}`;
      expect((await call(p, "GET", base)).body.data).toEqual([]);

      const created = await call(p, "POST", base, e.body);
      expect(created.status).toBe(200);
      const row = created.body.data as Record<string, unknown>;
      expect(row["name"]).toBe(e.body.name);
      expect(row["enabled"]).toBe(1);

      const listed = (await call(p, "GET", base)).body.data as Array<Record<string, unknown>>;
      expect(listed.map((r) => r["id"])).toEqual([row["id"]]);

      const patched = await call(p, "PATCH", `${base}/${row["id"]}`, { name: "renamed", enabled: false });
      expect(patched.status).toBe(200);
      expect((patched.body.data as Record<string, unknown>)["name"]).toBe("renamed");
      expect((patched.body.data as Record<string, unknown>)["enabled"]).toBe(0);

      const missing = await call(p, "PATCH", `${base}/nope`, { name: "x" });
      expect(missing.status).toBe(404);
      expect(missing.body.error).toBe(`${e.noun} not found`);

      const bad = await call(p, "PATCH", `${base}/${row["id"]}`, { code: "if (x ===) {}" });
      expect(bad.status).toBe(422);
      expect(bad.body.error).toStartWith("Code does not compile:");
      const badCreate = await call(p, "POST", base, { ...e.body, code: "if (x ===) {}" });
      expect(badCreate.status).toBe(422);

      const deleted = await call(p, "DELETE", `${base}/${row["id"]}`);
      expect(deleted.status).toBe(200);
      expect(deleted.body.data).toBeNull();
      expect((await call(p, "GET", base)).body.data).toEqual([]);
    });
  }
});
