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
