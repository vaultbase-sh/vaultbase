import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as jose from "jose";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, type FieldDef } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { makeBatchPlugin } from "../api/batch.ts";
import { admin as adminTable, users as usersTable } from "../db/schema.ts";

const SECRET = "test-secret-batch-rules";
// verifyAuthToken now requires `iss = "vaultbase"` and a matching DB
// row for the principal. Test fixtures must seed both.
const ISSUER = "vaultbase";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-batch-rules-"));
  setLogsDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function signUser(id: string, email: string): Promise<string> {
  // Seed the principal so verifyAuthToken's recheckPrincipal pass succeeds.
  const now = Math.floor(Date.now() / 1000);
  try {
    await getDb().insert(usersTable).values({
      id,
      collection_id: "test",
      email,
      password_hash: "x",
      data: "{}",
      created_at: now,
      updated_at: now,
    });
  } catch { /* already inserted */ }
  return await new jose.SignJWT({ id, email, jti: crypto.randomUUID() })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience("user")
    .setIssuedAt(now)
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
}

async function signAdmin(id: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  try {
    await getDb().insert(adminTable).values({
      id,
      email: "admin@test.local",
      password_hash: "x",
      password_reset_at: 0,
      created_at: now,
    });
  } catch { /* already inserted */ }
  return await new jose.SignJWT({ id, email: "admin@test.local", jti: crypto.randomUUID() })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience("admin")
    .setIssuedAt(now)
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
}

async function makeFields(extra: FieldDef[] = []): Promise<string> {
  const fields: FieldDef[] = [
    { name: "title", type: "text", required: false },
    { name: "owner", type: "text", required: false },
    ...extra,
  ];
  return JSON.stringify(fields);
}

function batchReq(token: string | null, requests: Array<{ method: string; url: string; body?: unknown }>): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request("http://localhost/batch", {
    method: "POST",
    headers,
    body: JSON.stringify({ requests }),
  });
}

describe("batch endpoint enforces collection rules", () => {
  it("denies create when create_rule = '' and caller is non-admin", async () => {
    await createCollection({
      name: "notes",
      type: "base",
      fields: await makeFields(),
      create_rule: "", // admin only
    });
    const token = await signUser("u1", "user@test.local");
    const app = makeBatchPlugin(SECRET);
    const res = await app.handle(batchReq(token, [
      { method: "POST", url: "/api/v1/notes", body: { title: "hi", owner: "u1" } },
    ]));
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string; code: number };
    expect(body.code).toBe(403);
    expect(body.error).toContain("create_rule");
  });

  it("admin bypasses rules in batch", async () => {
    await createCollection({
      name: "notes",
      type: "base",
      fields: await makeFields(),
      create_rule: "", // admin only
    });
    const token = await signAdmin("a1");
    const app = makeBatchPlugin(SECRET);
    const res = await app.handle(batchReq(token, [
      { method: "POST", url: "/api/v1/notes", body: { title: "hi", owner: "a1" } },
    ]));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ status: number }> };
    expect(body.data[0]!.status).toBe(201);
  });

  it("rolls back ALL ops when any single op is denied", async () => {
    // Free creates allowed, but updates restricted to record owner
    await createCollection({
      name: "notes",
      type: "base",
      fields: await makeFields(),
      create_rule: null,                          // public
      update_rule: "owner = @request.auth.id",   // owner-only
    });
    // Pre-seed a record owned by u2 — u1 must not be able to update it
    const r = await createRecord("notes", { title: "old", owner: "u2" }, null);

    const token = await signUser("u1", "u1@test.local");
    const app = makeBatchPlugin(SECRET);
    const res = await app.handle(batchReq(token, [
      { method: "POST", url: "/api/v1/notes", body: { title: "fresh", owner: "u1" } },
      { method: "PATCH", url: `/api/notes/${r.id}`, body: { title: "hijacked" } },
    ]));
    expect(res.status).toBe(403);
    // Verify rollback: only the original record exists; "fresh" was rolled back
    const list = await (await import("../core/records.ts")).listRecords("notes", {});
    expect(list.totalItems).toBe(1);
    expect(list.data[0]!["title"]).toBe("old");
  });

  it("applies list_rule as filter so users only see allowed records", async () => {
    await createCollection({
      name: "notes",
      type: "base",
      fields: await makeFields(),
      list_rule: "owner = @request.auth.id",
    });
    await createRecord("notes", { title: "mine",   owner: "u1" }, null);
    await createRecord("notes", { title: "theirs", owner: "u2" }, null);

    const token = await signUser("u1", "u1@test.local");
    const app = makeBatchPlugin(SECRET);
    const res = await app.handle(batchReq(token, [
      { method: "GET", url: "/api/v1/notes" },
    ]));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ status: number; body: { data: Array<{ title: string }> } }> };
    const records = body.data[0]!.body.data;
    expect(records).toHaveLength(1);
    expect(records[0]!.title).toBe("mine");
  });

  it("denies view when view_rule fails for a specific record", async () => {
    await createCollection({
      name: "notes",
      type: "base",
      fields: await makeFields(),
      view_rule: "owner = @request.auth.id",
    });
    const r = await createRecord("notes", { title: "secret", owner: "u2" }, null);

    const token = await signUser("u1", "u1@test.local");
    const app = makeBatchPlugin(SECRET);
    const res = await app.handle(batchReq(token, [
      { method: "GET", url: `/api/notes/${r.id}` },
    ]));
    expect(res.status).toBe(403);
  });

  it("denies list with list_rule = '' for non-admin", async () => {
    await createCollection({
      name: "notes",
      type: "base",
      fields: await makeFields(),
      list_rule: "", // admin only
    });
    const token = await signUser("u1", "u1@test.local");
    const app = makeBatchPlugin(SECRET);
    const res = await app.handle(batchReq(token, [
      { method: "GET", url: "/api/v1/notes" },
    ]));
    expect(res.status).toBe(403);
  });
});
