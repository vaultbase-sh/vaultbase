import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { createRecord, getRecord, updateRecord } from "../core/records.ts";
import { setUploadDir, invalidateStorageCache, fileExists } from "../core/storage.ts";
import { makeFilesPlugin } from "../api/files.ts";
import { seedAuthUser, signUserJwt, createPublicCollection } from "./_helpers.ts";

// Deleting a file removed the stored file but left the record's field naming
// it, so the record pointed at a file that answered 404. A delete now takes
// the name out of the field too, through the normal update path.

const SECRET = "test-secret-file-delete";
let dir: string;
let token: string;
let id: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "vb-file-delete-"));
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
      { name: "badge", type: "file", required: true },
    ]),
  });
  id = (await createRecord("posts", { title: "t", badge: "placeholder.png" })).id;
  const uid = await seedAuthUser({ collection: "users", email: "u@test.local" });
  token = await signUserJwt(uid, "u@test.local", "users", SECRET);
});

afterEach(async () => {
  _resetCollectionCache();
  await closeDb();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
});

const files = () => makeFilesPlugin(dir, SECRET);

async function upload(field: string): Promise<string> {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(64).fill(7)], "a.png", { type: "image/png" }));
  const res = await files().handle(new Request(`http://localhost/files/posts/${id}/${field}`, {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: form,
  }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { filename: string } | Array<{ filename: string }> };
  return Array.isArray(body.data) ? body.data[0]!.filename : body.data.filename;
}

async function del(path: string) {
  const res = await files().handle(new Request(`http://localhost/files/posts/${id}/${path}`, {
    method: "DELETE", headers: { authorization: `Bearer ${token}` },
  }));
  return { status: res.status, json: (await res.json()) as { error?: string; details?: Record<string, string> } };
}

const field = async (name: string) => (await getRecord("posts", id))?.[name];

describe("deleting a file takes it out of the record", () => {
  it("a single file field is cleared", async () => {
    const f = await upload("cover");
    await updateRecord("posts", id, { cover: f });
    expect((await del(`cover/${f}`)).status).toBe(200);
    expect(await field("cover")).toBeNull();
    expect(await fileExists(f)).toBe(false);
  });

  it("one file of a multiple field goes; the others stay", async () => {
    const a = await upload("gallery");
    const b = await upload("gallery");
    await updateRecord("posts", id, { gallery: [a, b] });
    expect((await del(`gallery/${b}`)).status).toBe(200);
    expect(await field("gallery")).toEqual([a]);
    expect(await fileExists(a)).toBe(true);
  });

  it("deleting a whole field empties it", async () => {
    const a = await upload("gallery");
    const b = await upload("gallery");
    await updateRecord("posts", id, { gallery: [a, b] });
    const res = await del("gallery");
    expect(res.status).toBe(200);
    const after = await field("gallery");
    expect(after === null || (Array.isArray(after) && after.length === 0)).toBe(true);
  });

  it("the last file of a required field can't be deleted", async () => {
    const f = await upload("badge");
    await updateRecord("posts", id, { badge: f });
    const res = await del(`badge/${f}`);
    expect(res.status).toBe(422);
    expect(await field("badge")).toBe(f);
    expect(await fileExists(f)).toBe(true);
  });

  it("a file the record doesn't name is deleted without touching it", async () => {
    const attached = await upload("cover");
    await updateRecord("posts", id, { cover: attached });
    const stray = await upload("cover");
    const before = (await getRecord("posts", id))?.["updated"];
    expect((await del(`cover/${stray}`)).status).toBe(200);
    expect(await field("cover")).toBe(attached);
    expect((await getRecord("posts", id))?.["updated"]).toBe(before);
    expect(await fileExists(stray)).toBe(false);
  });
});
