/**
 * A settings save that turned maintenance mode on and set its message wrote
 * `enabled` first: the maintenance sweep could close clients' connections in
 * between (a Postgres round trip apart) and tell them the default message.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { db } from "../db/index.ts";
import { applySettingsPatch } from "../api/settings.ts";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
});
afterEach(async () => { await closeDb(); });

describe("settings save order", () => {
  it("writes switches after the values they act on", async () => {
    const order: string[] = [];
    const realRun = db.run;
    (db as { run: typeof realRun }).run = ((sql: string, params?: unknown[], opts?: unknown) => {
      if (/vaultbase_settings/.test(sql) && Array.isArray(params)) order.push(String(params[0]));
      return realRun(sql, params as never, opts as never);
    }) as typeof realRun;
    try {
      await applySettingsPatch({ "maintenance_mode.enabled": "1", "maintenance_mode.message": "Back soon", "maintenance_mode.level": "full" });
    } finally {
      (db as { run: typeof realRun }).run = realRun;
    }
    expect(order.at(-1)).toBe("maintenance_mode.enabled");
    expect(order).toContain("maintenance_mode.message");
  });
});
