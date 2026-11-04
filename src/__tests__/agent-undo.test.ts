/**
 * Undoing what an agent did: find its calls in the audit log by API token,
 * restore exactly the version shown (several writes can share one second),
 * bring back a record it deleted, and keep history on for new collections so
 * there is something to restore from.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as jose from "jose";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { createCollection, getCollection, updateCollection } from "../core/collections.ts";
import { createRecord, deleteRecord, getRecord, updateRecord } from "../core/records.ts";
import { listRecordHistory } from "../core/record-history.ts";
import { listAuditEntries, listAuditTokens } from "../core/audit-log.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { makeAuditLogPlugin } from "../api/audit-log.ts";
import { makeCollectionsPlugin } from "../api/collections.ts";
import { buildRegistry } from "../mcp/server.ts";
import type { ToolContext } from "../mcp/tools.ts";
import { admin as adminTable } from "../db/schema.ts";

const SECRET = "test-secret-agent-undo";
let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-agent-undo-"));
  setLogsDir(tmpDir);
  await initDb(":memory:");
  await runMigrations();
});

afterEach(async () => {
  await closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function signAdmin(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(adminTable).values({ id: "admin-1", email: "admin@test.local", password_hash: "x", password_reset_at: 0, created_at: now });
  return await new jose.SignJWT({ id: "admin-1", email: "admin@test.local", jti: crypto.randomUUID() })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("vaultbase")
    .setAudience("admin")
    .setIssuedAt(now)
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
}

const ctx = (tokenId: string, tokenName: string): ToolContext => ({
  tokenId, tokenName, scopes: ["mcp:read", "mcp:write"], adminId: "admin-1", adminEmail: "admin@test.local",
});

async function postsWithHistory() {
  const c = await createCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
  await updateCollection(c.id, { history_enabled: 1 } as Parameters<typeof updateCollection>[1]);
}

const restore = async (path: string, tok: string) =>
  makeRecordsPlugin(SECRET).handle(new Request(`http://localhost${path}`, { method: "POST", headers: { Authorization: `Bearer ${tok}` } }));

describe("audit log by API token", () => {
  it("stores the token on MCP calls and filters by it", async () => {
    await postsWithHistory();
    const reg = await buildRegistry(false);
    await reg.call("vaultbase.list_collections", {}, ctx("tok-a", "agent A"));
    await reg.call("vaultbase.list_collections", {}, ctx("tok-a", "agent A"));
    await reg.call("vaultbase.list_collections", {}, ctx("tok-b", "agent B"));

    const onlyA = await listAuditEntries({ tokenId: "tok-a" });
    expect(onlyA.totalItems).toBe(2);
    expect(onlyA.data.every((e) => e.token_id === "tok-a" && e.token_name === "agent A")).toBe(true);

    const tokens = await listAuditTokens();
    expect(tokens.map((t) => [t.token_id, t.token_name, t.calls]).sort()).toEqual([["tok-a", "agent A", 2], ["tok-b", "agent B", 1]]);
  });

  it("serves the filter and the token list to admins only", async () => {
    const reg = await buildRegistry(false);
    await reg.call("vaultbase.list_collections", {}, ctx("tok-a", "agent A"));
    const tok = await signAdmin();
    const app = makeAuditLogPlugin(SECRET);
    const list = await app.handle(new Request("http://localhost/admin/audit-log?tokenId=tok-a", { headers: { Authorization: `Bearer ${tok}` } }));
    expect(list.status).toBe(200);
    expect(((await list.json()) as { data: { totalItems: number } }).data.totalItems).toBe(1);
    const none = await app.handle(new Request("http://localhost/admin/audit-log?tokenId=nope", { headers: { Authorization: `Bearer ${tok}` } }));
    expect(((await none.json()) as { data: { totalItems: number } }).data.totalItems).toBe(0);
    const tokens = await app.handle(new Request("http://localhost/admin/audit-log/tokens", { headers: { Authorization: `Bearer ${tok}` } }));
    expect(((await tokens.json()) as { data: Array<{ token_id: string }> }).data.map((t) => t.token_id)).toEqual(["tok-a"]);
    const anon = await app.handle(new Request("http://localhost/admin/audit-log/tokens"));
    expect(anon.status).toBe(401);
  });

  it("admin-session entries carry no token", async () => {
    const reg = await buildRegistry(false);
    await reg.call("vaultbase.list_collections", {}, ctx("tok-a", "agent A"));
    await postsWithHistory();
    const r = await createRecord("posts", { title: "v1" }, null);
    await updateRecord("posts", r.id, { title: "v2" }, null);
    const tok = await signAdmin();
    const [first] = (await listRecordHistory("posts", r.id)).data.slice(-1);
    await restore(`/posts/${r.id}/restore?entry=${first!.id}`, tok);
    const e = (await listAuditEntries({ actionPrefix: "record.restore" })).data[0]!;
    expect(e.token_id).toBeNull();
  });
});

describe("audit targets of per-collection tools", () => {
  it("name the collection, and the record a create made, so the entry leads to it", async () => {
    await postsWithHistory();
    const reg = await buildRegistry(false);
    const c = ctx("tok-a", "agent A");
    await reg.call("vaultbase.create_posts", { data: { title: "x" } }, c);
    const [created] = (await listRecordHistory("posts", (await listAuditEntries({ tokenId: "tok-a" })).data[0]!.target!.split("id=")[1]!)).data;
    expect(created?.op).toBe("create");
    const id = created!.record_id;
    await reg.call("vaultbase.update_posts", { id, data: { title: "y" } }, c);
    await reg.call("vaultbase.delete_posts", { id }, c);
    const targets = (await listAuditEntries({ tokenId: "tok-a" })).data.map((e) => [e.path, e.target]);
    expect(targets).toContainEqual(["vaultbase.create_posts", `collection=posts id=${id}`]);
    expect(targets).toContainEqual(["vaultbase.update_posts", `collection=posts id=${id}`]);
    expect(targets).toContainEqual(["vaultbase.delete_posts", `collection=posts id=${id}`]);
    // The created id stays with its own call, not the shared context.
    expect(c.auditRecordId).toBeUndefined();
  });
});

describe("restore", () => {
  it("restores exactly the version picked, among writes in the same second", async () => {
    await postsWithHistory();
    const r = await createRecord("posts", { title: "v1" }, null);
    await updateRecord("posts", r.id, { title: "v2" }, null);
    await updateRecord("posts", r.id, { title: "v3" }, null);
    const versions = (await listRecordHistory("posts", r.id)).data; // newest first
    const v1 = versions.find((v) => v.snapshot["title"] === "v1")!;
    const tok = await signAdmin();
    const res = await restore(`/posts/${r.id}/restore?entry=${v1.id}`, tok);
    expect(res.status).toBe(200);
    expect((await getRecord("posts", r.id))?.["title"]).toBe("v1");
  });

  it("refuses an entry id of another record", async () => {
    await postsWithHistory();
    const a = await createRecord("posts", { title: "a" }, null);
    const b = await createRecord("posts", { title: "b" }, null);
    const [bv] = (await listRecordHistory("posts", b.id)).data;
    const tok = await signAdmin();
    const res = await restore(`/posts/${a.id}/restore?entry=${bv!.id}`, tok);
    expect(res.status).toBe(404);
    expect((await getRecord("posts", a.id))?.["title"]).toBe("a");
  });

  it("audits a restore with who, which record and which version", async () => {
    await postsWithHistory();
    const r = await createRecord("posts", { title: "v1" }, null);
    await updateRecord("posts", r.id, { title: "v2" }, null);
    const v1 = (await listRecordHistory("posts", r.id)).data.find((v) => v.snapshot["title"] === "v1")!;
    const tok = await signAdmin();
    await restore(`/posts/${r.id}/restore?entry=${v1.id}`, tok);
    const [e] = (await listAuditEntries({ actionPrefix: "record.restore" })).data;
    expect(e).toMatchObject({ actor_id: "admin-1", action: "record.restore", target: `collection=posts id=${r.id}`, status: 200 });
    expect(e!.summary).toContain(v1.id);
  });

  it("undoes a delete: same id, values and creation time, and the restore is recorded", async () => {
    await postsWithHistory();
    const r = await createRecord("posts", { title: "keep me" }, null);
    await deleteRecord("posts", r.id, null);
    const [del] = (await listRecordHistory("posts", r.id)).data;
    expect(del!.op).toBe("delete");
    const tok = await signAdmin();
    const res = await restore(`/posts/${r.id}/restore?entry=${del!.id}`, tok);
    expect(res.status).toBe(200);
    const back = await getRecord("posts", r.id);
    expect(back).toMatchObject({ id: r.id, title: "keep me", created: r.created });
    const ops = (await listRecordHistory("posts", r.id)).data.map((v) => v.op);
    expect(ops).toEqual(["create", "delete", "create"]);
    const [e] = (await listAuditEntries({ actionPrefix: "record.restore" })).data;
    expect(e!.summary).toContain("undeleted");
  });

  it("refuses to bring back a deleted record into a non-base collection", async () => {
    const c = await createCollection({ name: "members", type: "auth", fields: "[]" });
    await updateCollection(c.id, { history_enabled: 1 } as Parameters<typeof updateCollection>[1]);
    const col = (await getCollection("members"))!;
    // A delete entry for a record that isn't there, as an auth user's delete leaves.
    const { maybeRecordHistory } = await import("../core/record-history.ts");
    await maybeRecordHistory(col, "u1", { op: "delete", snapshot: { id: "u1", email: "x@test.local" }, auth: null });
    const tok = await signAdmin();
    const [del] = (await listRecordHistory("members", "u1")).data;
    const res = await restore(`/members/u1/restore?entry=${del!.id}`, tok);
    expect(res.status).toBe(409);
  });
});

describe("history on by default", () => {
  const post = async (body: Record<string, unknown>, tok: string) =>
    makeCollectionsPlugin(SECRET).handle(new Request("http://localhost/collections", {
      method: "POST",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));

  it("a collection created over the API keeps history unless turned off", async () => {
    const tok = await signAdmin();
    expect((await post({ name: "a", fields: [{ name: "t", type: "text" }] }, tok)).status).toBe(200);
    expect((await post({ name: "b", fields: [{ name: "t", type: "text" }], history_enabled: false }, tok)).status).toBe(200);
    expect((await post({ name: "c", type: "singleton", fields: [{ name: "t", type: "text" }] }, tok)).status).toBe(200);
    expect((await getCollection("a"))?.history_enabled).toBe(1);
    expect((await getCollection("b"))?.history_enabled).toBe(0);
    expect((await getCollection("c"))?.history_enabled).toBe(1);
  });

  it("views don't get it", async () => {
    const tok = await signAdmin();
    await post({ name: "a", fields: [{ name: "t", type: "text" }] }, tok);
    const res = await post({ name: "v", type: "view", view_query: "SELECT id, t FROM vb_a" }, tok);
    expect(res.status).toBe(200);
    expect((await getCollection("v"))?.history_enabled).toBe(0);
  });

  it("the MCP create_collection tool does the same", async () => {
    const reg = await buildRegistry(false);
    const admin = { ...ctx("tok-a", "agent A"), scopes: ["mcp:read", "mcp:write", "mcp:admin"] };
    await reg.call("vaultbase.create_collection", { name: "m1", type: "base", fields: [{ name: "t", type: "text" }] }, admin);
    await reg.call("vaultbase.create_collection", { name: "m2", type: "base", fields: [{ name: "t", type: "text" }], history_enabled: false }, admin);
    expect((await getCollection("m1"))?.history_enabled).toBe(1);
    expect((await getCollection("m2"))?.history_enabled).toBe(0);
  });
});
