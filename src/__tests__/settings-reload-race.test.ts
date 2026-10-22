/**
 * The background reload read the whole table and swapped it in. A setting
 * written while that read was in flight got its old value back for up to
 * the next reload, and the caches rebuilt from it kept the old one longer.
 */
import { afterEach, beforeEach, expect, it } from "bun:test";
import { closeDb, initDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { _reloadSettings, getSetting, loadSettings, setSetting } from "../api/settings.ts";

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
