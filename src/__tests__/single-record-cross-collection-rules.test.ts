/**
 * Single-record checks (view, update and delete by id, batch, file access)
 * answer rules that read other collections (`@collection.*`, `_via_`) the
 * way a list does, from the database (0.48). Before, any comparison using
 * one was false there, so a tenant rule like "the account is mine and
 * active" refused every by-id request while the list served the record.
 *
 * Realtime delivery still checks in process, where such a comparison stays
 * false (rules-cross-collection-eval.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDb, initDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { createCollection, getCollection } from "../core/collections.ts";
import { createRecord, getRecord, recordPassesRuleSql } from "../core/records.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { makeBatchPlugin } from "../api/batch.ts";
import { seedAuthUser, signUserJwt } from "./_helpers.ts";

const SECRET = "test-secret-single-record-xcol";
let tmpDir: string;
let alice = "", bob = "", aliceToken = "", bobToken = "";
let aliceAccount = "", bobAccount = "", closedAccount = "";
let invoice = "", closedInvoice = "";

const TENANT = "@collection.accounts.id = account && @collection.accounts.owner = @request.auth.id && @collection.accounts.active = true";

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-xcol-"));
  setLogsDir(tmpDir);
  await initDb(":memory:");
  await runMigrations();
  await createCollection({ name: "users", type: "auth", create_rule: null, list_rule: null, view_rule: null, update_rule: null, fields: JSON.stringify([]) });
  alice = await seedAuthUser({ collection: "users", email: "alice@test.local" });
  bob = await seedAuthUser({ collection: "users", email: "bob@test.local" });
  aliceToken = await signUserJwt(alice, "alice@test.local", "users", SECRET);
  bobToken = await signUserJwt(bob, "bob@test.local", "users", SECRET);
  await createCollection({
    name: "accounts",
    fields: JSON.stringify([{ name: "owner", type: "relation", collection: "users" }, { name: "active", type: "bool" }]),
    list_rule: null, view_rule: null, create_rule: null, update_rule: null, delete_rule: null,
  });
  aliceAccount = (await createRecord("accounts", { owner: alice, active: true })).id as string;
  bobAccount = (await createRecord("accounts", { owner: bob, active: true })).id as string;
  closedAccount = (await createRecord("accounts", { owner: alice, active: false })).id as string;
  await createCollection({
    name: "invoices",
    fields: JSON.stringify([{ name: "title", type: "text" }, { name: "account", type: "relation", collection: "accounts" }]),
    list_rule: TENANT, view_rule: TENANT, create_rule: null, update_rule: TENANT, delete_rule: TENANT,
  });
  invoice = (await createRecord("invoices", { title: "a1", account: aliceAccount })).id as string;
  closedInvoice = (await createRecord("invoices", { title: "a2", account: closedAccount })).id as string;
});

afterEach(async () => {
  await closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

const records = (path: string, init: RequestInit = {}) =>
  makeRecordsPlugin(SECRET).handle(new Request(`http://localhost${path}`, init));
const as = (token: string, method = "GET", body?: unknown): RequestInit => ({
  method,
  headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

describe("view by id", () => {
  it("serves what the list serves", async () => {
    const list = await records("/invoices", as(aliceToken));
    const listed = ((await list.json()) as { data: Array<{ id: string }> }).data.map((r) => r.id);
    expect(listed).toEqual([invoice]);
    expect((await records(`/invoices/${invoice}`, as(aliceToken))).status).toBe(200);
  });

  it("refuses another tenant, and an inactive account", async () => {
    const other = await records(`/invoices/${invoice}`, as(bobToken));
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({ operation: "view", reason: "rule_denied" });
    expect((await records(`/invoices/${closedInvoice}`, as(aliceToken))).status).toBe(403);
    expect((await records(`/invoices/${invoice}`)).status).toBe(403);
  });

  it("a negated comparison means no row matches", async () => {
    await createCollection({ name: "bans", fields: JSON.stringify([{ name: "user", type: "text" }]), list_rule: null, view_rule: null });
    await createRecord("bans", { user: bob });
    await createCollection({
      name: "posts",
      fields: JSON.stringify([{ name: "title", type: "text" }]),
      list_rule: null, view_rule: "@collection.bans.user != @request.auth.id",
    });
    const post = (await createRecord("posts", { title: "p" })).id as string;
    expect((await records(`/posts/${post}`, as(aliceToken))).status).toBe(200);
    expect((await records(`/posts/${post}`, as(bobToken))).status).toBe(403);
  });
});

describe("update by id", () => {
  it("lets the tenant update, and answers with the record", async () => {
    const res = await records(`/invoices/${invoice}`, as(aliceToken, "PATCH", { title: "renamed" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { title: string } | null }).data?.title).toBe("renamed");
  });

  it("checks the record the patch would leave: no moving it to another tenant", async () => {
    const res = await records(`/invoices/${invoice}`, as(aliceToken, "PATCH", { account: bobAccount }));
    expect(res.status).toBe(403);
    expect((await getRecord("invoices", invoice))?.account).toBe(aliceAccount);
    // Nor into an account that isn't active.
    expect((await records(`/invoices/${invoice}`, as(aliceToken, "PATCH", { account: closedAccount }))).status).toBe(403);
  });

  it("refuses another tenant", async () => {
    expect((await records(`/invoices/${invoice}`, as(bobToken, "PATCH", { title: "x" }))).status).toBe(403);
    expect((await getRecord("invoices", invoice))?.title).toBe("a1");
  });
});

describe("delete by id", () => {
  it("refuses another tenant, lets the tenant delete", async () => {
    expect((await records(`/invoices/${invoice}`, as(bobToken, "DELETE"))).status).toBe(403);
    expect(await getRecord("invoices", invoice)).not.toBeNull();
    expect((await records(`/invoices/${invoice}`, as(aliceToken, "DELETE"))).status).toBe(200);
    expect(await getRecord("invoices", invoice)).toBeNull();
  });
});

describe("batch", () => {
  const batch = (token: string, requests: Array<{ method: string; url: string; body?: unknown }>) =>
    makeBatchPlugin(SECRET).handle(new Request("http://localhost/batch", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ requests }),
    }));

  it("get and update follow the same answer", async () => {
    expect((await batch(aliceToken, [{ method: "GET", url: `/api/v1/invoices/${invoice}` }])).status).toBe(200);
    expect((await batch(bobToken, [{ method: "GET", url: `/api/v1/invoices/${invoice}` }])).status).toBe(403);
    const ok = await batch(aliceToken, [{ method: "PATCH", url: `/api/v1/invoices/${invoice}`, body: { title: "b" } }]);
    expect(ok.status).toBe(200);
    const moved = await batch(aliceToken, [{ method: "PATCH", url: `/api/v1/invoices/${invoice}`, body: { account: bobAccount } }]);
    expect(moved.status).toBe(403);
    expect((await getRecord("invoices", invoice))?.account).toBe(aliceAccount);
  });
});

describe("fails closed", () => {
  it("a rule over the join cap denies", async () => {
    const col = (await getCollection("invoices"))!;
    const rule = "@collection.accounts:a.active = true && @collection.accounts:b.active = true && @collection.accounts:c.active = true && @collection.accounts:d.active = true";
    expect(await recordPassesRuleSql(col, invoice, rule, { id: alice, type: "user", collection: "users" }, null)).toBe(false);
  });

  it("a missing record denies", async () => {
    const col = (await getCollection("invoices"))!;
    expect(await recordPassesRuleSql(col, crypto.randomUUID(), TENANT, { id: alice, type: "user", collection: "users" }, null)).toBe(false);
  });
});
