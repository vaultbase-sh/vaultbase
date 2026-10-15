/**
 * Caches on the request path: settings, parsed field lists, table columns,
 * private-field sets and per-field decoders. Each must refresh when its
 * source changes.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache, cachedFields, getCollection, privateFieldNames } from "../core/collections.ts";
import { getSetting, setSetting, _resetSettingsCache, _reloadSettings, loadSettings, invalidateSetting, getAllSettings } from "../api/settings.ts";
import { tableColumns, invalidateUserTableColumnCache } from "../core/users-table.ts";
import { registerFieldType } from "../core/field-types.ts";
import { listRecords, createRecord } from "../core/records.ts";
import { createPublicCollection } from "./_helpers.ts";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  _resetSettingsCache();
  invalidateUserTableColumnCache();
});

afterEach(async () => {
  _resetCollectionCache();
  await closeDb();
});

describe("settings cache", () => {
  it("a write through setSetting is visible at once, a direct write after the reset hook", () => {
    expect(getSetting("app.name", "dflt")).toBe("dflt");
    setSetting("app.name", "one");
    expect(getSetting("app.name", "dflt")).toBe("one");
    getRawClient().prepare(`UPDATE vaultbase_settings SET value = 'two' WHERE key = 'app.name'`).run();
    expect(getSetting("app.name", "dflt")).toBe("one");
    _resetSettingsCache();
    expect(getSetting("app.name", "dflt")).toBe("two");
  });

  it("the background reload and invalidateSetting pick up a direct write; loadSettings fills the store at boot", async () => {
    setSetting("app.name", "one");
    getRawClient().prepare(`UPDATE vaultbase_settings SET value = 'two' WHERE key = 'app.name'`).run();
    expect(getSetting("app.name", "dflt")).toBe("one");
    await _reloadSettings();
    expect(getSetting("app.name", "dflt")).toBe("two");
    getRawClient().prepare(`UPDATE vaultbase_settings SET value = 'three' WHERE key = 'app.name'`).run();
    await invalidateSetting("app.name");
    expect(getSetting("app.name", "dflt")).toBe("three");
    getRawClient().prepare(`DELETE FROM vaultbase_settings WHERE key = 'app.name'`).run();
    await invalidateSetting("app.name");
    expect(getSetting("app.name", "dflt")).toBe("dflt");
    setSetting("app.name", "four");
    _resetSettingsCache();
    await loadSettings();
    expect(getSetting("app.name", "dflt")).toBe("four");
    expect(getAllSettings()["app.name"]).toBe("four");
  });

  it("a reopened database never answers from the old connection's cache", async () => {
    setSetting("app.name", "old-db");
    expect(getSetting("app.name", "")).toBe("old-db");
    await closeDb();
    await initDb(":memory:");
    await runMigrations();
    expect(getSetting("app.name", "fresh")).toBe("fresh");
  });
});

describe("cachedFields", () => {
  it("returns one frozen array per fields JSON", () => {
    const raw = JSON.stringify([{ name: "title", type: "text", options: { max: 3 } }]);
    const a = cachedFields(raw);
    expect(cachedFields(raw)).toBe(a);
    expect(cachedFields(JSON.stringify([{ name: "other", type: "text" }]))).not.toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a[0])).toBe(true);
    expect(() => (a as Array<unknown>).push({})).toThrow();
    expect(() => { (a[0] as { name: string }).name = "x"; }).toThrow();
    expect(cachedFields("")).toEqual([]);
    expect(cachedFields("not json")).toEqual([]);
  });

  it("privateFieldNames sees a password field and is memoised for non-views", () => {
    const col = { type: "base" as const, fields: JSON.stringify([{ name: "secret", type: "password" }, { name: "x", type: "text" }]) };
    const a = privateFieldNames(col);
    expect([...a]).toEqual(["secret"]);
    expect(privateFieldNames(col)).toBe(a);
    expect([...privateFieldNames({ type: "auth", fields: "[]" })]).toContain("password_hash");
  });
});

describe("tableColumns cache", () => {
  it("refreshes when the schema changes, on this or another connection", async () => {
    await createPublicCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    const a = tableColumns("posts");
    expect(a).toContain("title");
    expect(tableColumns("posts")).toBe(a);
    getRawClient().exec(`ALTER TABLE "vb_posts" ADD COLUMN "extra" TEXT`);
    expect(tableColumns("posts")).toContain("extra");
  });
});

describe("decoder cache", () => {
  it("picks up a field type registered later and drops it when it is removed", async () => {
    const unregister = registerFieldType({ type: "money", sqlType: "INTEGER", decode: (v) => `$${Number(v) / 100}` });
    try {
      await createPublicCollection({ name: "bills", fields: JSON.stringify([{ name: "amount", type: "money" }, { name: "flag", type: "bool" }, { name: "meta", type: "json" }]) });
      await createRecord("bills", { amount: 1250, flag: true, meta: { a: 1 } });
      let rows = (await listRecords("bills", {})).data;
      expect(rows[0]!["amount"]).toBe("$12.5");
      expect(rows[0]!["flag"]).toBe(true);
      expect(rows[0]!["meta"]).toEqual({ a: 1 });
      unregister();
      rows = (await listRecords("bills", {})).data;
      expect(rows[0]!["amount"]).toBe(1250);
    } finally {
      unregister();
    }
    expect(await getCollection("bills")).not.toBeNull();
  });
});
