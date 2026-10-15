/**
 * Backups on Postgres: pg_dump archives of the server's schema, through the
 * same pipeline as SQLite's (local copies, keep count, download). Runs when
 * VAULTBASE_TEST_DB is Postgres and VAULTBASE_PG_DUMP (or pg_dump on the
 * PATH) is there; restore from the admin stays SQLite-only.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDb, initDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { backupEngine, isBackupName, listBackups, runBackup, setBackupsDir } from "../core/backups.ts";
import { createPublicCollection, onSqlite } from "./_helpers.ts";

const hasDump = !onSqlite && (!!process.env["VAULTBASE_PG_DUMP"] || !!Bun.which("pg_dump"));

describe.skipIf(!hasDump)("backups on Postgres", () => {
  let dir: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "vb-pgdump-"));
    setBackupsDir(dir);
    await initDb(":memory:");
    await runMigrations();
  });
  afterEach(async () => {
    _resetCollectionCache();
    await closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a pg_dump archive of the schema, named and kept like SQLite's", async () => {
    expect(backupEngine()).toBe("pg_dump");
    await createPublicCollection({ name: "notes", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    await createRecord("notes", { title: "kept in the dump" });
    const info = await runBackup();
    expect(info.name.endsWith(".dump")).toBe(true);
    expect(isBackupName(info.name)).toBe(true);
    expect(info.size).toBeGreaterThan(0);
    const bytes = readFileSync(join(dir, info.name));
    expect(bytes.subarray(0, 5).toString()).toBe("PGDMP"); // the custom-format header
    expect(bytes.includes(Buffer.from("vb_notes"))).toBe(true);
    expect(listBackups().map((b) => b.name)).toEqual([info.name]);
  });
});
