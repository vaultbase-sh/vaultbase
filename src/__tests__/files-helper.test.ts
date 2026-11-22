/**
 * helpers.files.save: a worker or hook stores a file on a record without the
 * multipart upload route. It checks what an upload checks, writes the
 * storage object and its vaultbase_files row, and sets the field through the
 * records path (record history included).
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { createCollection, updateCollection } from "../core/collections.ts";
import { createRecord, getRecord } from "../core/records.ts";
import { listRecordHistory } from "../core/record-history.ts";
import { files } from "../db/schema.ts";
import { setSetting } from "../api/settings.ts";
import { invalidateStorageCache, setUploadDir } from "../core/storage.ts";
import { makeHookHelpers } from "../core/hooks.ts";
import { ValidationError } from "../core/validate.ts";

let dir: string;
let postId: string;
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "vb-files-helper-"));
  setLogsDir(dir);
  await initDb(":memory:");
  await runMigrations();
  setUploadDir(dir);
  invalidateStorageCache();
  const posts = await createCollection({
    name: "posts",
    fields: JSON.stringify([
      { name: "title", type: "text" },
      { name: "cover", type: "file" },
      { name: "gallery", type: "file", options: { multiple: true } },
      { name: "small", type: "file", options: { maxSize: 4 } },
      { name: "images", type: "file", options: { mimeTypes: ["image/*"] } },
    ]),
  });
  await updateCollection(posts.id, { history_enabled: 1 } as Parameters<typeof updateCollection>[1]);
  postId = (await createRecord("posts", { title: "p" })).id;
});

afterEach(async () => {
  await closeDb();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
});

const save = (...args: Parameters<ReturnType<typeof makeHookHelpers>["files"]["save"]>) => makeHookHelpers().files.save(...args);

async function rows() {
  return getDb().select().from(files).where(eq(files.record_id, postId));
}

describe("helpers.files.save", () => {
  it("stores the bytes, adds the files row and sets a single-file field", async () => {
    const { file, record } = await save("posts", postId, "cover", png, { name: "out.png" });
    expect(file.mimeType).toBe("image/png");
    expect(file.filename).toMatch(/^[0-9a-f-]{36}\.png$/);
    expect(file.originalName).toBe("out.png");
    expect(file.size).toBe(png.byteLength);
    expect(Array.from(readFileSync(join(dir, file.filename)))).toEqual(Array.from(png));
    expect(record["cover"]).toBe(file.filename);
    expect((await getRecord("posts", postId))!["cover" as never]).toBe(file.filename);
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]!.field_name).toBe("cover");
    expect(r[0]!.original_name).toBe("out.png");
    // Through the records path: the change is in record history.
    const history = await listRecordHistory("posts", postId);
    expect(history.data.map((h) => h.op)).toContain("update");
  });

  it("replaces the value of a single-file field", async () => {
    await save("posts", postId, "cover", png, { name: "a.png" });
    const second = await save("posts", postId, "cover", png, { name: "b.png" });
    expect((await getRecord("posts", postId))!["cover" as never]).toBe(second.file.filename);
  });

  it("appends to a multi-file field, also when saves run at the same time", async () => {
    const saved = await Promise.all([1, 2, 3, 4, 5].map((i) => save("posts", postId, "gallery", png, { name: `${i}.png` })));
    const value = (await getRecord("posts", postId))!["gallery" as never] as string[];
    expect([...value].sort()).toEqual(saved.map((s) => s.file.filename).sort());
  });

  it("works out the type from the Blob, then from the name, then octet-stream", async () => {
    expect((await save("posts", postId, "cover", new Blob(["a,b\n"], { type: "text/csv" }))).file.mimeType).toBe("text/csv");
    expect((await save("posts", postId, "cover", "# hi", { name: "notes.md" })).file.mimeType).toBe("text/markdown");
    const zip = await save("posts", postId, "cover", new Uint8Array([0x50, 0x4b, 3, 4]), { name: "x.zip", type: "application/x-zip-compressed" });
    expect(zip.file.mimeType).toBe("application/x-zip-compressed");
    expect(zip.file.filename.endsWith(".zip")).toBe(true);
    const raw = await save("posts", postId, "cover", new Uint8Array([1, 2, 3]));
    expect(raw.file.mimeType).toBe("application/octet-stream");
    expect(raw.file.originalName).toBe("file");
    expect(raw.file.filename.endsWith(".bin")).toBe(true);
  });

  it("refuses what an upload refuses, leaving nothing behind", async () => {
    const refused = async (p: Promise<unknown>) => {
      const e = await p.then(() => null, (err) => err);
      expect(e).toBeInstanceOf(ValidationError);
    };
    await refused(save("posts", postId, "cover", "<script>", { name: "x.html" }));
    await refused(save("posts", postId, "small", png, { name: "a.png" }));
    await refused(save("posts", postId, "images", "a,b", { name: "a.csv" }));
    setSetting("files.max_upload_size", "1024");
    await refused(save("posts", postId, "cover", new Uint8Array(2048), { name: "a.png" }));
    expect(await rows()).toHaveLength(0);
    expect((await getRecord("posts", postId))!["cover" as never] ?? null).toBeNull();
  });

  it("throws for a missing collection, record or field, or a field that isn't a file field", async () => {
    await expect(save("nope", postId, "cover", png)).rejects.toThrow("collection 'nope' not found");
    await expect(save("posts", crypto.randomUUID(), "cover", png)).rejects.toThrow("not found");
    await expect(save("posts", postId, "nope", png)).rejects.toThrow("field 'nope' not found");
    await expect(save("posts", postId, "title", png)).rejects.toThrow("is not a file field");
  });

  it("removes the stored file and its row when the record update fails", async () => {
    const helpers = makeHookHelpers();
    // A beforeUpdate refusal, as a hook would abort.
    const { hooks: hooksTable } = await import("../db/schema.ts");
    const { invalidateHookCache } = await import("../core/hooks.ts");
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(hooksTable).values({ id: crypto.randomUUID(), name: "no", collection_name: "posts", event: "beforeUpdate", code: `helpers.abort("no updates");`, enabled: 1, created_at: now, updated_at: now });
    invalidateHookCache();
    await expect(helpers.files.save("posts", postId, "cover", png, { name: "a.png" })).rejects.toThrow();
    expect(await rows()).toHaveLength(0);
    const leftovers = readdirSync(dir).filter((n) => n.endsWith(".png"));
    expect(leftovers).toEqual([]);
  });
});
