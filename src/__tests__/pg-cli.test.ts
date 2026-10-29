/**
 * `vaultbase doctor`, `backup` and `wipe` on Postgres: on the open test
 * schema, and through the CLI entry point in a subprocess (the database
 * opened as the server opens it, checked against the data directory).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDb, getDb, initDb } from "../db/client.ts";
import { db, getDriver } from "../db/index.ts";
import { PostgresDriver } from "../db/postgres.ts";
import { runMigrations } from "../db/migrate.ts";
import { admin, hooks } from "../db/schema.ts";
import { _resetCollectionCache } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { peerChannel } from "../core/peers.ts";
import { isLocalUrl, runPostgresDoctor } from "../scripts/doctor.ts";
import { runPostgresWipeCli } from "../scripts/wipe.ts";
import { runBackup } from "../scripts/backup.ts";
import { createPublicCollection, onSqlite } from "./_helpers.ts";

const ENTRY = join(import.meta.dir, "../index.ts");
const hasDump = !onSqlite && (!!process.env["VAULTBASE_PG_DUMP"] || !!Bun.which("pg_dump"));

let dir: string;
let schema: string;
let out: string[];
let origWrite: typeof process.stdout.write;
let origErr: typeof process.stderr.write;
const envKeys = ["VAULTBASE_PG_DUMP", "VAULTBASE_PG_RESTORE", "VAULTBASE_PSQL", "NODE_ENV", "VAULTBASE_ENV", "KUBERNETES_SERVICE_HOST"];
let savedEnv: Record<string, string | undefined>;

function capture(): void {
  out = [];
  origWrite = process.stdout.write.bind(process.stdout);
  origErr = process.stderr.write.bind(process.stderr);
  const push = (chunk: unknown) => { out.push(String(chunk)); return true; };
  process.stdout.write = push as typeof process.stdout.write;
  process.stderr.write = push as typeof process.stderr.write;
}

function release(): string {
  process.stdout.write = origWrite;
  process.stderr.write = origErr;
  return out.join("");
}

async function wipe(argv: string[]): Promise<{ code: number; text: string }> {
  capture();
  try {
    const code = await runPostgresWipeCli(argv, dir);
    return { code, text: release() };
  } catch (e) {
    release();
    throw e;
  }
}

/** A stand-in client tool that prints `version` for --version. */
function fakeTool(name: string, version: string, exit = 0): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${name} (PostgreSQL) ${version}"; exit 0; fi\necho "failed on purpose" >&2\nexit ${exit}\n`);
  chmodSync(path, 0o755);
  return path;
}

const relations = async (s: string) =>
  (await db.all<{ n: string }>(`SELECT relname AS n FROM pg_class WHERE relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = ?) ORDER BY 1`, [s])).map((r) => r.n);

describe("doctor: which database URLs are on this machine", () => {
  it("loopback names and Unix sockets are; anything else isn't", () => {
    for (const url of [
      "postgres://u:p@localhost:5432/db", "postgres://u:p@127.0.0.1/db", "postgres://u:p@[::1]:5432/db",
      "postgres://u:p@/db?host=/var/run/postgresql", "postgres://u:p@/db?host=%2Fvar%2Frun",
    ]) expect(isLocalUrl(url)).toBe(true);
    for (const url of [
      "postgres://u:p@db.example.com:5432/db", "postgres://u:p@10.0.0.5/db", "postgres://u:p@localhost.example.com/db",
      "postgres://u:p@db.example.com/db?sslmode=require", "not a url",
    ]) expect(isLocalUrl(url)).toBe(false);
  });
});

describe.skipIf(onSqlite)("CLI on Postgres", () => {
  beforeEach(async () => {
    savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    for (const k of ["NODE_ENV", "VAULTBASE_ENV", "KUBERNETES_SERVICE_HOST"]) delete process.env[k];
    dir = mkdtempSync(join(tmpdir(), "vb-pgcli-"));
    await initDb(":memory:");
    await runMigrations();
    schema = (await db.get<{ s: string }>(`SELECT current_schema() AS s`))!.s;
    await getDb().insert(admin).values({ id: "a1", email: "ops@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    _resetCollectionCache();
    // A role a wipe test made and the wipe didn't drop.
    try {
      const role = (await db.get<{ r: string }>(`SELECT 'vb_ro_' || left(md5(current_database() || '/' || current_schema()), 16) AS r`))!.r;
      if (await db.get(`SELECT 1 FROM pg_roles WHERE rolname = ?`, [role])) await db.exec(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`);
    } catch { /* already gone */ }
    await closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("doctor", () => {
    it("is clean on an up-to-date schema, as far as the schema goes", async () => {
      const r = await runPostgresDoctor();
      expect(r.ok).toBe(true);
      expect(r.about).toContain(`schema ${schema}`);
      expect(r.warnings.filter((w) => !/pg_dump|pg_restore|psql|create schemas/.test(w))).toEqual([]);
      // The test server is on loopback: an unencrypted connection there isn't flagged.
      expect(r.warnings.some((w) => w.includes("isn't encrypted"))).toBe(false);
    });

    it("names enabled code that uses helpers.db, and a schema behind this version", async () => {
      await getDb().insert(hooks).values({ id: "h1", name: "old", collection_name: "", event: "beforeCreate", code: `ctx.helpers.db.query("SELECT 1")`, enabled: 1, created_at: 0, updated_at: 0 });
      await getDb().insert(hooks).values({ id: "h2", name: "off", collection_name: "", event: "beforeCreate", code: `ctx.helpers.db.query("SELECT 1")`, enabled: 0, created_at: 0, updated_at: 0 });
      await db.exec(`ALTER TABLE vaultbase_jobs DROP COLUMN file_error`);
      const r = await runPostgresDoctor();
      expect(r.ok).toBe(true);
      expect(r.warnings.filter((w) => w.includes("helpers.db"))).toEqual([
        "hook 'old' uses helpers.db, which fails on Postgres when it runs: change it to helpers.sql.",
      ]);
      expect(r.warnings.some((w) => w.includes("vaultbase_jobs.file_error") && w.includes("next start"))).toBe(true);
    });

    it("says an empty schema gets its tables at the first start", async () => {
      const tables = await db.all<{ n: string }>(
        `SELECT relname AS n FROM pg_class WHERE relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = ?) AND relkind = 'r'`, [schema],
      );
      await db.exec(`DROP TABLE ${tables.map((t) => `"${t.n}"`).join(", ")} CASCADE`);
      const r = await runPostgresDoctor();
      expect(r.ok).toBe(true);
      expect(r.warnings.some((w) => w.includes("no Vaultbase tables yet"))).toBe(true);
    });

    it("checks the client tools' versions", async () => {
      process.env["VAULTBASE_PSQL"] = fakeTool("psql", "18.0");
      process.env["VAULTBASE_PG_DUMP"] = fakeTool("pg_dump", "18.0");
      process.env["VAULTBASE_PG_RESTORE"] = fakeTool("pg_restore", "16.9");
      let w = (await runPostgresDoctor()).warnings.join("\n");
      expect(w).toContain("pg_restore 16.9 is too old for restore");

      process.env["VAULTBASE_PG_RESTORE"] = fakeTool("pg_restore", "17.6");
      w = (await runPostgresDoctor()).warnings.join("\n");
      expect(w).toContain("pg_restore 17.6 can't read archives from pg_dump 18.0");

      process.env["VAULTBASE_PG_DUMP"] = fakeTool("pg_dump", "15.14");
      process.env["VAULTBASE_PG_RESTORE"] = fakeTool("pg_restore", "18.0");
      const server = Math.floor(Number((await db.get<{ v: string }>(`SELECT current_setting('server_version_num') AS v`))!.v) / 10_000);
      w = (await runPostgresDoctor()).warnings.join("\n");
      expect(w).toContain(`pg_dump 15.14 can't dump a Postgres ${server} server`);

      process.env["VAULTBASE_PG_DUMP"] = join(dir, "missing-pg_dump");
      process.env["VAULTBASE_PG_RESTORE"] = join(dir, "missing-pg_restore");
      w = (await runPostgresDoctor()).warnings.join("\n");
      expect(w).toContain("pg_dump not found");
      expect(w).toContain("pg_restore or psql not found");
    });
  });

  describe("backup", () => {
    it.skipIf(!hasDump)("writes a pg_dump archive of the schema to a local file, with nothing left beside it", async () => {
      await createPublicCollection({ name: "notes", fields: JSON.stringify([{ name: "title", type: "text" }]) });
      await createRecord("notes", { title: "in the archive" });
      const dest = join(dir, "out", "snap.dump");
      await runBackup(join(dir, "data.db"), ["--to", dest, "--quiet"]);
      const bytes = readFileSync(dest);
      expect(bytes.subarray(0, 5).toString()).toBe("PGDMP");
      expect(bytes.includes(Buffer.from("vb_notes"))).toBe(true);
      expect(readdirSync(join(dir, "out"))).toEqual(["snap.dump"]);
      // Owner-only: it holds password hashes.
      expect(statSync(dest).mode & 0o777).toBe(0o600);
      expect(readdirSync(dir).filter((f) => f.startsWith(".vaultbase-snap"))).toEqual([]);
    });

    it("leaves no file when pg_dump fails", async () => {
      process.env["VAULTBASE_PG_DUMP"] = fakeTool("pg_dump", "18.0", 1);
      const dest = join(dir, "snap.dump");
      await expect(runBackup(join(dir, "data.db"), ["--to", dest, "--quiet"])).rejects.toThrow("failed on purpose");
      expect(readdirSync(dir).filter((f) => f.includes("snap"))).toEqual([]);
    });

    it("refuses --gzip, and says when pg_dump is missing", async () => {
      const exit = process.exit;
      const exits: string[] = [];
      capture();
      (process as unknown as { exit: (c?: number) => never }).exit = ((c?: number) => { exits.push(String(c)); throw new Error(`exit:${c}`); }) as never;
      try {
        await runBackup(join(dir, "data.db"), ["--to", join(dir, "x.dump"), "--gzip"]).catch(() => {});
        process.env["VAULTBASE_PG_DUMP"] = join(dir, "missing-pg_dump");
        await runBackup(join(dir, "data.db"), ["--to", join(dir, "x.dump")]).catch(() => {});
      } finally {
        (process as unknown as { exit: typeof exit }).exit = exit;
      }
      const text = release();
      expect(exits).toEqual(["1", "1"]);
      expect(text).toContain("compressed already");
      expect(text).toContain("pg_dump not found");
      expect(existsSync(join(dir, "x.dump"))).toBe(false);
    });
  });

  describe("wipe", () => {
    beforeEach(() => {
      for (const f of [".secret", ".encryption-key", "database.json"]) writeFileSync(join(dir, f), "x");
      writeFileSync(join(dir, "data.db"), "not this install's");
    });

    it("dry-runs by default: lists what it would drop and what stays, changes nothing", async () => {
      await db.exec(`CREATE TABLE mine (x int)`);
      const before = await relations(schema);
      const r = await wipe([]);
      expect(r.code).toBe(0);
      expect(r.text).toContain("Dry run");
      expect(r.text).toMatch(/\d+ table\(s\)/);
      expect(r.text).toContain("1 admin(s)");
      expect(r.text).toContain("Left in place (not Vaultbase's): table mine");
      expect(await relations(schema)).toEqual(before);
      expect(existsSync(join(dir, ".secret"))).toBe(true);
    });

    it("drops Vaultbase's objects, the kept schemas and the read-only login; keeps the rest and data.db", async () => {
      await createPublicCollection({ name: "notes", fields: JSON.stringify([{ name: "title", type: "text" }]) });
      await db.exec(`CREATE VIEW vb_notes_titles AS SELECT title FROM vb_notes`);
      await db.exec(`CREATE TABLE mine (x int)`);
      const kept = `${schema}_before_restore_x`;
      await db.exec(`CREATE SCHEMA "${kept}"; CREATE TABLE "${kept}".t (x int)`);
      await db.exec(`COMMENT ON SCHEMA "${kept}" IS 'vaultbase:{"schema":"${schema}","kind":"before_restore","at":1,"source":"x.dump"}'`);
      const role = (await db.get<{ r: string }>(`SELECT 'vb_ro_' || left(md5(current_database() || '/' || current_schema()), 16) AS r`))!.r;
      await db.exec(`CREATE ROLE "${role}" LOGIN`);
      const dbname = (await db.get<{ d: string }>(`SELECT current_database() AS d`))!.d;
      await db.exec(`COMMENT ON ROLE "${role}" IS 'Vaultbase read-only login for ${dbname}/${schema}'`);
      await db.exec(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"; GRANT SELECT ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
      await db.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT SELECT ON TABLES TO "${role}"`);

      const r = await wipe(["--yes"]);
      expect(r.code).toBe(0);
      expect(r.text).toContain(`dropped role ${role}`);
      expect(await relations(schema)).toEqual(["mine"]);
      expect(await db.get(`SELECT 1 FROM pg_namespace WHERE nspname = ?`, [kept])).toBeNull();
      expect(await db.get(`SELECT 1 FROM pg_roles WHERE rolname = ?`, [role])).toBeNull();
      expect(await db.get(`SELECT 1 FROM pg_proc WHERE proname = 'vb_search_text' AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = ?)`, [schema])).toBeNull();
      for (const f of [".secret", ".encryption-key", "database.json"]) expect(existsSync(join(dir, f))).toBe(false);
      expect(existsSync(join(dir, "data.db"))).toBe(true);
      // The schema is left ready for a new install.
      await runMigrations();
      expect((await db.get<{ n: number }>(`SELECT count(*)::int AS n FROM vaultbase_admin`))!.n).toBe(0);
    });

    it("drops nothing when something else depends on Vaultbase's tables", async () => {
      await db.exec(`CREATE TABLE mine (x int)`);
      await db.exec(`CREATE VIEW admins_seen AS SELECT email FROM vaultbase_admin`);
      const before = await relations(schema);
      const r = await wipe(["--yes"]);
      expect(r.code).toBe(1);
      expect(r.text).toContain("admins_seen depends on table vaultbase_admin");
      expect(r.text).toContain("Nothing changed");
      expect(await relations(schema)).toEqual(before);
      expect(existsSync(join(dir, ".secret"))).toBe(true);
    });

    it("drops nothing when something in another schema depends on a kept schema's tables", async () => {
      const kept = `${schema}_before_restore_y`;
      const other = `${schema}_mine`;
      await db.exec(`CREATE SCHEMA "${kept}"; CREATE TABLE "${kept}".vaultbase_admin (id text PRIMARY KEY)`);
      await db.exec(`COMMENT ON SCHEMA "${kept}" IS 'vaultbase:{"schema":"${schema}","kind":"before_restore","at":1,"source":"x.dump"}'`);
      await db.exec(`CREATE SCHEMA "${other}"; CREATE VIEW "${other}".old_admins AS SELECT id FROM "${kept}".vaultbase_admin`);
      try {
        const before = await relations(schema);
        const r = await wipe(["--yes"]);
        expect(r.code).toBe(1);
        expect(r.text).toContain("old_admins depends on table");
        expect(await relations(schema)).toEqual(before);
        expect(await relations(kept)).toContain("vaultbase_admin");
        expect(await relations(other)).toEqual(["old_admins"]);
      } finally {
        await db.exec(`DROP SCHEMA "${other}" CASCADE; DROP SCHEMA "${kept}" CASCADE`);
      }
    });

    it("drops nothing when a partition or a sequence of yours would go with Vaultbase's tables", async () => {
      await db.exec(`CREATE TABLE vb_parts (id int, at int) PARTITION BY RANGE (at)`);
      await db.exec(`CREATE TABLE my_archive PARTITION OF vb_parts FOR VALUES FROM (0) TO (100)`);
      let before = await relations(schema);
      let r = await wipe([]);
      expect(r.text).toContain(`"${schema}"."my_archive"`);
      r = await wipe(["--yes"]);
      expect(r.code).toBe(1);
      expect(await relations(schema)).toEqual(before);
      await db.exec(`DROP TABLE vb_parts CASCADE`);

      await db.exec(`CREATE SEQUENCE my_counter; ALTER SEQUENCE my_counter OWNED BY vaultbase_admin.created_at`);
      before = await relations(schema);
      r = await wipe(["--yes"]);
      expect(r.code).toBe(1);
      expect(r.text).toContain("my_counter");
      expect(await relations(schema)).toEqual(before);
    });

    it("needs --force when the data directory doesn't record the database", async () => {
      rmSync(join(dir, "database.json"));
      const before = await relations(schema);
      const dry = await wipe([]);
      expect(dry.text).toContain("no database.json");
      const refused = await wipe(["--yes"]);
      expect(refused.code).toBe(2);
      expect(refused.text).toContain("doesn't record this database");
      expect(await relations(schema)).toEqual(before);
      expect((await wipe(["--yes", "--force"])).code).toBe(0);
    });

    it("leaves a role of that name alone when it isn't Vaultbase's login", async () => {
      const role = (await db.get<{ r: string }>(`SELECT 'vb_ro_' || left(md5(current_database() || '/' || current_schema()), 16) AS r`))!.r;
      await db.exec(`CREATE ROLE "${role}" NOLOGIN`);
      await db.exec(`COMMENT ON ROLE "${role}" IS 'someone else''s'`);
      const r = await wipe(["--yes"]);
      expect(r.code).toBe(0);
      expect(r.text).not.toContain(role);
      expect(await db.get(`SELECT 1 FROM pg_roles WHERE rolname = ?`, [role])).not.toBeNull();
    });

    it("refuses while a server listens on the schema, unless --force", async () => {
      const driver = getDriver() as PostgresDriver;
      const sub = await driver.listen(peerChannel(schema), () => {}, () => {});
      try {
        const before = await relations(schema);
        const dry = await wipe([]);
        expect(dry.text).toContain("1 Vaultbase server(s) are running on this schema");
        const refused = await wipe(["--yes"]);
        expect(refused.code).toBe(2);
        expect(await relations(schema)).toEqual(before);
        const forced = await wipe(["--yes", "--force"]);
        expect(forced.code).toBe(0);
        expect(await relations(schema)).toEqual([]);
      } finally {
        await sub.unlisten();
      }
    });

    it("refuses on production signals, and while another server holds the migration lock", async () => {
      const before = await relations(schema);
      process.env["NODE_ENV"] = "production";
      expect((await wipe(["--yes"])).code).toBe(2);
      delete process.env["NODE_ENV"];

      const other = new PostgresDriver((getDriver() as PostgresDriver).url, { max: 1 });
      try {
        await other.exec(`SELECT pg_advisory_lock(hashtext('vaultbase:migrate:' || current_schema()))`);
        const r = await wipe(["--yes"]);
        expect(r.code).toBe(1);
        expect(r.text).toContain("another server is migrating or restoring");
      } finally {
        other.close();
      }
      expect(await relations(schema)).toEqual(before);
    });
  });

  describe("through the CLI", () => {
    async function cli(args: string[], env: Record<string, string | undefined>) {
      const merged: Record<string, string | undefined> = { ...process.env, VAULTBASE_DATA_DIR: dir, ...env };
      for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
      const proc = Bun.spawn(["bun", ENTRY, ...args], { stdout: "pipe", stderr: "pipe", env: merged as Record<string, string> });
      const timer = setTimeout(() => proc.kill(), 30_000);
      const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      clearTimeout(timer);
      return { code, text: stdout + stderr };
    }

    it("doctor and a wipe dry run open the configured schema; the search path is checked", async () => {
      const url = (getDriver() as PostgresDriver).url;
      const doctor = await cli(["doctor"], { VAULTBASE_DATABASE_URL: url });
      expect(doctor.code).toBe(0);
      expect(doctor.text).toContain(`schema ${schema}`);
      expect(doctor.text).not.toContain("search path also names");

      const wide = url.replace(`search_path%3D${schema}`, `search_path%3D${schema}%2Cpublic`);
      expect(wide).not.toBe(url);
      const widened = await cli(["doctor"], { VAULTBASE_DATABASE_URL: wide });
      expect(widened.text).toContain("the search path also names public");

      const dry = await cli(["wipe"], { VAULTBASE_DATABASE_URL: url });
      expect(dry.code).toBe(0);
      expect(dry.text).toContain(`schema ${schema}`);
      expect(dry.text).toContain("Dry run");
    }, 60_000);

    it("refuses on SQLite when the data directory belongs to a Postgres install, and on another database", async () => {
      writeFileSync(join(dir, "database.json"), JSON.stringify({ database: "postgres", install_id: "elsewhere", location: { schema: "other" }, written_at: "" }));
      for (const command of [["doctor"], ["wipe", "--yes"], ["backup", "--to", join(dir, "b.db")]]) {
        const r = await cli(command, { VAULTBASE_DATABASE_URL: undefined });
        expect(r.code).toBe(2);
        expect(r.text).toContain("belongs to an install on Postgres");
      }
      const r = await cli(["wipe", "--yes"], { VAULTBASE_DATABASE_URL: (getDriver() as PostgresDriver).url });
      expect(r.code).toBe(2);
      expect(r.text).toContain("isn't the one this data directory's install runs on");
      expect((await relations(schema)).length).toBeGreaterThan(0);
    }, 60_000);
  });
});
