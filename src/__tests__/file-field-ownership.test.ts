import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { admin } from "../db/schema.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { createRecord, getRecord } from "../core/records.ts";
import { signAuthToken } from "../core/sec.ts";
import { setUploadDir, invalidateStorageCache } from "../core/storage.ts";
import { makeFilesPlugin } from "../api/files.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { makeBatchPlugin } from "../api/batch.ts";
import { seedAuthUser, signUserJwt, createPublicCollection } from "./_helpers.ts";

// A file field holds stored file names. A non-admin could set it to any name,
// including one uploaded to someone else's record: the file then showed on
// their record too, and broke there when its owner replaced it (the hourly
// sweep deletes a file its own record no longer names). Non-admins may now
// only add files uploaded to the same record and field.

const SECRET = "test-secret-file-ownership";
let dir: string;
let token: string;
let mine: string;
let theirs: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "vb-file-owner-"));
  await initDb(":memory:");
  await runMigrations();
  setUploadDir(dir);
  invalidateStorageCache();
  await createPublicCollection({
    name: "posts",
    fields: JSON.stringify([
      { name: "title", type: "text" },
      { name: "cover", type: "file" },
      { name: "gallery", type: "file", options: { multiple: true } },
    ]),
  });
  mine = (await createRecord("posts", { title: "mine" })).id;
  theirs = (await createRecord("posts", { title: "theirs" })).id;
  const uid = await seedAuthUser({ collection: "users", email: "u@test.local" });
  token = await signUserJwt(uid, "u@test.local", "users", SECRET);
});

afterEach(async () => {
  _resetCollectionCache();
  await closeDb();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
});

async function upload(recordId: string, field: string): Promise<string> {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(64).fill(7)], "a.png", { type: "image/png" }));
  const res = await makeFilesPlugin(dir, SECRET).handle(new Request(`http://localhost/files/posts/${recordId}/${field}`, {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: form,
  }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { filename: string } | Array<{ filename: string }> };
  return Array.isArray(body.data) ? body.data[0]!.filename : body.data.filename;
}

async function call(method: string, path: string, body: unknown, bearer = token) {
  const res = await makeRecordsPlugin(SECRET).handle(new Request(`http://localhost${path}`, {
    method, headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  return { status: res.status, json: (await res.json()) as { error?: string; details?: Record<string, string> } };
}

const patch = (id: string, body: unknown, bearer?: string) => call("PATCH", `/posts/${id}`, body, bearer);

describe("file fields take only the record's own uploads", () => {
  it("a file uploaded to the record's field can be attached (legitimate path)", async () => {
    const f = await upload(mine, "cover");
    expect((await patch(mine, { cover: f })).status).toBe(200);
    expect((await getRecord("posts", mine))?.["cover"]).toBe(f);
  });

  it("another record's file is refused", async () => {
    const f = await upload(theirs, "cover");
    const r = await patch(mine, { cover: f });
    expect(r.status).toBe(422);
    expect(r.json.details?.["cover"]).toContain("uploaded to this record");
    expect((await getRecord("posts", mine))?.["cover"] ?? null).toBeNull();
  });

  it("a file uploaded to another field of the same record is refused", async () => {
    const f = await upload(mine, "gallery");
    expect((await patch(mine, { cover: f })).status).toBe(422);
  });

  it("sending the stored value back unchanged still works", async () => {
    const f = await upload(mine, "cover");
    await patch(mine, { cover: f });
    expect((await patch(mine, { title: "renamed", cover: f })).status).toBe(200);
  });

  it("a multi-file field can add its own uploads but not someone else's", async () => {
    const a = await upload(mine, "gallery");
    const b = await upload(mine, "gallery");
    const foreign = await upload(theirs, "gallery");
    expect((await patch(mine, { gallery: [a] })).status).toBe(200);
    expect((await patch(mine, { gallery: [a, b] })).status).toBe(200);
    expect((await patch(mine, { gallery: [a, b, foreign] })).status).toBe(422);
    expect((await getRecord("posts", mine))?.["gallery"]).toEqual([a, b]);
  });

  it("clearing a file field is always allowed", async () => {
    const f = await upload(mine, "cover");
    await patch(mine, { cover: f });
    expect((await patch(mine, { cover: null })).status).toBe(200);
  });

  it("a file name on create is refused: upload to the record once it exists", async () => {
    const f = await upload(theirs, "cover");
    const r = await call("POST", "/posts", { title: "new", cover: f });
    expect(r.status).toBe(422);
    expect(r.json.details?.["cover"]).toContain("after creating it");
  });

  it("the batch endpoint applies the same check", async () => {
    const f = await upload(theirs, "cover");
    const res = await makeBatchPlugin(SECRET).handle(new Request("http://localhost/batch", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ requests: [{ method: "PATCH", url: `/api/v1/posts/${mine}`, body: { cover: f } }] }),
    }));
    expect(res.status).toBe(422);
    expect((await getRecord("posts", mine))?.["cover"] ?? null).toBeNull();
  });

  it("admins can still point a record at any stored file", async () => {
    await getDb().insert(admin).values({ id: "a1", email: "a@x", password_hash: "x", password_reset_at: 0, created_at: 0 }).onConflictDoNothing();
    const adminToken = (await signAuthToken({ payload: { id: "a1", email: "a@x" }, audience: "admin", expiresInSeconds: 600, jwtSecret: SECRET })).token;
    const f = await upload(theirs, "cover");
    expect((await patch(mine, { cover: f }, adminToken)).status).toBe(200);
  });
});
