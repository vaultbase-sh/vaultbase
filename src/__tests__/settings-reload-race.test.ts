/**
 * The background reload read the whole table and swapped it in. A setting
 * written while that read was in flight got its old value back for up to
 * the next reload, and the caches rebuilt from it kept the old one longer.
 */
import { afterEach, beforeEach, expect, it } from "bun:test";
import { closeDb, initDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { _reloadSettings, getSetting, invalidateSetting, loadSettings, setSetting } from "../api/settings.ts";
import { db } from "../db/index.ts";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  await loadSettings();
});
afterEach(async () => { await closeDb(); });

it("keeps a value written while a reload was reading", async () => {
  await setSetting("app.name", "old");
  const reload = _reloadSettings();
  const write = setSetting("app.name", "new");
  await reload;
  await write;
  expect(getSetting("app.name", "")).toBe("new");
  await _reloadSettings();
  expect(getSetting("app.name", "")).toBe("new");
});

it("keeps a value whose write was still in flight when a reload started", async () => {
  // The other order: on Postgres the reload's read runs on another
  // connection and missed a setting being written for the first time.
  for (let i = 0; i < 20; i++) {
    const write = setSetting(`app.fresh_${i}`, "new");
    await _reloadSettings();
    expect(getSetting(`app.fresh_${i}`, "")).toBe("new");
    await write;
  }
  await _reloadSettings();
  expect(getSetting("app.fresh_19", "")).toBe("new");
});

it("keeps a value re-read by invalidateSetting while a reload was reading", async () => {
  // Code that writes the table itself (the backup scheduler's claim) then
  // calls invalidateSetting; a reload that read before the write put the
  // old value back.
  await setSetting("app.direct", "old");
  // Hold the reload's read until the write and the re-read are done.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const all = db.all;
  db.all = (async (...args: Parameters<typeof all>) => {
    db.all = all;
    const rows = await all.apply(db, args);
    await gate;
    return rows;
  }) as typeof all;
  try {
    const reload = _reloadSettings();
    await db.run(`UPDATE vaultbase_settings SET value = 'new' WHERE key = 'app.direct'`);
    await invalidateSetting("app.direct");
    release();
    await reload;
  } finally {
    db.all = all;
  }
  expect(getSetting("app.direct", "")).toBe("new");
});
