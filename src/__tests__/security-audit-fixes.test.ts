/**
 * Regression tests for the 2026-10-13 audit:
 *  - sign-up (register / anonymous / promote) honours the create rule,
 *    and existing auth collections are opened once on upgrade;
 *  - file field values must be storage filenames;
 *  - `@request.body.<key>` reads the exact key, not a lowercased decoy;
 *  - a caller's filter joins other collections under their list rule too.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { initDb, closeDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { createCollection, getCollection } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { evaluateRule } from "../core/rules.ts";
import { parseFilter, type CollectionLookup } from "../core/filter.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { setSetting } from "../api/settings.ts";
import { onSqlite } from "./_helpers.ts";

const SECRET = "test-secret-audit-fixes";
const PASSWORD = "a-long-enough-password-1";
let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-audit-"));
  setLogsDir(tmpDir);
  await initDb(":memory:");
  await runMigrations();
});

afterEach(async () => {
  await closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

function req(method: string, url: string, body?: unknown, token?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://localhost${url}`, init);
}

describe("sign-up honours the auth collection's create rule", () => {
  it("refuses /register when the create rule is admin-only (the default)", async () => {
    await createCollection({ name: "staff", type: "auth", fields: JSON.stringify([]) });
    const res = await makeAuthPlugin(SECRET).handle(
      req("POST", "/auth/staff/register", { email: "x@test.local", password: PASSWORD }),
    );
    expect(res.status).toBe(403);
    expect(await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM vb_staff`)).toEqual({ n: 0 });
  });

  it("allows /register when the create rule is public", async () => {
    await createCollection({ name: "users", type: "auth", create_rule: null, fields: JSON.stringify([]) });
    const res = await makeAuthPlugin(SECRET).handle(
      req("POST", "/auth/users/register", { email: "x@test.local", password: PASSWORD }),
    );
    expect(res.status).toBe(200);
  });

  it("evaluates the rule against the sign-up body", async () => {
    await createCollection({
      name: "users", type: "auth",
      fields: JSON.stringify([{ name: "role", type: "text" }]),
      create_rule: "@request.body.role:isset = false",
    });
    const app = makeAuthPlugin(SECRET);
    const bad = await app.handle(
      req("POST", "/auth/users/register", { email: "a@test.local", password: PASSWORD, role: "admin" }),
    );
    expect(bad.status).toBe(403);
    const ok = await app.handle(req("POST", "/auth/users/register", { email: "b@test.local", password: PASSWORD }));
    expect(ok.status).toBe(200);
  });

  it("refuses /anonymous when the create rule is admin-only", async () => {
    setSetting("auth.anonymous.enabled", "1");
    await createCollection({ name: "staff", type: "auth", fields: JSON.stringify([]) });
    const res = await makeAuthPlugin(SECRET).handle(req("POST", "/auth/staff/anonymous"));
    expect(res.status).toBe(403);
  });

  it("refuses /promote when the rule rejects the body", async () => {
    setSetting("auth.anonymous.enabled", "1");
    await createCollection({
      name: "users", type: "auth",
      fields: JSON.stringify([{ name: "role", type: "text" }]),
      create_rule: "@request.body.role:isset = false",
    });
    const app = makeAuthPlugin(SECRET);
    const anon = await app.handle(req("POST", "/auth/users/anonymous"));
    expect(anon.status).toBe(200);
    const { data } = await anon.json() as { data: { token: string } };
    const res = await app.handle(
      req("POST", "/auth/users/promote", { email: "p@test.local", password: PASSWORD, role: "admin" }, data.token),
    );
    expect(res.status).toBe(403);
  });

  it.skipIf(!onSqlite)("upgrade opens existing admin-only auth collections once, then leaves them alone", async () => {
    await createCollection({ name: "users", type: "auth", fields: JSON.stringify([]) });
    await createCollection({ name: "notes", type: "base", fields: JSON.stringify([]) });
    // Simulate a pre-v0.18 database: the one-time marker isn't there yet.
    await db.run(`DELETE FROM vaultbase_settings WHERE key = '_migrations.v0_18_auth_create_rule'`);
    await runMigrations();
    const rule = async (name: string) =>
      (await db.get<{ create_rule: string | null }>(`SELECT create_rule FROM vaultbase_collections WHERE name = ?`, [name]))!.create_rule;
    expect(await rule("users")).toBeNull();
    expect(await rule("notes")).toBe(""); // base collections untouched

    // An admin closes sign-up again; later boots keep it closed.
    await db.run(`UPDATE vaultbase_collections SET create_rule = '' WHERE name = 'users'`);
    await runMigrations();
    expect(await rule("users")).toBe("");
  });

  it("a fresh install leaves new auth collections admin-only", async () => {
    await createCollection({ name: "users", type: "auth", fields: JSON.stringify([]) });
    await runMigrations();
    expect((await getCollection("users"))?.create_rule).toBe("");
  });
});

describe("file field values must be storage filenames", () => {
  async function seedDocs() {
    await createCollection({
      name: "docs", type: "base",
      fields: JSON.stringify([
        { name: "attachment", type: "file", options: { protected: true } },
        { name: "gallery", type: "file", options: { multiple: true } },
      ]),
      list_rule: null, view_rule: null, create_rule: null, update_rule: null, delete_rule: null,
    });
  }

  it("rejects a path in a single file field", async () => {
    await seedDocs();
    const res = await makeRecordsPlugin(SECRET).handle(
      req("POST", "/docs", { attachment: "../../../../admin/users/users/x/disable-mfa?" }),
    );
    expect(res.status).toBe(422);
  });

  it("rejects a path inside a multi-file array and a multi-file JSON string", async () => {
    await seedDocs();
    const app = makeRecordsPlugin(SECRET);
    expect((await app.handle(req("POST", "/docs", { gallery: ["ok.png", "../x"] }))).status).toBe(422);
    expect((await app.handle(req("POST", "/docs", { gallery: JSON.stringify(["../x"]) }))).status).toBe(422);
  });

  it("accepts stored names", async () => {
    await seedDocs();
    const res = await makeRecordsPlugin(SECRET).handle(
      req("POST", "/docs", { attachment: `${crypto.randomUUID()}.png`, gallery: ["a.png", "b.jpg"] }),
    );
    expect(res.status).toBe(200);
  });
});

describe("@request.body reads the exact key", () => {
  const USER = { id: "u1", type: "user" as const, email: "u1@test.local" };
  const ctx = (body: Record<string, unknown>) => ({
    method: "PATCH", context: "default", headers: {}, query: {}, body, existing: null,
  });

  it("a lowercase decoy can't stand in for a camelCase field", () => {
    const rule = "@request.body.isApproved != true";
    expect(evaluateRule(rule, USER, {}, ctx({ isApproved: true, isapproved: false }))).toBe(false);
    expect(evaluateRule(rule, USER, {}, ctx({ isApproved: false }))).toBe(true);
  });

  it("the compiled filter reads the exact key too", () => {
    const r = parseFilter("@request.body.ownerId = 'me'", "vb_posts", {
      auth: USER, request: ctx({ ownerId: "victim", ownerid: "me" }),
    });
    expect(r?.params).toEqual(["victim", "me"]); // the body value, then the literal
  });

  it(":isset ignores inherited properties", () => {
    expect(evaluateRule("@request.body.constructor:isset = true", USER, {}, ctx({}))).toBe(false);
  });

  it("headers are still matched case-insensitively", () => {
    const c = { ...ctx({}), headers: { x_org: "acme" } };
    expect(evaluateRule("@request.headers.X_Org = 'acme'", USER, {}, c)).toBe(true);
  });
});

describe("client filters join other collections under their list rule", () => {
  const USER = { id: "u1", type: "user" as const, email: "u1@test.local" };
  const lookup: CollectionLookup = (n) => n === "invites"
    ? { viewRule: null, listRule: "", hasField: () => true, isPrivateField: () => false, isFilterable: () => true }
    : null;

  it("an admin-only list rule denies the join for a caller's filter", () => {
    const r = parseFilter(`@collection.invites.code = "AB"`, "vb_posts", { auth: USER, lookup, clientFilter: true });
    expect(r?.sql).toContain(db.dialect.never);
  });

  it("admin-written rules still join under the view rule only", () => {
    const r = parseFilter(`@collection.invites.code = "AB"`, "vb_posts", { auth: USER, lookup });
    expect(r?.sql).not.toContain("1=0");
  });

  it("view-by-id-only records can't be probed through ?filter=", async () => {
    await createCollection({
      name: "invites", type: "base", fields: JSON.stringify([{ name: "code", type: "text" }]),
      list_rule: "", view_rule: null, create_rule: "", update_rule: "", delete_rule: "",
    });
    await createCollection({
      name: "posts", type: "base", fields: JSON.stringify([{ name: "title", type: "text" }]),
      list_rule: null, view_rule: null, create_rule: null, update_rule: null, delete_rule: null,
    });
    await createRecord("invites", { code: "SECRET-CODE" });
    await createRecord("posts", { title: "hello" });
    const res = await makeRecordsPlugin(SECRET).handle(
      new Request(`http://localhost/posts?filter=${encodeURIComponent('@collection.invites.code ~ "SECRET"')}`),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[] };
    expect(body.data).toHaveLength(0);
  });
});
