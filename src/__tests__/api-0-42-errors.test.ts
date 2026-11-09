/**
 * 0.42 error detail (DX audit F-02, F-05, F-06, F-15):
 * - a 403 says which operation was refused and why, never the rule;
 * - a refused request with a token the server didn't accept says token_invalid;
 * - unknown sort/expand/fields/body keys come back as a Vaultbase-Warning header;
 * - registering a taken email answers 409.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection } from "../core/collections.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { seedAuthUser, signUserJwt } from "./_helpers.ts";

const SECRET = "test-secret-042-errors";
let userToken = "";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  await createCollection({ name: "users", type: "auth", create_rule: null, fields: JSON.stringify([]) });
  const uid = await seedAuthUser({ collection: "users", email: "u@test.local", passwordHash: await Bun.password.hash("pw-123456789012") });
  userToken = await signUserJwt(uid, "u@test.local", "users", SECRET);
  await createCollection({
    name: "posts",
    fields: JSON.stringify([
      { name: "title", type: "text" },
      { name: "author", type: "relation", options: { collection: "users" } },
    ]),
    list_rule: null,
    view_rule: null,
    create_rule: "@request.auth.id != \"\"",
    update_rule: "\"a\" = \"b\"",
    delete_rule: "",
  });
});

afterEach(() => closeDb());

const records = (path: string, init: RequestInit = {}) =>
  makeRecordsPlugin(SECRET).handle(new Request(`http://localhost${path}`, init));
const json = (method: string, body: unknown, token?: string): RequestInit => ({
  method,
  headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

describe("403 body", () => {
  it("not signed in", async () => {
    const res = await records("/posts", json("POST", { title: "x" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden", code: 403, operation: "create", reason: "not_signed_in" });
  });

  it("a token the server didn't accept", async () => {
    const res = await records("/posts", json("POST", { title: "x" }, "not-a-real-token"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ operation: "create", reason: "token_invalid" });
  });

  it("signed in, rule says no", async () => {
    const created = await records("/posts", json("POST", { title: "x" }, userToken));
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    const res = await records(`/posts/${id}`, json("PATCH", { title: "y" }, userToken));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ operation: "update", reason: "rule_denied" });
    const del = await records(`/posts/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${userToken}` } });
    expect(await del.json()).toMatchObject({ operation: "delete", reason: "admin_only" });
  });

  it("never includes the rule expression", async () => {
    const res = await records("/posts", json("POST", { title: "x" }));
    expect(await res.text()).not.toContain("@request");
  });
});

describe("Vaultbase-Warning", () => {
  it("names unknown sort, expand and fields keys", async () => {
    const res = await records("/posts?sort=-titel&expand=autor&fields=id,titel");
    expect(res.status).toBe(200);
    const w = res.headers.get("vaultbase-warning") ?? "";
    expect(w).toContain("unknown sort field 'titel'");
    expect(w).toContain("unknown expand 'autor'");
    expect(w).toContain("unknown field 'titel' in fields");
  });

  it("no header when every key is known", async () => {
    const res = await records("/posts?sort=-created,title&expand=author&fields=id,title");
    expect(res.headers.get("vaultbase-warning")).toBeNull();
  });

  it("names body keys that aren't fields", async () => {
    const res = await records("/posts", json("POST", { title: "x", colour: "red" }, userToken));
    expect(res.status).toBe(200);
    expect(res.headers.get("vaultbase-warning")).toBe("unknown field 'colour' in body (ignored)");
  });
});

describe("register", () => {
  it("a taken email answers 409", async () => {
    const res = await makeAuthPlugin(SECRET).handle(new Request("http://localhost/auth/users/register", json("POST", { email: "u@test.local", password: "another-password-1" })));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Email already registered", code: 409 });
  });
});
