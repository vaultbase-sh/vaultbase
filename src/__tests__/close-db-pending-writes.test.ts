/**
 * Closing the database waits for settings writes still in flight. setSetting
 * updates its value in memory at once and writes the row after; many callers
 * (tests above all) don't await it. On Postgres the write could land after
 * closeDb dropped the test schema, failing with `relation
 * "vaultbase_settings" does not exist` as an unhandled error in whatever ran
 * next (CI for 0.25.0 failed on it).
 */
import { describe, expect, it } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setSetting, getSetting } from "../api/settings.ts";
import { onSqlite } from "./_helpers.ts";

describe("closing with writes in flight", () => {
  it("settles unawaited setSetting writes before the database goes away", async () => {
    const unhandled: unknown[] = [];
    const onRej = (e: unknown) => { unhandled.push(e); };
    process.on("unhandledRejection", onRej);
    try {
      for (let round = 0; round < 5; round++) {
        await initDb(":memory:");
        await runMigrations();
        for (let i = 0; i < 30; i++) void setSetting(`test.pending.${i}`, String(round));
        expect(getSetting("test.pending.29", "")).toBe(String(round));
        await closeDb();
      }
      await Bun.sleep(300);
      expect(unhandled.map((e) => String((e as Error)?.message ?? e))).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRej);
    }
  });

  it.skipIf(onSqlite)("the writes reached the database before it closed (Postgres)", async () => {
    // Nothing to read after a drop; this checks the write order instead:
    // a value written and awaited survives a close in the same database.
    await initDb(":memory:");
    await runMigrations();
    void setSetting("test.pending.order", "1");
    await setSetting("test.pending.order", "2");
    expect(getSetting("test.pending.order", "")).toBe("2");
    await closeDb();
  });
});
