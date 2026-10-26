/**
 * Upgrade path: databases created by earlier releases boot on this one.
 *
 * Each fixture in fixtures/upgrade/ is the data.db of a real old release,
 * filled through that release's own API (scripts/make-upgrade-fixture.ts),
 * with a manifest of what was created. This opens each one with today's
 * code — migrations twice, since they run at every start — and checks over
 * HTTP that the admin, the users and their passwords, the collections, every
 * record and its values, the rules, a setting and a hook all survived, and
 * that the data can still be written.
 *
 * Nothing guarded this before: a migration that broke existing installs
 * would have passed CI. To add a release, build its fixture:
 *   bun scripts/make-upgrade-fixture.ts vX.Y.Z <that release's binary>
 */
import { describe, expect, it, afterEach } from "bun:test";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb } from "../db/client.ts";
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


const FIXTURES = join(import.meta.dir, "fixtures", "upgrade");
const versions = readdirSync(FIXTURES).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();

let dir = "";
afterEach(async () => {
  stopScheduler(); stopQueueScheduler(); stopWebhookDispatcher(); stopUpdateCheckScheduler();
  resetRealtime();
  _resetCollectionCache();
  invalidateHookCache();
  await closeDb();
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ } dir = ""; }
});

describe.skipIf(!onSqlite)("upgrade path", () => {
  it("has fixtures to check", () => {
    expect(versions.length).toBeGreaterThanOrEqual(6);
  });

  for (const version of versions) {
    it(`a ${version} database works on this release`, async () => {
      const m = JSON.parse(await Bun.file(join(FIXTURES, `${version}.json`)).text()) as UpgradeManifest;
      dir = mkdtempSync(join(tmpdir(), `vb-upgrade-${version}-`));
      setLogsDir(join(dir, "logs"));
      const dbPath = join(dir, "data.db");
      copyFileSync(join(FIXTURES, `${version}.db`), dbPath);

      await initDb(`file:${dbPath}`);
      await runMigrations();
      await runMigrations(); // runs at every start: must be repeatable

      await checkUpgraded(m, dir, dbPath);
    }, 30_000);
  }
});
