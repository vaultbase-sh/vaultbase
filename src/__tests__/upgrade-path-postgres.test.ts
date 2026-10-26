/**
 * Upgrade path on Postgres: databases that earlier releases made on Postgres
 * work on this one.
 *
 * Each fixture in fixtures/upgrade-postgres/ is a plain pg_dump of a real old
 * release's schema, filled through that release's own API
 * (scripts/make-upgrade-fixture.ts --postgres), with the same manifest as the
 * SQLite fixtures. The test restores it into a fresh schema, runs today's
 * migrations twice, and makes the same checks as the SQLite upgrade test.
 *
 * To add a release (from 0.23.0, when Postgres support shipped):
 *   bun scripts/make-upgrade-fixture.ts vX.Y.Z <binary> --postgres postgres://…
 */
import { describe, expect, it, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SQL } from "bun";
import { initDb, closeDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { invalidateHookCache } from "../core/hooks.ts";
import { stopScheduler } from "../core/jobs.ts";
import { stopQueueScheduler } from "../core/queues.ts";
import { stopWebhookDispatcher } from "../core/webhooks.ts";
import { stopUpdateCheckScheduler } from "../core/update-check.ts";
import { _reset as resetRealtime } from "../realtime/manager.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { onSqlite } from "./_helpers.ts";
import { checkUpgraded, type UpgradeManifest } from "./_upgrade-checks.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "upgrade-postgres");
const versions = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();

/** The schema the fixtures were made in (scripts/make-upgrade-fixture.ts). */
const FIXTURE_SCHEMA = "vbfixture";

/**
 * Restore a fixture's dump into `schema` (which exists, empty): the dump's
 * schema renamed, its CREATE SCHEMA dropped, and psql's meta-commands
 * (`\restrict`, `\unrestrict`) left out, since this isn't psql. On a
 * connection of its own: the dump sets search_path to '' for the session.
 */
async function restore(dump: string, schema: string): Promise<void> {
  const sql = dump
    .split("\n")
    .filter((line) => !/^\\(un)?restrict\b/.test(line))
    .join("\n")
    .replace(new RegExp(`^CREATE SCHEMA ${FIXTURE_SCHEMA};$`, "m"), "")
    .replace(new RegExp(`\\b${FIXTURE_SCHEMA}\\b`, "g"), schema);
  const conn = new SQL(process.env["VAULTBASE_TEST_DB"]!);
  try {
    await conn.unsafe(sql).simple();
  } finally {
    await conn.close();
  }
}

let dir = "";
afterEach(async () => {
  stopScheduler(); stopQueueScheduler(); stopWebhookDispatcher(); stopUpdateCheckScheduler();
  resetRealtime();
  _resetCollectionCache();
  invalidateHookCache();
  await closeDb();
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ } dir = ""; }
});

describe.skipIf(onSqlite)("upgrade path on Postgres", () => {
  it("has fixtures to check", () => {
    expect(versions.length).toBeGreaterThanOrEqual(4);
    expect(versions[0]).toBe("v0.23.2");
  });

  for (const version of versions) {
    it(`a ${version} Postgres database works on this release`, async () => {
      const m = JSON.parse(await Bun.file(join(FIXTURES, `${version}.json`)).text()) as UpgradeManifest;
      dir = mkdtempSync(join(tmpdir(), `vb-upgrade-pg-${version}-`));
      setLogsDir(join(dir, "logs"));

      // A fresh, empty test schema; the old release's tables go into it.
      await initDb(":memory:");
      const schema = (await db.get<{ s: string }>(`SELECT current_schema() AS s`))!.s;
      expect((await db.get<{ n: number }>(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = ?`, [schema]))!.n).toBe(0);
      await restore(await Bun.file(join(FIXTURES, `${version}.sql`)).text(), schema);
      expect((await db.get<{ n: number }>(`SELECT count(*)::int AS n FROM vaultbase_collections`))!.n).toBeGreaterThan(0);

      await runMigrations();
      await runMigrations(); // runs at every start: must be repeatable

      await checkUpgraded(m, dir, join(dir, "data.db"));
    }, 60_000);
  }
});
