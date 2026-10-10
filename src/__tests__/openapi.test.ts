/**
 * GET /openapi.json — generated from the live schema; admin-only unless
 * `api.openapi_public` is on, and then without admin-only collections.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { admin } from "../db/schema.ts";
import { createCollection } from "../core/collections.ts";
import { signAuthToken } from "../core/sec.ts";
import { setSetting } from "../api/settings.ts";
import { makeOpenApiPlugin } from "../api/openapi.ts";

const SECRET = "test-secret-openapi";
let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-openapi-"));
  setLogsDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
  await getDb().insert(admin).values({ id: "a1", email: "a@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
  await createCollection({
    name: "blog_posts", type: "base",
    fields: JSON.stringify([
      { name: "title", type: "text", required: true },
      { name: "status", type: "select", options: { values: ["draft", "live"] } },
      { name: "tags", type: "relation", collection: "tags", options: { multiple: true } },
      { name: "published", type: "date" },
      { name: "cover", type: "file" },
    ]),
    list_rule: null, view_rule: null, create_rule: null, update_rule: null, delete_rule: null,
  });
  await createCollection({
    name: "internal", type: "base", fields: JSON.stringify([{ name: "note", type: "text" }]),
    list_rule: "", view_rule: "", create_rule: "", update_rule: "", delete_rule: "",
  });
  await createCollection({ name: "users", type: "auth", fields: "[]" });
});

afterEach(() => {
  closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

type Spec = { paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, { properties?: Record<string, unknown>; required?: string[] }> } };

async function fetchSpec(token?: string) {
  const res = await makeOpenApiPlugin(SECRET).handle(new Request("http://localhost/openapi.json", {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }));
  return { status: res.status, spec: (await res.json()) as Spec };
}

async function adminToken() {
  return (await signAuthToken({ payload: { id: "a1" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET })).token;
}

describe("openapi.json", () => {
  it("is admin-only by default", async () => {
    expect((await fetchSpec()).status).toBe(401);
    expect((await fetchSpec(await adminToken())).status).toBe(200);
  });

  it("describes collections from the live schema", async () => {
    const { spec } = await fetchSpec(await adminToken());
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining([
      "/api/v1/blog_posts", "/api/v1/blog_posts/{id}", "/api/v1/blog_posts/_aggregate",
      "/api/v1/internal", "/api/v1/auth/users/login", "/api/v1/files/{filename}",
    ]));
    const rec = spec.components.schemas["BlogPosts"]!;
    expect(rec.properties!["status"]).toEqual({ type: "string", enum: ["draft", "live"] });
    expect(rec.properties!["tags"]).toMatchObject({ type: "array" });
    expect(rec.properties!["published"]).toMatchObject({ type: "integer" });
    const input = spec.components.schemas["BlogPostsInput"]!;
    expect(input.required).toEqual(["title"]);
    expect(input.properties!["cover"]).toBeUndefined();
  });

  it("has no dangling $refs", async () => {
    const { spec } = await fetchSpec(await adminToken());
    const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(0);
    for (const r of refs) expect(spec.components.schemas[r]).toBeDefined();
  });

  it("when public, hides admin-only collections", async () => {
    setSetting("api.openapi_public", "1");
    const { status, spec } = await fetchSpec();
    expect(status).toBe(200);
    expect(spec.paths["/api/v1/blog_posts"]).toBeDefined();
    expect(spec.paths["/api/v1/internal"]).toBeUndefined();
    expect(spec.components.schemas["Internal"]).toBeUndefined();
  });

  it("uses a relative server URL", async () => {
    const { spec } = await fetchSpec(await adminToken());
    expect((spec as unknown as { servers: Array<{ url: string }> }).servers).toEqual([{ url: "/" }]);
  });
});
