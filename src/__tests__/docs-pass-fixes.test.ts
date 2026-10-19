/**
 * Fixes from checking the docs against the server (2026-10-19), each a case
 * where the server didn't do what the docs said:
 *  - an API token sent as the docs show (`Bearer vbat_…`) counted as
 *    anonymous on the records and batch APIs;
 *  - creating a record in an auth collection answered 500 in plain text;
 *  - a single-record rule check (view by id, realtime) admitted records the
 *    list query hid, whenever a compared value was NULL;
 *  - `created` / `updated` worked in sort but not in filters, and list and
 *    view rules needed different names for the same timestamp.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { admin } from "../db/schema.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { mintApiToken } from "../core/api-tokens.ts";
import { evaluateRule } from "../core/rules.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { makeBatchPlugin } from "../api/batch.ts";
import { createPublicCollection, ensureAuthCollection } from "./_helpers.ts";
import { signAuthToken } from "../core/sec.ts";

const SECRET = "test-secret-docs-pass";
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "vb-docs-pass-"));
  setLogsDir(dir);
  await initDb(":memory:");
  await runMigrations();
  await getDb().insert(admin).values({ id: "a1", email: "ops@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
});

afterEach(async () => {
  _resetCollectionCache();
  await closeDb();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
});

const call = async (method: string, path: string, token?: string, body?: unknown) => {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await makeRecordsPlugin(SECRET).handle(new Request(`http://localhost${path}`, {
    method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));
  const text = await res.text();
  let json: any; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, type: res.headers.get("content-type") ?? "" };
};

describe("API tokens as the docs show them (Bearer vbat_…)", () => {
  it("a read token lists an admin-only collection", async () => {
    await createPublicCollection({ name: "secrets", fields: JSON.stringify([{ name: "v", type: "text" }]), list_rule: "", view_rule: "" });
    await createRecord("secrets", { v: "x" });
    const { token } = await mintApiToken({ name: "ci", scopes: ["read"], createdBy: "a1", createdByEmail: "ops@test.local" }, SECRET);
    expect(token.startsWith("vbat_")).toBe(true);
    const r = await call("GET", "/secrets", token);
    expect(r.status).toBe(200);
    expect(r.json.data).toHaveLength(1);
  });

  it("an admin token writes through the batch API", async () => {
    await createPublicCollection({ name: "notes", fields: JSON.stringify([{ name: "t", type: "text" }]), create_rule: "" });
    const { token } = await mintApiToken({ name: "ci", scopes: ["admin"], createdBy: "a1", createdByEmail: "ops@test.local" }, SECRET);
    const res = await makeBatchPlugin(SECRET).handle(new Request("http://localhost/batch", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ requests: [{ method: "POST", url: "/api/v1/notes", body: { t: "hi" } }] }),
    }));
    expect(res.status).toBe(200);
  });

  it("an unknown token is still nobody (legitimate path)", async () => {
    await createPublicCollection({ name: "secrets", fields: JSON.stringify([{ name: "v", type: "text" }]), list_rule: "", view_rule: "" });
    expect((await call("GET", "/secrets", "vbat_not.a.token")).status).toBe(403);
  });
});

describe("creating a record in an auth collection", () => {
  it("is a 405 with a JSON error that points to sign-up", async () => {
    await ensureAuthCollection("users");
    const adminToken = (await signAuthToken({ payload: { id: "a1", email: "ops@test.local" }, audience: "admin", expiresInSeconds: 600, jwtSecret: SECRET })).token;
    const r = await call("POST", "/users", adminToken, { email: "x@test.local" });
    expect(r.status).toBe(405);
    expect(r.type).toContain("application/json");
    expect(r.json.error).toContain("/api/v1/auth/users/register");
  });
});

describe("single-record checks treat NULL as the list query does", () => {
  const user = { id: "u1", type: "user" as const };
  it("a comparison with a missing value never passes", () => {
    expect(evaluateRule('status != "secret"', user, { status: null })).toBe(false);
    // `~` / `!~` follow SQL's coalesce(LIKE, false): a missing side is false for ~, true for !~.
    expect(evaluateRule('status ~ "x"', user, {})).toBe(false);
    expect(evaluateRule('status !~ "x"', user, {})).toBe(true);
    expect(evaluateRule("score < 5", user, { score: null })).toBe(false);
    expect(evaluateRule("tags:length = 0", user, { tags: null })).toBe(false);
  });

  it("`= null` / `!= null` still test for a missing value (legitimate path)", () => {
    expect(evaluateRule("status = null", user, { status: null })).toBe(true);
    expect(evaluateRule("status != null", user, { status: null })).toBe(false);
    expect(evaluateRule("status != null", user, { status: "draft" })).toBe(true);
    expect(evaluateRule('status != "secret"', user, { status: "draft" })).toBe(true);
    expect(evaluateRule("tags:length = 0", user, { tags: [] })).toBe(true);
  });

  it("view by id refuses what the list hides", async () => {
    await createPublicCollection({
      name: "docs",
      fields: JSON.stringify([{ name: "title", type: "text" }, { name: "status", type: "text" }]),
      list_rule: 'status != "secret"', view_rule: 'status != "secret"',
    });
    const blank = await createRecord("docs", { title: "no status" });
    const listed = await call("GET", "/docs");
    expect(listed.json.data).toHaveLength(0);
    expect((await call("GET", `/docs/${blank.id}`)).status).not.toBe(200);
  });
});

describe("created / updated", () => {
  it("filter by either name, as sort does", async () => {
    await createPublicCollection({ name: "items", fields: JSON.stringify([{ name: "t", type: "text" }]) });
    await createRecord("items", { t: "a" });
    for (const f of ["created > 0", "created_at > 0", "updated >= 0", "updated_at >= 0"]) {
      const r = await call("GET", `/items?filter=${encodeURIComponent(f)}`);
      expect(r.status).toBe(200);
      expect(r.json.data).toHaveLength(1);
    }
  });

  it("list and view rules agree on either name", async () => {
    for (const [name, rule] of [["c1", "created > 0"], ["c2", "created_at > 0"]] as const) {
      await createPublicCollection({ name, fields: JSON.stringify([{ name: "t", type: "text" }]), list_rule: rule, view_rule: rule });
      const rec = await createRecord(name, { t: "a" });
      expect((await call("GET", `/${name}`)).json.data).toHaveLength(1);
      expect((await call("GET", `/${name}/${rec.id}`)).status).toBe(200);
    }
  });
});

describe("list totals under a rule that reads another collection", () => {
  it("drop when the other collection changes", async () => {
    const { deleteRecord, listRecords } = await import("../core/records.ts");
    await createPublicCollection({ name: "members", fields: JSON.stringify([{ name: "user", type: "text" }]) });
    await createPublicCollection({ name: "board", fields: JSON.stringify([{ name: "t", type: "text" }]) });
    const m = await createRecord("members", { user: "u1" });
    await createRecord("board", { t: "x" });
    const rule = "@collection.members.user = @request.auth.id";
    const asU1 = () => listRecords("board", { accessRule: rule, auth: { id: "u1", type: "user" } });
    expect((await asU1()).totalItems).toBe(1);
    await deleteRecord("members", m.id);
    const after = await asU1();
    expect(after.data).toHaveLength(0);
    expect(after.totalItems).toBe(0);
  });
});
