/**
 * The database is chosen at install and is final (core/install-marker.ts):
 * the data directory records the install's database in database.json, and
 * a start on another one is refused with the fix in the message.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { SQL } from "bun";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, initDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import {
  checkDataDir, checkInstallId, configureInstallRecord, InstallMismatchError, MARKER_FILE, openInstallDatabase, recordInstall,
} from "../core/install-marker.ts";
import { makeAuthPlugin } from "../api/auth.ts";
import { configureSetupKey, requiredSetupKey } from "../core/setup-key.ts";
import { onSqlite } from "./_helpers.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vb-install-"));
  delete process.env["VAULTBASE_DATABASE_MOVED"];
});
afterEach(async () => {
  delete process.env["VAULTBASE_DATABASE_MOVED"];
  configureInstallRecord(null);
  _resetCollectionCache();
  await closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const driver = () => db.name;
const other = () => (db.name === "sqlite" ? "postgres" : "sqlite");
const marker = () => JSON.parse(readFileSync(join(dir, MARKER_FILE), "utf8")) as { database: string; install_id: string; location: Record<string, unknown>; written_at: string };
const dbId = async () => (await db.get<{ id: string }>(`SELECT id FROM vaultbase_install WHERE key = 'install'`))?.id ?? null;
const addAdmin = () => db.run(`INSERT INTO vaultbase_admin (id, email, password_hash, created_at) VALUES ('a1', 'a@x.io', 'h', 1)`);

/** A started install with an admin: migrated, recorded. */
async function install(): Promise<string> {
  await initDb(":memory:");
  checkDataDir(dir, driver());
  await checkInstallId(dir);
  await runMigrations();
  configureInstallRecord(dir);
  await recordInstall();
  await addAdmin();
  await recordInstall();
  return marker().install_id;
}

describe("the database an install runs on", () => {
  it("is recorded once the install has an admin, not before", async () => {
    await initDb(":memory:");
    await runMigrations();
    configureInstallRecord(dir);
    await recordInstall();
    // An id from the first start; the record waits for the admin, since
    // switching databases before setup loses nothing.
    const id = await dbId();
    expect(id).toBeTruthy();
    expect(existsSync(join(dir, MARKER_FILE))).toBe(false);
    await addAdmin();
    await recordInstall();
    const m = marker();
    expect(m.database).toBe(driver());
    expect(m.install_id).toBe(id!);
    // Where it is, never how to log in.
    expect(JSON.stringify(m)).not.toMatch(/password|vaultbase:vaultbase@/);
    if (driver() === "postgres") expect(m.location["schema"]).toBeTruthy();
  });

  it("a restart on the same database passes, and leaves the record as it was", async () => {
    await install();
    const before = readFileSync(join(dir, MARKER_FILE), "utf8");
    checkDataDir(dir, driver());
    await checkInstallId(dir);
    await recordInstall();
    expect(readFileSync(join(dir, MARKER_FILE), "utf8")).toBe(before);
  });

  it("the other database is refused before it is opened, with how to point it back", async () => {
    await install();
    let msg = "";
    try { checkDataDir(dir, other()); } catch (e) { msg = e instanceof InstallMismatchError ? e.message : ""; }
    expect(msg).toContain(driver() === "postgres" ? "Set VAULTBASE_DATABASE_URL" : "Unset VAULTBASE_DATABASE_URL");
    expect(msg).toContain("chosen at install");
    // The override is for moves within one database kind, not this.
    process.env["VAULTBASE_DATABASE_MOVED"] = marker().install_id;
    expect(() => checkDataDir(dir, other())).toThrow(InstallMismatchError);
  });

  it("an empty database is refused, override or not", async () => {
    await install();
    await closeDb();
    await initDb(":memory:"); // another, empty database of the same kind
    await expect(checkInstallId(dir)).rejects.toThrow(/it is empty/);
    process.env["VAULTBASE_DATABASE_MOVED"] = marker().install_id;
    await expect(checkInstallId(dir)).rejects.toThrow(/it is empty/);
  });

  it("another install's database is refused; moved there on purpose, by its id, the record follows it", async () => {
    await install();
    await db.run(`UPDATE vaultbase_install SET id = 'other-install' WHERE key = 'install'`);
    await expect(checkInstallId(dir)).rejects.toThrow(/belongs to another install \(other-install\).*VAULTBASE_DATABASE_MOVED=other-install\./);
    // Only that database's id is accepted, so the variable left set can't
    // let any other through.
    for (const v of ["1", "true", marker().install_id]) {
      process.env["VAULTBASE_DATABASE_MOVED"] = v;
      await expect(checkInstallId(dir)).rejects.toThrow(InstallMismatchError);
    }
    process.env["VAULTBASE_DATABASE_MOVED"] = "other-install";
    await checkInstallId(dir);
    await recordInstall();
    expect(marker().install_id).toBe("other-install");
    // Not needed from then on; left set, it's harmless.
    await checkInstallId(dir);
    delete process.env["VAULTBASE_DATABASE_MOVED"];
    await checkInstallId(dir);
  });

  it("a copy made before install ids is refused; moved on purpose, it takes this install's id", async () => {
    const id = await install();
    await db.run(`DELETE FROM vaultbase_install`);
    let msg = "";
    try { await checkInstallId(dir); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/no install id/);
    // The value names this copy (where it is), not the install.
    const value = /VAULTBASE_DATABASE_MOVED=(adopt-[0-9a-f]{12})\./.exec(msg)![1]!;
    for (const wrong of ["1", id]) {
      process.env["VAULTBASE_DATABASE_MOVED"] = wrong;
      await expect(checkInstallId(dir)).rejects.toThrow(`VAULTBASE_DATABASE_MOVED is set to ${wrong}, which isn't that`);
    }
    process.env["VAULTBASE_DATABASE_MOVED"] = value;
    await checkInstallId(dir);
    await recordInstall();
    expect(await dbId()).toBe(id);
    expect(marker().install_id).toBe(id);

    // Left set, it doesn't adopt another copy without an id.
    await closeDb();
    await initDb(":memory:");
    await runMigrations();
    await db.run(`DELETE FROM vaultbase_install`);
    await expect(checkInstallId(dir)).rejects.toThrow(/no install id/);
  });

  it("an install from before 0.29 gets its id and record at its next start", async () => {
    await initDb(":memory:");
    await runMigrations();
    await addAdmin();
    await db.run(`DELETE FROM vaultbase_install`); // as an earlier release left it
    checkDataDir(dir, driver());
    await checkInstallId(dir);
    await runMigrations();
    configureInstallRecord(dir);
    await recordInstall();
    expect(marker().install_id).toBe((await dbId())!);
  });

  it("a restore moves the record to the restored database, admin or not", async () => {
    await install();
    await db.run(`DELETE FROM vaultbase_admin`);
    await db.run(`UPDATE vaultbase_install SET id = 'restored'`);
    await recordInstall();
    expect(marker().install_id).toBe("restored");
  });

  it("writers at once leave one whole record and no temp files", async () => {
    await install();
    await db.run(`UPDATE vaultbase_install SET id = 'next'`);
    await Promise.all(Array.from({ length: 8 }, () => recordInstall()));
    expect(marker().install_id).toBe("next");
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("the first admin made through the setup page writes the record", async () => {
    await initDb(":memory:");
    await runMigrations();
    configureInstallRecord(dir);
    await recordInstall();
    configureSetupKey(null);
    const res = await makeAuthPlugin("test-install-marker").handle(new Request("http://localhost/admin/setup", {
      method: "POST",
      headers: { "content-type": "application/json", "x-setup-key": requiredSetupKey({ quiet: true }) },
      body: JSON.stringify({ email: "a@x.io", password: "super-strong-password" }),
    }));
    expect(res.status).toBe(200);
    expect(marker().install_id).toBe((await dbId())!);
  });

  it("a record it can't read stops the start, saying which file", async () => {
    writeFileSync(join(dir, MARKER_FILE), "{ not json");
    expect(() => checkDataDir(dir, "sqlite")).toThrow(new RegExp(MARKER_FILE));
    writeFileSync(join(dir, MARKER_FILE), JSON.stringify({ database: "oracle", install_id: "x" }));
    expect(() => checkDataDir(dir, "sqlite")).toThrow(/understands/);
  });
});

describe.skipIf(!onSqlite)("SQLite: a refused start leaves no file behind", () => {
  it("a database file the record expects but isn't there isn't created", async () => {
    writeFileSync(join(dir, MARKER_FILE), JSON.stringify({ database: "sqlite", install_id: "x", location: {} }));
    const other = join(dir, "other.db");
    await expect(openInstallDatabase(dir, `file:${other}`)).rejects.toThrow(/doesn't exist/);
    expect(existsSync(other)).toBe(false);
  });
});

describe.skipIf(onSqlite)("Postgres: a data directory from before the record", () => {
  function sqliteInstall(withAdmin: boolean) {
    const d = new Database(join(dir, "data.db"));
    d.exec(`CREATE TABLE vaultbase_admin (id TEXT PRIMARY KEY, email TEXT)`);
    if (withAdmin) d.exec(`INSERT INTO vaultbase_admin VALUES ('a1', 'a@x.io')`);
    d.close();
  }

  it("a SQLite install with an admin isn't started on a Postgres database without one, override or not", async () => {
    sqliteInstall(true);
    await initDb(":memory:");
    await expect(checkInstallId(dir)).rejects.toThrow(/holds a SQLite install.*move data\.db aside/);
    process.env["VAULTBASE_DATABASE_MOVED"] = "1";
    await expect(checkInstallId(dir)).rejects.toThrow(InstallMismatchError);
  });

  it("a Postgres install with a SQLite trial left behind starts", async () => {
    sqliteInstall(true);
    await initDb(":memory:");
    await runMigrations();
    await addAdmin();
    await checkInstallId(dir);
  });

  it("before its first admin, switching is free", async () => {
    sqliteInstall(false);
    await initDb(":memory:");
    await checkInstallId(dir);
  });

  it("an empty schema first on the search path is refused, though the install's is behind it", async () => {
    const base = process.env["VAULTBASE_TEST_DB"]!;
    const [a, b] = [`vb_inst_a_${process.pid}`, `vb_inst_b_${process.pid}`];
    const url = (path: string) => `${base}${base.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${path}`)}`;
    const admin = new SQL(base);
    await admin.unsafe(`CREATE SCHEMA ${a}; CREATE SCHEMA ${b}`).simple();
    try {
      await initDb(url(a));
      await runMigrations();
      configureInstallRecord(dir);
      await recordInstall();
      await addAdmin();
      await recordInstall();
      await closeDb();
      // A schema made later lands first on the path ("$user", public).
      await initDb(url(`${b},${a}`));
      await expect(checkInstallId(dir)).rejects.toThrow(/it is empty/);
    } finally {
      configureInstallRecord(null);
      await closeDb();
      await admin.unsafe(`DROP SCHEMA ${a} CASCADE; DROP SCHEMA ${b} CASCADE`).simple();
      await admin.close();
      await initDb(":memory:"); // for afterEach
    }
  });
});
