/**
 * `GET /api/v1/collections` and `/collections/:id` were open to anyone and
 * returned every collection's rules, field definitions and view SQL — a map
 * of what's protected and how. They are admin-only now, like the OpenAPI
 * document already was by default.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { admin } from "../db/schema.ts";
import { createCollection } from "../core/collections.ts";
import { makeCollectionsPlugin } from "../api/collections.ts";
import { signAuthToken } from "../core/sec.ts";
import { seedAuthUser, signUserJwt } from "./_helpers.ts";

const SECRET = "test-secret-collections-api";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  await createCollection({ name: "secrets", type: "base", fields: JSON.stringify([{ name: "x", type: "text" }]), list_rule: "owner = @request.auth.id" });
  await getDb().insert(admin).values({ id: "a1", email: "a@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
});

afterEach(() => closeDb());

const get = (path: string, bearer?: string) =>
  makeCollectionsPlugin(SECRET).handle(new Request(`http://localhost${path}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }));

describe("collections API", () => {
  it("anonymous callers get nothing", async () => {
    for (const p of ["/collections", "/collections/secrets"]) {
      const res = await get(p);
      expect(res.status).toBe(401);
      expect(JSON.stringify(await res.json())).not.toContain("owner = @request.auth.id");
    }
  });

  it("signed-in users get nothing either", async () => {
    const id = await seedAuthUser({ collection: "users", email: "u@test.local" });
    const jwt = await signUserJwt(id, "u@test.local", "users", SECRET);
    expect((await get("/collections", jwt)).status).toBe(401);
    expect((await get("/collections/secrets", jwt)).status).toBe(401);
  });

  it("admins still get the full definitions (legitimate path)", async () => {
    const { token } = await signAuthToken({ payload: { id: "a1", email: "a@test.local" }, audience: "admin", expiresInSeconds: 600, jwtSecret: SECRET });
    const list = await get("/collections", token);
    expect(list.status).toBe(200);
    expect(JSON.stringify(await list.json())).toContain("owner = @request.auth.id");
    expect((await get("/collections/secrets", token)).status).toBe(200);
  });
});
