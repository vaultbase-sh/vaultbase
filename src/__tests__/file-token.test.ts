import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as jose from "jose";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { setUploadDir } from "../core/storage.ts";
import { createCollection, type FieldDef } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { files } from "../db/schema.ts";
import { makeFilesPlugin } from "../api/files.ts";

const SECRET = "test-secret-file-token";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-file-token-"));
  setLogsDir(tmpDir);
  setUploadDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function signUser(id: string, email: string): Promise<string> {
  // Insert the user row so verifyAuthToken's recheckPrincipal passes.
  const { users } = await import("../db/schema.ts");
  const now = Math.floor(Date.now() / 1000);
  try {
    await getDb().insert(users).values({
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
    .setIssuer("vaultbase")
    .setAudience("user")
    .setIssuedAt(now)
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
}

async function signAdmin(id: string): Promise<string> {
  const { admin } = await import("../db/schema.ts");
  const now = Math.floor(Date.now() / 1000);
  try {
    await getDb().insert(admin).values({
      id,
      email: "admin@test.local",
      password_hash: "x",
      password_reset_at: 0,
      created_at: now,
    });
  } catch { /* already inserted */ }
  return await new jose.SignJWT({ id, email: "admin@test.local", jti: crypto.randomUUID() })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("vaultbase")
    .setAudience("admin")
    .setIssuedAt(now)
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(SECRET));
}

interface SetupOpts {
  view_rule: string | null;
  /** Owner user id stored on the record's `owner` field. */
  owner: string;
}

/**
 * Spin up a `notes` collection with a protected file field, insert a record,
 * and register a file row. Returns the IDs needed to call the token endpoint.
 */
async function setupCollectionAndFile(opts: SetupOpts) {
  const fields: FieldDef[] = [
    { name: "title", type: "text", required: false },
    { name: "owner", type: "text", required: false },
    { name: "attachment", type: "file", options: { protected: true } },
  ];
  const col = await createCollection({
    name: "notes",
    type: "base",
    fields: JSON.stringify(fields),
    view_rule: opts.view_rule,
  });
  const rec = await createRecord("notes", { title: "hi", owner: opts.owner }, null);

  const filename = `${crypto.randomUUID()}.bin`;
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(files).values({
    id: crypto.randomUUID(),
    collection_id: col.id,
    record_id: rec.id,
    field_name: "attachment",
    filename,
    original_name: "secret.bin",
    mime_type: "application/octet-stream",
    size: 8,
    created_at: now,
  });
  return { col, rec, filename };
}

function tokenReq(token: string | null, collection: string, recordId: string, field: string, filename: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request(
    `http://localhost/files/${collection}/${recordId}/${field}/${filename}/token`,
    { method: "POST", headers },
  );
}

describe("POST /api/files/:collection/:recordId/:field/:filename/token", () => {
  it("admin always gets a token (any view_rule)", async () => {
    const { rec, filename } = await setupCollectionAndFile({
      view_rule: "owner = @request.auth.id", // would deny everyone but the owner
      owner: "u-other",
    });
    const adminToken = await signAdmin("a1");
    const app = makeFilesPlugin(tmpDir, SECRET);
    const res = await app.handle(tokenReq(adminToken, "notes", rec.id, "attachment", filename));
    expect(res.status).toBe(200);
    const body = await res.json() as { data?: { token: string; expires_at: number } };
    expect(body.data?.token).toBeTruthy();
    expect(body.data?.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("user with passing rule gets a token", async () => {
    const { rec, filename } = await setupCollectionAndFile({
      view_rule: "owner = @request.auth.id",
      owner: "u1",
    });
    const userToken = await signUser("u1", "u1@test.local");
    const app = makeFilesPlugin(tmpDir, SECRET);
    const res = await app.handle(tokenReq(userToken, "notes", rec.id, "attachment", filename));
    expect(res.status).toBe(200);
    const body = await res.json() as { data?: { token: string } };
    expect(body.data?.token).toBeTruthy();
  });

  it("user with failing rule gets 403", async () => {
    const { rec, filename } = await setupCollectionAndFile({
      view_rule: "owner = @request.auth.id",
      owner: "u-other",
    });
    const userToken = await signUser("u1", "u1@test.local");
    const app = makeFilesPlugin(tmpDir, SECRET);
    const res = await app.handle(tokenReq(userToken, "notes", rec.id, "attachment", filename));
    expect(res.status).toBe(403);
  });

  it("public view_rule (null) lets unauthenticated callers mint a token", async () => {
    const { rec, filename } = await setupCollectionAndFile({
      view_rule: null,
      owner: "u1",
    });
    const app = makeFilesPlugin(tmpDir, SECRET);
    const res = await app.handle(tokenReq(null, "notes", rec.id, "attachment", filename));
    expect(res.status).toBe(200);
    const body = await res.json() as { data?: { token: string } };
    expect(body.data?.token).toBeTruthy();
  });

  it("admin-only view_rule (\"\") denies a logged-in user", async () => {
    const { rec, filename } = await setupCollectionAndFile({
      view_rule: "",
      owner: "u1",
    });
    const userToken = await signUser("u1", "u1@test.local");
    const app = makeFilesPlugin(tmpDir, SECRET);
    const res = await app.handle(tokenReq(userToken, "notes", rec.id, "attachment", filename));
    expect(res.status).toBe(403);
  });

  it("404 when the collection does not exist", async () => {
    const adminToken = await signAdmin("a1");
    const app = makeFilesPlugin(tmpDir, SECRET);
    const res = await app.handle(tokenReq(adminToken, "missing", "rec1", "attachment", "x.bin"));
    expect(res.status).toBe(404);
  });

  it("404 when the record does not exist", async () => {
    await setupCollectionAndFile({ view_rule: null, owner: "u1" });
    const adminToken = await signAdmin("a1");
    const app = makeFilesPlugin(tmpDir, SECRET);
    const res = await app.handle(tokenReq(adminToken, "notes", "no-such-record", "attachment", "x.bin"));
    expect(res.status).toBe(404);
  });

  it("404 when the file row is not attached to (collection, record, field)", async () => {
    const { rec } = await setupCollectionAndFile({ view_rule: null, owner: "u1" });
    const adminToken = await signAdmin("a1");
    const app = makeFilesPlugin(tmpDir, SECRET);
    const res = await app.handle(tokenReq(adminToken, "notes", rec.id, "attachment", "ghost-filename.bin"));
    expect(res.status).toBe(404);
  });

  it("issued token has the correct audience and filename claim", async () => {
    const { rec, filename } = await setupCollectionAndFile({ view_rule: null, owner: "u1" });
    const adminToken = await signAdmin("a1");
    const app = makeFilesPlugin(tmpDir, SECRET);
    const res = await app.handle(tokenReq(adminToken, "notes", rec.id, "attachment", filename));
    const body = await res.json() as { data: { token: string; expires_at: number } };
    const verified = await jose.jwtVerify(
      body.data.token,
      new TextEncoder().encode(SECRET),
      { audience: "file" },
    );
    expect(verified.payload["filename"]).toBe(filename);
  });
});
