import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Image } from "imagescript";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { setUploadDir, invalidateStorageCache, clearThumbCache } from "../core/storage.ts";
import { makeFilesPlugin, _thumbStats } from "../api/files.ts";
import { seedAuthUser, signUserJwt, createPublicCollection } from "./_helpers.ts";

// Concurrent requests for the same uncached thumbnail each decoded and
// resized the image and overwrote the cache file.

const SECRET = "test-secret-thumb-dedupe";
let dir: string;
let token: string;
let recordId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "vb-thumb-"));
  initDb(":memory:");
  await runMigrations();
  setUploadDir(dir);
  invalidateStorageCache();
  clearThumbCache();
  await createPublicCollection({
    name: "pics",
    fields: JSON.stringify([{ name: "img", type: "file" }]),
  });
  recordId = (await createRecord("pics", {})).id;
  const uid = await seedAuthUser({ collection: "users", email: "t@test.local" });
  token = await signUserJwt(uid, "t@test.local", "users", SECRET);
});

afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("thumbnail generation", () => {
  it("concurrent requests for one uncached thumb generate it once", async () => {
    const app = makeFilesPlugin(dir, SECRET);
    const png = await new Image(400, 300).fill(0xff0000ff).encode();
    const form = new FormData();
    form.append("file", new File([png], "a.png", { type: "image/png" }));
    const up = await app.handle(new Request(`http://localhost/files/pics/${recordId}/img`, {
      method: "POST", headers: { authorization: `Bearer ${token}` }, body: form,
    }));
    const { data } = (await up.json()) as { data: { filename: string } };

    const before = _thumbStats().generated;
    const get = () => app.handle(new Request(`http://localhost/files/${data.filename}?thumb=100x100`));
    const responses = await Promise.all(Array.from({ length: 8 }, get));
    expect(responses.every((r) => r.status === 200)).toBe(true);
    const bodies = await Promise.all(responses.map((r) => r.arrayBuffer()));
    expect(new Set(bodies.map((b) => b.byteLength)).size).toBe(1);
    expect(_thumbStats().generated - before).toBe(1);
  });
});
