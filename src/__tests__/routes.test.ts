import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { invalidateRoutesCache, dispatchCustomRoute } from "../core/routes.ts";
import { routes } from "../db/schema.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-routes-"));
  setLogsDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
  invalidateRoutesCache();
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function insertRoute(method: string, path: string, code: string, name = ""): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(routes).values({
    id: crypto.randomUUID(),
    name,
    method,
    path,
    code,
    enabled: 1,
    created_at: now,
    updated_at: now,
  });
  invalidateRoutesCache();
}

describe("custom routes dispatch", () => {
  it("matches exact path and returns body", async () => {
    await insertRoute("GET", "/hello", `return { data: "world" };`);
    const req = new Request("http://localhost/api/custom/hello");
    const res = await dispatchCustomRoute(req, "/hello", "secret");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.body).toEqual({ data: "world" });
  });

  it("captures :param segments", async () => {
    await insertRoute("GET", "/users/:id", `return { data: { id: ctx.params.id } };`);
    const req = new Request("http://localhost/api/custom/users/abc-123");
    const res = await dispatchCustomRoute(req, "/users/abc-123", "secret");
    expect(res).not.toBeNull();
    expect(res!.body).toEqual({ data: { id: "abc-123" } });
  });

  it("returns null when no route matches", async () => {
    await insertRoute("GET", "/foo", `return { data: 1 };`);
    const req = new Request("http://localhost/api/custom/bar");
    const res = await dispatchCustomRoute(req, "/bar", "secret");
    expect(res).toBeNull();
  });

  it("respects HTTP method", async () => {
    await insertRoute("POST", "/items", `return { data: "created" };`);
    const reqGet = new Request("http://localhost/api/custom/items");
    expect(await dispatchCustomRoute(reqGet, "/items", "secret")).toBeNull();
    const reqPost = new Request("http://localhost/api/custom/items", { method: "POST" });
    const res = await dispatchCustomRoute(reqPost, "/items", "secret");
    expect(res!.body).toEqual({ data: "created" });
  });

  it("exposes set.status to user code", async () => {
    await insertRoute("GET", "/teapot", `ctx.set.status = 418; return { error: "I'm a teapot" };`);
    const req = new Request("http://localhost/api/custom/teapot");
    const res = await dispatchCustomRoute(req, "/teapot", "secret");
    expect(res!.status).toBe(418);
  });
});
