/**
 * Image transforms on file downloads: output format / quality, one-side
 * resize, per-field size allow-list and the per-file variant cap.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Image } from "imagescript";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, type FieldDef } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { setUploadDir, invalidateStorageCache, clearThumbCache } from "../core/storage.ts";
import { makeFilesPlugin } from "../api/files.ts";
import { MAX_THUMB_VARIANTS, detectFormat, parseOutputOptions, parseThumbSpec } from "../core/image.ts";
import { signAuthToken } from "../core/sec.ts";
import { getDb } from "../db/client.ts";
import { admin } from "../db/schema.ts";
import { seedAuthUser, signUserJwt, createPublicCollection } from "./_helpers.ts";

const SECRET = "test-secret-image-transforms";
let dir: string;
let token: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "vb-imgx-"));
  initDb(":memory:");
  await runMigrations();
  setUploadDir(dir);
  invalidateStorageCache();
  clearThumbCache();
  const uid = await seedAuthUser({ collection: "users", email: "t@test.local" });
  token = await signUserJwt(uid, "t@test.local", "users", SECRET);
});

afterEach(() => {
  closeDb();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
});

async function upload(field: FieldDef = { name: "img", type: "file" }): Promise<{ app: ReturnType<typeof makeFilesPlugin>; filename: string }> {
  await createPublicCollection({ name: "pics", fields: JSON.stringify([field]) });
  const recordId = (await createRecord("pics", {})).id;
  const app = makeFilesPlugin(dir, SECRET);
  const png = await new Image(400, 200).fill(0x3366ccff).encode();
  const form = new FormData();
  form.append("file", new File([png], "a.png", { type: "image/png" }));
  const up = await app.handle(new Request(`http://localhost/files/pics/${recordId}/img`, {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: form,
  }));
  const { data } = (await up.json()) as { data: { filename: string } };
  return { app, filename: data.filename };
}

async function get(app: ReturnType<typeof makeFilesPlugin>, path: string, headers: Record<string, string> = {}) {
  const res = await app.handle(new Request(`http://localhost${path}`, { headers }));
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { res, bytes, format: detectFormat(bytes) };
}

async function dims(bytes: Uint8Array) {
  return new Bun.Image(bytes).metadata();
}

describe("parsing", () => {
  it("accepts one-side sizes and rejects 0x0", () => {
    expect(parseThumbSpec("400x0")).toEqual({ width: 400, height: 0, fit: "contain" });
    expect(parseThumbSpec("0x300_cover")).toEqual({ width: 0, height: 300, fit: "contain" });
    expect(parseThumbSpec("0x0")).toBeNull();
  });

  it("validates format and quality", () => {
    expect(parseOutputOptions("webp", "70", null)).toEqual({ format: "webp", quality: 70, auto: false });
    expect(parseOutputOptions("auto", undefined, "image/avif,image/webp,*/*")).toEqual({ format: "webp", auto: true });
    expect(parseOutputOptions("auto", undefined, "image/png")).toEqual({ auto: true });
    expect(typeof parseOutputOptions("avif", undefined, null)).toBe("string");
    expect(typeof parseOutputOptions(undefined, "0", null)).toBe("string");
  });
});

describe("transforms", () => {
  it("converts format, with or without resizing", async () => {
    const { app, filename } = await upload();
    const a = await get(app, `/files/${filename}?thumb=100x100&format=webp`);
    expect(a.res.headers.get("content-type")).toBe("image/webp");
    expect(a.format).toBe("webp");
    const b = await get(app, `/files/${filename}?format=jpeg&quality=60`);
    expect(b.format).toBe("jpeg");
    expect(await dims(b.bytes)).toMatchObject({ width: 400, height: 200 });
  });

  it("quality changes the output", async () => {
    const { app, filename } = await upload();
    const lo = await get(app, `/files/${filename}?format=webp&quality=5`);
    const hi = await get(app, `/files/${filename}?format=webp&quality=100`);
    expect(lo.bytes.length).not.toBe(hi.bytes.length);
  });

  it("keeps the aspect ratio when one side is 0", async () => {
    const { app, filename } = await upload();
    expect(await dims((await get(app, `/files/${filename}?thumb=100x0`)).bytes)).toMatchObject({ width: 100, height: 50 });
    expect(await dims((await get(app, `/files/${filename}?thumb=0x100`)).bytes)).toMatchObject({ width: 200, height: 100 });
  });

  it("format=auto follows Accept and sets Vary", async () => {
    const { app, filename } = await upload();
    const w = await get(app, `/files/${filename}?thumb=50x50&format=auto`, { accept: "image/webp,*/*" });
    expect(w.format).toBe("webp");
    expect(w.res.headers.get("vary")).toBe("Accept");
    const p = await get(app, `/files/${filename}?thumb=50x50&format=auto`, { accept: "image/png" });
    expect(p.format).toBe("png");
  });

  it("reads fit from its own query param", async () => {
    const { app, filename } = await upload();
    expect(await dims((await get(app, `/files/${filename}?thumb=50x50&fit=cover`)).bytes)).toMatchObject({ width: 50, height: 50 });
    expect(await dims((await get(app, `/files/${filename}?thumb=50x50`)).bytes)).toMatchObject({ width: 50, height: 25 });
  });

  it("rejects a bad format with 400", async () => {
    const { app, filename } = await upload();
    expect((await get(app, `/files/${filename}?format=gifv`)).res.status).toBe(400);
  });
});

describe("limits", () => {
  it("only allows listed sizes for non-admins", async () => {
    const { app, filename } = await upload({ name: "img", type: "file", options: { thumbs: ["100x100", "200x0"] } });
    const ok = await get(app, `/files/${filename}?thumb=100x100&format=webp`);
    expect(ok.format).toBe("webp");
    expect(await dims((await get(app, `/files/${filename}?thumb=200x0`)).bytes)).toMatchObject({ width: 200 });
    const no = await get(app, `/files/${filename}?thumb=123x45`);
    expect(no.res.headers.get("x-vaultbase-thumb")).toBe("not-allowed");
    expect(await dims(no.bytes)).toMatchObject({ width: 400, height: 200 });

    // Admins may request any size.
    await getDb().insert(admin).values({ id: "a1", email: "a@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
    const { token: adminTok } = await signAuthToken({ payload: { id: "a1" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET });
    const adm = await get(app, `/files/${filename}?thumb=123x45`, { authorization: `Bearer ${adminTok}` });
    expect(adm.res.headers.get("x-vaultbase-thumb")).toBeNull();
    expect(await dims(adm.bytes)).toMatchObject({ width: 90, height: 45 }); // contain in 123x45
  });

  it("rejects invalid sizes in the field's thumbs list", async () => {
    await expect(createPublicCollection({ name: "bad", fields: JSON.stringify([{ name: "img", type: "file", options: { thumbs: ["big"] } }]) })).rejects.toThrow();
  });

  it("caps generated variants per file", async () => {
    const { app, filename } = await upload();
    for (let i = 1; i <= MAX_THUMB_VARIANTS; i++) {
      const r = await get(app, `/files/${filename}?thumb=${i}x${i}`);
      expect(r.res.headers.get("x-vaultbase-thumb")).toBeNull();
    }
    const over = await get(app, `/files/${filename}?thumb=999x999`);
    expect(over.res.headers.get("x-vaultbase-thumb")).toBe("limit");
    // Cached variants keep working.
    const again = await get(app, `/files/${filename}?thumb=5x5`);
    expect(again.res.headers.get("x-vaultbase-thumb")).toBeNull();
    expect(await dims(again.bytes)).toMatchObject({ width: 5 });
  });
});
