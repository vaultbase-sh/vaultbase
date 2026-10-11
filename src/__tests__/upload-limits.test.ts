import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { setSetting, validateMaxUploadSize } from "../api/settings.ts";
import { setUploadDir, invalidateStorageCache } from "../core/storage.ts";
import { makeFilesPlugin, maxUploadBytes, DEFAULT_MAX_UPLOAD_BYTES } from "../api/files.ts";
import { seedAuthUser, signUserJwt, createPublicCollection } from "./_helpers.ts";

// Uploads are buffered in memory while the multipart body is parsed, so an
// unbounded file field let any user with create/update rights exhaust RAM.
// There is now a global cap (setting files.max_upload_size, default 50 MB),
// enforced from Content-Length before parsing and per file afterwards.

const SECRET = "test-secret-upload-limits";
let dir: string;
let token: string;
let recordId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "vb-upload-"));
  initDb(":memory:");
  await runMigrations();
  setUploadDir(dir);
  invalidateStorageCache();
  await createPublicCollection({
    name: "posts",
    fields: JSON.stringify([
      { name: "title", type: "text" },
      { name: "cover", type: "file" },
      { name: "thumb", type: "file", options: { maxSize: 100 } },
    ]),
  });
  recordId = (await createRecord("posts", { title: "p" })).id;
  const uid = await seedAuthUser({ collection: "users", email: "u@test.local" });
  token = await signUserJwt(uid, "u@test.local", "users", SECRET);
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

async function upload(field: string, bytes: number) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes).fill(7)], "a.png", { type: "image/png" }));
  const res = await makeFilesPlugin(dir, SECRET).handle(
    new Request(`http://localhost/files/posts/${recordId}/${field}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    }),
  );
  return { status: res.status, body: (await res.json()) as { data?: { filename: string } } };
}

describe("upload size limits", () => {
  it("defaults to 50 MB when the setting is absent", () => {
    expect(DEFAULT_MAX_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
    expect(maxUploadBytes()).toBe(DEFAULT_MAX_UPLOAD_BYTES);
  });

  it("rejects a file over the global cap with 413", async () => {
    setSetting("files.max_upload_size", "1024");
    const r = await upload("cover", 4096);
    expect(r.status).toBe(413);
  });

  it("accepts a file under the global cap and stores it intact", async () => {
    setSetting("files.max_upload_size", "1024");
    const r = await upload("cover", 512);
    expect(r.status).toBe(200);
    const stored = readFileSync(join(dir, r.body.data!.filename));
    expect(stored.length).toBe(512);
    expect(stored.every((b) => b === 7)).toBe(true);
  });

  it("settings validator accepts 1 KB–128 MB whole bytes only", () => {
    expect(validateMaxUploadSize(String(10 * 1024 * 1024))).toBeNull();
    expect(validateMaxUploadSize("1024")).toBeNull();
    expect(validateMaxUploadSize(String(128 * 1024 * 1024))).toBeNull();
    expect(validateMaxUploadSize("1023")).not.toBeNull();
    expect(validateMaxUploadSize(String(128 * 1024 * 1024 + 1))).not.toBeNull();
    expect(validateMaxUploadSize("abc")).not.toBeNull();
    expect(validateMaxUploadSize("1.5")).not.toBeNull();
  });

  it("an out-of-range stored value is clamped", () => {
    setSetting("files.max_upload_size", String(10 * 1024 * 1024 * 1024));
    expect(maxUploadBytes()).toBe(128 * 1024 * 1024);
  });

  it("a smaller per-field maxSize still applies (422)", async () => {
    const r = await upload("thumb", 500);
    expect(r.status).toBe(422);
  });
});
