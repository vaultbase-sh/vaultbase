/**
 * Orphaned-file sweep, log clipping and log file retention.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Image } from "imagescript";

import { initDb, closeDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, deleteCollection, updateCollection } from "../core/collections.ts";
import { createRecord, deleteRecord, updateRecord } from "../core/records.ts";
import { setUploadDir, invalidateStorageCache, clearThumbCache } from "../core/storage.ts";
import { setSetting } from "../api/settings.ts";
import { makeFilesPlugin } from "../api/files.ts";
import { sweepOrphanFiles, GRACE_SECONDS } from "../core/file-sweep.ts";
import { appendLogEntry, drainLogBufferSync, pruneLogFiles, setLogsDir, MAX_LOG_PATH } from "../core/file-logger.ts";
import { seedAuthUser, signUserJwt, createPublicCollection } from "./_helpers.ts";

const SECRET = "test-secret-file-sweep";
let dir: string;
let token: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "vb-sweep-"));
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

const later = () => Math.floor(Date.now() / 1000) + GRACE_SECONDS + 60;

async function setup(opts: { history?: boolean; multiple?: boolean } = {}) {
  const col = await createPublicCollection({
    name: "pics",
    fields: JSON.stringify([{ name: "img", type: "file", options: opts.multiple ? { multiple: true } : {} }, { name: "title", type: "text" }]),
  });
  if (opts.history) getRawClient().prepare(`UPDATE vaultbase_collections SET history_enabled = 1 WHERE id = ?`).run(col.id);
  const app = makeFilesPlugin(dir, SECRET);
  const upload = async (recordId: string) => {
    const form = new FormData();
    form.append("file", new File([await new Image(20, 10).fill(0xff0000ff).encode()], "a.png", { type: "image/png" }));
    const res = await app.handle(new Request(`http://localhost/files/pics/${recordId}/img`, {
      method: "POST", headers: { authorization: `Bearer ${token}` }, body: form,
    }));
    // Multi-file fields answer with an array of uploads.
    const { data } = (await res.json()) as { data: { filename: string } | Array<{ filename: string }> };
    return Array.isArray(data) ? data[0]!.filename : data.filename;
  };
  return { col, app, upload };
}

const stored = (f: string) => existsSync(join(dir, f));
const rows = () => (getRawClient().prepare(`SELECT COUNT(*) AS n FROM vaultbase_files`).get() as { n: number }).n;

describe("sweepOrphanFiles", () => {
  it("keeps referenced files and removes ones whose record is gone", async () => {
    const { upload } = await setup();
    const a = await createRecord("pics", {});
    const b = await createRecord("pics", {});
    const fa = await upload(String(a.id));
    const fb = await upload(String(b.id));
    await updateRecord("pics", String(a.id), { img: fa });
    await updateRecord("pics", String(b.id), { img: fb });
    await deleteRecord("pics", String(b.id));

    // Within the grace period nothing is touched.
    expect((await sweepOrphanFiles()).deleted).toBe(0);
    const r = await sweepOrphanFiles(later());
    expect(r.deleted).toBe(1);
    expect(stored(fa)).toBe(true);
    expect(stored(fb)).toBe(false);
    expect(rows()).toBe(1);
  });

  it("removes a replaced file and files never attached", async () => {
    const { upload } = await setup();
    const rec = await createRecord("pics", {});
    const first = await upload(String(rec.id));
    await updateRecord("pics", String(rec.id), { img: first });
    const second = await upload(String(rec.id));
    await updateRecord("pics", String(rec.id), { img: second });
    const never = await upload(String(rec.id));

    expect((await sweepOrphanFiles(later())).deleted).toBe(2);
    expect([stored(first), stored(second), stored(never)]).toEqual([false, true, false]);
  });

  it("handles multi-file fields", async () => {
    const { upload } = await setup({ multiple: true });
    const rec = await createRecord("pics", {});
    const f1 = await upload(String(rec.id));
    const f2 = await upload(String(rec.id));
    await updateRecord("pics", String(rec.id), { img: [f1] });
    expect((await sweepOrphanFiles(later())).deleted).toBe(1);
    expect([stored(f1), stored(f2)]).toEqual([true, false]);
  });

  it("removes files of a dropped field", async () => {
    const { col, upload } = await setup();
    const rec = await createRecord("pics", {});
    const f = await upload(String(rec.id));
    await updateRecord("pics", String(rec.id), { img: f });
    await updateCollection(col.id, { fields: JSON.stringify([{ name: "title", type: "text" }]) });
    expect((await sweepOrphanFiles(later())).deleted).toBe(1);
    expect(stored(f)).toBe(false);
  });

  it("removes files of a deleted collection", async () => {
    const { col, upload } = await setup();
    const rec = await createRecord("pics", {});
    const f = await upload(String(rec.id));
    await updateRecord("pics", String(rec.id), { img: f });
    await deleteCollection(col.id);
    expect((await sweepOrphanFiles(later())).deleted).toBe(1);
    expect(stored(f)).toBe(false);
  });

  it("keeps files of history-enabled collections and can be turned off", async () => {
    const { upload } = await setup({ history: true });
    const rec = await createRecord("pics", {});
    const f = await upload(String(rec.id));
    await deleteRecord("pics", String(rec.id));
    expect((await sweepOrphanFiles(later())).deleted).toBe(0);
    expect(stored(f)).toBe(true);

    getRawClient().prepare(`UPDATE vaultbase_collections SET history_enabled = 0`).run();
    setSetting("files.orphan_cleanup", "0");
    expect((await sweepOrphanFiles(later())).deleted).toBe(0);
    setSetting("files.orphan_cleanup", "1");
    expect((await sweepOrphanFiles(later())).deleted).toBe(1);
  });

  it("deletes cached thumbnails with the file", async () => {
    const { app, upload } = await setup();
    const rec = await createRecord("pics", {});
    const f = await upload(String(rec.id));
    await app.handle(new Request(`http://localhost/files/${f}?thumb=5x5`));
    expect(readdirSync(join(dir, ".thumbs")).some((n) => n.startsWith(f))).toBe(true);
    await sweepOrphanFiles(later());
    expect(readdirSync(join(dir, ".thumbs")).some((n) => n.startsWith(f))).toBe(false);
  });
});

describe("logs", () => {
  it("clips huge paths and prunes old daily files", async () => {
    const logs = join(dir, "logs");
    setLogsDir(logs);
    appendLogEntry({
      id: "1", ts: new Date().toISOString(), created_at: 0, method: "GET",
      path: "/api/v1/x?filter=" + "a".repeat(50_000), status: 200, duration_ms: 1, ip: null,
    });
    drainLogBufferSync();
    const today = readdirSync(logs).find((n) => n.endsWith(".jsonl"))!;
    const line = JSON.parse((await Bun.file(join(logs, today)).text()).trim()) as { path: string };
    expect(line.path.length).toBeLessThan(MAX_LOG_PATH + 50);

    writeFileSync(join(logs, "2020-01-01.jsonl"), "{}\n");
    writeFileSync(join(logs, "notes.txt"), "keep");
    expect(pruneLogFiles(30)).toBe(1);
    expect(readdirSync(logs).sort()).toEqual(["notes.txt", today].sort());
    expect(pruneLogFiles(0)).toBe(0);
  });
});
