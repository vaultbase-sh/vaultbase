/**
 * `POST /files/:collection/:recordId/:field` accepted a record id that
 * didn't exist, judged by create_rule: anyone the create rule admits could
 * fill storage with files attached to nothing. Uploads now need an existing
 * record and pass its update rule.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { setUploadDir, invalidateStorageCache } from "../core/storage.ts";
import { createCollection, _resetCollectionCache } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { makeFilesPlugin } from "../api/files.ts";
import { seedAuthUser, signUserJwt } from "./_helpers.ts";

const SECRET = "test-secret-upload-existing";
let tmpDir: string;
let jwt: string;
let me: string;

beforeEach(async () => {
  _resetCollectionCache();
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-upload-"));
  setLogsDir(tmpDir);
  setUploadDir(tmpDir);
  invalidateStorageCache();
  await initDb(":memory:");
  await runMigrations();
  me = await seedAuthUser({ collection: "users", email: "me@test.local" });
  jwt = await signUserJwt(me, "me@test.local", "users", SECRET);
  await createCollection({
    name: "posts",
    fields: JSON.stringify([{ name: "owner", type: "text" }, { name: "img", type: "file" }]),
    create_rule: "@request.auth.id != ''",
    update_rule: "owner = @request.auth.id",
  });
});

afterEach(async () => {
  await closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

function upload(recordId: string) {
  const fd = new FormData();
  fd.append("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "a.png", { type: "image/png" }));
  return makeFilesPlugin(tmpDir, SECRET).handle(new Request(`http://localhost/files/posts/${recordId}/img`, {
    method: "POST", headers: { authorization: `Bearer ${jwt}` }, body: fd,
  }));
}

describe("uploads", () => {
  it("are refused for a record that doesn't exist", async () => {
    expect((await upload(crypto.randomUUID())).status).toBe(404);
  });

  it("are judged by the record's update rule", async () => {
    const other = await createRecord("posts", { owner: "someone-else" }, null);
    expect((await upload(other.id)).status).toBe(403);
  });

  it("work on your own record (legitimate path)", async () => {
    const mine = await createRecord("posts", { owner: me }, null);
    expect((await upload(mine.id)).status).toBe(200);
  });
});
