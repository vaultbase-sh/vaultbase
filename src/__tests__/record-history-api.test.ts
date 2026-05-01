import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as jose from "jose";

import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, updateCollection } from "../core/collections.ts";
import { createRecord, updateRecord } from "../core/records.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { admin as adminTable } from "../db/schema.ts";

const SECRET = "test-secret-record-history-api";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

async function signAdmin(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const id = "admin-1";
  await getDb().insert(adminTable).values({
    id,
    email: "admin@test.local",
    password_hash: "x",
    password_reset_at: 0,
    created_at: now,
  });
  return await new jose.SignJWT({ id, email: "admin@test.local", jti: crypto.randomUUID() })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("vaultbase")
    .setAudience("admin")
    .setIssuedAt(now)
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
}

const FIELDS = [{ name: "title", type: "text" }];

async function withHistory(name = "posts") {
  const c = await createCollection({ name, fields: JSON.stringify(FIELDS) });
  await updateCollection(c.id, { history_enabled: 1 } as Parameters<typeof updateCollection>[1]);
}

describe("GET /:collection/:id/history", () => {
  it("returns 404 when history is not enabled", async () => {
    await createCollection({ name: "posts", fields: JSON.stringify(FIELDS) });
    const r = await createRecord("posts", { title: "x" }, null);
    const app = makeRecordsPlugin(SECRET);
    const adminTok = await signAdmin();
    const res = await app.handle(new Request(`http://localhost/posts/${r.id}/history`, {
      headers: { Authorization: `Bearer ${adminTok}` },
    }));
    expect(res.status).toBe(404);
  });

  it("returns history entries for an existing record", async () => {
    await withHistory();
    const r = await createRecord("posts", { title: "v1" }, null);
    await updateRecord("posts", r.id, { title: "v2" }, null);
    const app = makeRecordsPlugin(SECRET);
    const adminTok = await signAdmin();
    const res = await app.handle(new Request(`http://localhost/posts/${r.id}/history`, {
      headers: { Authorization: `Bearer ${adminTok}` },
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { totalItems: number; data: { op: string }[] } };
    expect(body.data.totalItems).toBe(2);
    const ops = body.data.data.map((e) => e.op).sort();
    expect(ops).toEqual(["create", "update"]);
  });

  it("respects view_rule (anonymous denied when rule requires auth)", async () => {
    const c = await createCollection({
      name: "posts",
      fields: JSON.stringify(FIELDS),
      view_rule: "@request.auth.id != ''",
    });
    await updateCollection(c.id, { history_enabled: 1 } as Parameters<typeof updateCollection>[1]);
    const r = await createRecord("posts", { title: "x" }, null);
    const app = makeRecordsPlugin(SECRET);
    const res = await app.handle(new Request(`http://localhost/posts/${r.id}/history`));
    expect(res.status).toBe(403);
  });
});

describe("POST /:collection/:id/restore", () => {
  it("admin can restore an earlier snapshot of an existing record", async () => {
    await withHistory();
    const r = await createRecord("posts", { title: "v1" }, null);
    const t0 = Math.floor(Date.now() / 1000);
    await new Promise((res) => setTimeout(res, 1100));
    await updateRecord("posts", r.id, { title: "v2" }, null);
    const app = makeRecordsPlugin(SECRET);
    const adminTok = await signAdmin();

    const res = await app.handle(new Request(`http://localhost/posts/${r.id}/restore?at=${t0}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminTok}` },
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data["title"]).toBe("v1");
  });

  it("rejects non-admin", async () => {
    await withHistory();
    const r = await createRecord("posts", { title: "v1" }, null);
    const app = makeRecordsPlugin(SECRET);
    const res = await app.handle(new Request(`http://localhost/posts/${r.id}/restore?at=${Math.floor(Date.now() / 1000)}`, {
      method: "POST",
    }));
    expect(res.status).toBe(403);
  });

  it("rejects without ?at query parameter", async () => {
    await withHistory();
    const r = await createRecord("posts", { title: "v1" }, null);
    const app = makeRecordsPlugin(SECRET);
    const adminTok = await signAdmin();
    const res = await app.handle(new Request(`http://localhost/posts/${r.id}/restore`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminTok}` },
    }));
    expect(res.status).toBe(422);
  });

  it("returns 409 when the record was deleted (v1 limitation)", async () => {
    await withHistory();
    const r = await createRecord("posts", { title: "v1" }, null);
    const { deleteRecord } = await import("../core/records.ts");
    await deleteRecord("posts", r.id, null);
    const app = makeRecordsPlugin(SECRET);
    const adminTok = await signAdmin();
    const res = await app.handle(new Request(`http://localhost/posts/${r.id}/restore?at=${Math.floor(Date.now() / 1000)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminTok}` },
    }));
    expect(res.status).toBe(409);
  });
});
