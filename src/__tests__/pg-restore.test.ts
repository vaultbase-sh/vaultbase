/**
 * Restore on Postgres (core/pg-restore.ts): a pg_dump archive staged in a
 * schema of its own and swapped in, revocations and resets carried over,
 * the previous data kept for an undo, a damaged archive refused with
 * nothing touched, writes and other servers carrying on.
 *
 * Needs pg_dump, pg_restore and psql (CI installs them; VAULTBASE_PG_DUMP,
 * VAULTBASE_PG_RESTORE and VAULTBASE_PSQL name others).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SQL } from "bun";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { closeDb, getDb, initDb } from "../db/client.ts";
import { db, getDriver } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import type { PostgresDriver } from "../db/postgres.ts";
import { admin } from "../db/schema.ts";
import { signAuthToken } from "../core/sec.ts";
import { makeBackupPlugin } from "../api/backup.ts";
import { backupPath, runBackup, setBackupsDir } from "../core/backups.ts";
import { createRecord, listRecords } from "../core/records.ts";
import { getCollection } from "../core/collections.ts";
import { dropExpiredRestoreSchemas, listPreviousData, restoreArchive, RestoreSwapped, restoreTools, sweepRestoreFiles } from "../core/pg-restore.ts";
import { _peersIdle, startPeers, stopPeers } from "../core/peers.ts";
import { createPublicCollection, onSqlite } from "./_helpers.ts";

const PG = process.env["VAULTBASE_TEST_DB"] ?? "";
const canRestore = !onSqlite && restoreTools() !== null && !!(process.env["VAULTBASE_PG_DUMP"] || Bun.which("pg_dump"));
const SECRET = "test-secret-pg-restore";

let dir = "";
let app: ReturnType<typeof makeBackupPlugin>;

async function call(method: string, path: string, body?: string | FormData, headers: Record<string, string> = {}): Promise<{ status: number; json: any; text: string }> {
  const { token } = await signAuthToken({ payload: { id: "a1" }, audience: "admin", expiresInSeconds: 600, jwtSecret: SECRET });
  const res = await app.handle(new Request(`http://localhost${path}`, { method, headers: { authorization: `Bearer ${token}`, ...headers }, ...(body !== undefined ? { body } : {}) }));
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* ndjson or empty */ }
  return { status: res.status, json, text };
}

const titles = async (c = "posts") => (await listRecords(c, { perPage: 100, sort: "title" })).data.map((r) => String((r as unknown as { title: string }).title));
const schemaNow = async () => (await db.get<{ s: string }>(`SELECT current_schema() AS s`))!.s;

/** Schemas the restore made for this install (previous data, staging). */
async function notedSchemas(): Promise<string[]> {
  const live = await schemaNow();
  return (await db.all<{ n: string }>(
    `SELECT nspname AS n FROM pg_namespace WHERE obj_description(oid, 'pg_namespace') LIKE ?`, [`vaultbase:%"schema":"${live}"%`],
  )).map((r) => r.n);
}

async function setUp(): Promise<void> {
  dir = mkdtempSync(join(tmpdir(), "vb-pgrestore-"));
  await initDb(":memory:");
  await runMigrations();
  await getDb().insert(admin).values({ id: "a1", email: "ops@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
  setBackupsDir(join(dir, "backups"));
  app = makeBackupPlugin(SECRET, join(dir, "data.db"));
  await createPublicCollection({
    name: "posts",
    fields: JSON.stringify([{ name: "title", type: "text", options: { searchable: true } }]),
  });
  await createRecord("posts", { title: "Café" });
}

/** A backup of the data as it is now; its name and path. */
async function backUp(): Promise<{ name: string; path: string }> {
  const { name } = await runBackup();
  return { name, path: backupPath(name)! };
}


/**
 * A pg_restore that passes `--list` through and edits the SQL it writes
 * with `awk` (a program over the real output), to stand for an archive
 * whose SQL holds something it shouldn't.
 */
async function withEditedPgRestore<T>(awk: string, fn: () => Promise<T>): Promise<T> {
  const fake = join(dir, `pg_restore_${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(fake, [
    "#!/bin/sh",
    'case " $* " in *" --list "*) exec "$VB_REAL_PG_RESTORE" "$@";; esac',
    `"$VB_REAL_PG_RESTORE" "$@" | awk '${awk}'`,
  ].join("\n"), { mode: 0o755 });
  const before = process.env["VAULTBASE_PG_RESTORE"];
  process.env["VB_REAL_PG_RESTORE"] = restoreTools()!.pgRestore;
  process.env["VAULTBASE_PG_RESTORE"] = fake;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env["VAULTBASE_PG_RESTORE"]; else process.env["VAULTBASE_PG_RESTORE"] = before;
  }
}

describe.skipIf(!canRestore)("restore on Postgres", () => {
  beforeEach(setUp);
  afterEach(async () => {
    await closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it("puts a backup's data in place of the live data, keeping what was revoked since", async () => {
    const { name } = await backUp();
    // Since the backup: a record, a collection, a revoked token, a sign-out everywhere.
    await createRecord("posts", { title: "After" });
    await createPublicCollection({ name: "later", fields: JSON.stringify([{ name: "title", type: "text" }]) });
    const future = Math.floor(Date.now() / 1000) + 3600;
    await db.run(`INSERT INTO vaultbase_token_revocations (jti, expires_at, revoked_at) VALUES ('since-backup', ?, 1)`, [future]);
    await db.run(`UPDATE vaultbase_admin SET password_reset_at = 999 WHERE id = 'a1'`);

    const res = await call("POST", `/admin/backups/${name}/restore`);
    expect(res.status).toBe(200);
    expect(res.json.data.message).toMatch(/kept for 7 days/);

    expect(await titles()).toEqual(["Café"]);
    expect(await getCollection("later")).toBeNull();
    expect(await db.get(`SELECT 1 FROM vaultbase_token_revocations WHERE jti = 'since-backup'`)).toBeTruthy();
    expect((await db.get<{ p: number }>(`SELECT password_reset_at AS p FROM vaultbase_admin WHERE id = 'a1'`))!.p).toBe(999);
    // Search on the restored table, and writes to it (its generated search column).
    expect((await listRecords("posts", { search: "cafe" })).data.map((r) => String((r as unknown as { title: string }).title))).toEqual(["Café"]);
    await createRecord("posts", { title: "Écrit après" });
    expect((await listRecords("posts", { search: "ecrit" })).totalItems).toBe(1);

    // The data it replaced is kept, named after the backup.
    const kept = await listPreviousData();
    expect(kept.length).toBe(1);
    expect(kept[0]).toMatchObject({ replaced_by: "restore", source: name });
    expect(kept[0]!.expires_at - kept[0]!.at).toBe(7 * 86_400);
    const old = await db.all<{ title: string }>(`SELECT title FROM "${kept[0]!.schema}".vb_posts ORDER BY title`);
    expect(old.map((r) => r.title)).toEqual(["After", "Café"]);
    // The staging schema is gone.
    expect(await notedSchemas()).toEqual([kept[0]!.schema]);
  });

  it("an undo puts the previous data back, and keeps what it replaced", async () => {
    const { name } = await backUp();
    await createRecord("posts", { title: "After" });
    expect((await call("POST", `/admin/backups/${name}/restore`)).status).toBe(200);
    await createRecord("posts", { title: "On the restored data" });
    // Revoked after the restore: an undo doesn't bring it back either.
    await db.run(`INSERT INTO vaultbase_token_revocations (jti, expires_at, revoked_at) VALUES ('since-restore', ?, 1)`, [Math.floor(Date.now() / 1000) + 3600]);
    const [kept] = await listPreviousData();

    const undo = await call("POST", `/admin/restores/${encodeURIComponent(kept!.schema)}/undo`);
    expect(undo.status).toBe(200);
    expect(await titles()).toEqual(["After", "Café"]);
    expect(await db.get(`SELECT 1 FROM vaultbase_token_revocations WHERE jti = 'since-restore'`)).toBeTruthy();
    const now = await listPreviousData();
    expect(now.length).toBe(1);
    expect(now[0]).toMatchObject({ replaced_by: "undo", source: kept!.schema });

    // Gone, or not this install's: 404.
    expect((await call("POST", `/admin/restores/${encodeURIComponent(kept!.schema)}/undo`)).status).toBe(404);
    expect((await call("POST", `/admin/restores/public/undo`)).status).toBe(404);
    expect((await call("DELETE", `/admin/restores/public`)).status).toBe(404);
    // Deleted from the backups page.
    expect((await call("DELETE", `/admin/restores/${encodeURIComponent(now[0]!.schema)}`)).status).toBe(200);
    expect(await listPreviousData()).toEqual([]);
  });

  it("a damaged or foreign file is refused with nothing changed", async () => {
    const { path } = await backUp();
    await createRecord("posts", { title: "After" });
    const bytes = readFileSync(path);
    const store = (name: string, data: Uint8Array | string) => writeFileSync(join(dir, "backups", name), data);

    // Cut short: the table of contents reads, the data doesn't.
    store("vaultbase-20200101-000000-000.dump", bytes.subarray(0, Math.floor(bytes.length * 0.8)));
    const cut = await call("POST", "/admin/backups/vaultbase-20200101-000000-000.dump/restore");
    expect(cut.status).toBe(422);
    // Not an archive at all.
    store("vaultbase-20200101-000000-001.dump", "PGDMP but not really");
    const junk = await call("POST", "/admin/backups/vaultbase-20200101-000000-001.dump/restore");
    expect(junk.status).toBe(422);
    expect(junk.json.error).toMatch(/pg_restore can't read it/);
    // A SQLite backup.
    store("vaultbase-20200101-000000-002.db", "SQLite format 3\0");
    expect((await call("POST", "/admin/backups/vaultbase-20200101-000000-002.db/restore")).status).toBe(422);
    const form = new FormData();
    form.append("file", new File(["SQLite format 3\0rest"], "x.db"));
    const up = await call("POST", "/admin/restore", form);
    expect(up.status).toBe(422);
    expect(up.json.error).toMatch(/SQLite backup, and this server runs on Postgres/);

    expect(await titles()).toEqual(["After", "Café"]);
    expect(await notedSchemas()).toEqual([]);
  });

  it("nothing is committed when pg_restore fails, however clean its output up to there", async () => {
    const { name } = await backUp();
    await createRecord("posts", { title: "After" });
    // A pg_restore that writes the tables' SQL, stops before their rows,
    // and fails: psql alone would commit empty tables.
    const fake = join(dir, "pg_restore_cut.sh");
    writeFileSync(fake, [
      "#!/bin/sh",
      'case " $* " in *" --list "*) exec "$VB_REAL_PG_RESTORE" "$@";; esac',
      '"$VB_REAL_PG_RESTORE" "$@" | awk \'/^COPY /{exit} {print}\'',
      "exit 1",
    ].join("\n"), { mode: 0o755 });
    const before = process.env["VAULTBASE_PG_RESTORE"];
    process.env["VB_REAL_PG_RESTORE"] = restoreTools()!.pgRestore;
    process.env["VAULTBASE_PG_RESTORE"] = fake;
    try {
      const res = await call("POST", `/admin/backups/${name}/restore`);
      expect(res.status).toBe(422);
      expect(res.json.error).toMatch(/pg_restore failed/);
    } finally {
      if (before === undefined) delete process.env["VAULTBASE_PG_RESTORE"]; else process.env["VAULTBASE_PG_RESTORE"] = before;
    }
    expect(await titles()).toEqual(["After", "Café"]);
    expect(await notedSchemas()).toEqual([]);
  });

  it("an uploaded archive restores, reporting each phase as it goes", async () => {
    const { path } = await backUp();
    await createRecord("posts", { title: "After" });
    const form = new FormData();
    form.append("file", new File([readFileSync(path)], "my.dump"));
    const res = await call("POST", "/admin/restore?progress=1", form);
    expect(res.status).toBe(200);
    const lines = res.text.trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.phase).map((l) => l.phase)).toEqual(["checking", "staging", "swapping", "migrating"]);
    expect(lines.at(-1)).toMatchObject({ done: true });
    expect(await titles()).toEqual(["Café"]);
    expect((await listPreviousData())[0]!.source).toBe("upload: my.dump");
    // The upload isn't left in the data directory.
    expect(require("fs").readdirSync(dir).filter((f: string) => f.includes("restore-upload"))).toEqual([]);
  });

  it("writes made during a restore all succeed; those after the swap stay", async () => {
    const { name } = await backUp();
    let stop = false;
    const failures: string[] = [];
    let written = 0;
    const writer = (async () => {
      while (!stop) {
        try { await createRecord("posts", { title: `w${written}` }); written++; } catch (e) { failures.push((e as Error).message); }
        await Bun.sleep(5);
      }
    })();
    await Bun.sleep(50);
    const res = await call("POST", `/admin/backups/${name}/restore`);
    await Bun.sleep(100);
    stop = true;
    await writer;
    expect(res.status).toBe(200);
    expect(failures).toEqual([]);
    expect(written).toBeGreaterThan(5);
    // The restored record, and the writes that came after the swap (at least the last ones).
    const after = await titles();
    expect(after).toContain("Café");
    expect(after).toContain(`w${written - 1}`);
  });

  it("previous data is dropped after 7 days, and a staging schema left by a crash after an hour", async () => {
    const { name } = await backUp();
    expect((await call("POST", `/admin/backups/${name}/restore`)).status).toBe(200);
    const [kept] = await listPreviousData();
    const live = await schemaNow();
    await db.exec(`CREATE SCHEMA "${live}_restore_staging_x"`);
    await db.exec(`COMMENT ON SCHEMA "${live}_restore_staging_x" IS 'vaultbase:${JSON.stringify({ kind: "staging", schema: live, at: Math.floor(Date.now() / 1000) - 7200 })}'`);
    const now = Math.floor(Date.now() / 1000);
    expect(await dropExpiredRestoreSchemas(now + 6 * 86_400)).toEqual([`${live}_restore_staging_x`]);
    expect(await dropExpiredRestoreSchemas(now + 8 * 86_400)).toEqual([kept!.schema]);
    expect(await notedSchemas()).toEqual([]);
  });

  it("one restore at a time: another here, or another server migrating or restoring, answers 409", async () => {
    const { name } = await backUp();
    const [a, b] = await Promise.all([
      call("POST", `/admin/backups/${name}/restore`),
      call("POST", `/admin/backups/${name}/restore`),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);

    // Another server holding the migration lock (booting, or restoring).
    const schema = await schemaNow();
    const other = new SQL(PG, { max: 1 });
    const conn = await other.reserve();
    try {
      await conn.unsafe(`SELECT pg_advisory_lock(hashtext('vaultbase:migrate:' || '${schema}'))`);
      const busy = await call("POST", `/admin/backups/${name}/restore?progress=1`);
      expect(busy.status).toBe(200);
      expect(JSON.parse(busy.text.trim().split("\n").at(-1)!)).toMatchObject({ code: 409, error: expect.stringMatching(/another server/i) });
    } finally {
      conn.release();
      await other.close();
    }
    expect((await call("POST", `/admin/backups/${name}/restore`)).status).toBe(200);
  });

  it("a failed upload leaves no file behind", async () => {
    const { path } = await backUp();
    const bytes = readFileSync(path);
    const form = new FormData();
    form.append("file", new File([bytes.subarray(0, Math.floor(bytes.length * 0.8))], "cut.dump"));
    expect((await call("POST", "/admin/restore", form)).status).toBe(422);
    expect(require("fs").readdirSync(dir).filter((f: string) => f.startsWith(".restore"))).toEqual([]);
  });

  it("the new routes need an admin", async () => {
    for (const [method, path] of [
      ["GET", "/admin/restores"], ["POST", "/admin/restores/x/undo"], ["DELETE", "/admin/restores/x"],
      ["POST", "/admin/backups/vaultbase-20200101-000000-000.dump/restore"], ["POST", "/admin/restore"],
    ] as const) {
      const res = await app.handle(new Request(`http://localhost${path}`, { method }));
      expect([401, 403]).toContain(res.status);
    }
  });

  it("an archive whose SQL holds a psql command, controls the transaction, or comes from an old pg_restore is refused", async () => {
    const { name } = await backUp();
    await createRecord("posts", { title: "After" });
    const cases: Array<[string, RegExp]> = [
      // A shell command, before the first table.
      [`/^CREATE TABLE/ && !x { print "\\\\! touch /tmp/vb-should-not-exist"; x = 1 } { print }`, /psql command/],
      // Ending the restore's transaction, which would commit the renamed schema.
      [`/^CREATE TABLE/ && !x { print "COMMIT;"; x = 1 } { print }`, /controls the transaction/],
      // An older pg_restore: no \\restrict.
      [`!/^\\\\(un)?restrict / { print }`, /too old/],
    ];
    for (const [awk, why] of cases) {
      const res = await withEditedPgRestore(awk, () => call("POST", `/admin/backups/${name}/restore`));
      expect(res.status).toBe(422);
      expect(res.json.error).toMatch(why);
    }
    expect(existsSync("/tmp/vb-should-not-exist")).toBe(false);
    expect(await titles()).toEqual(["After", "Café"]);
    expect(await notedSchemas()).toEqual([]);
    // Views whose CASE ends on a line of its own (END AS …) restore fine.
    await db.exec(`CREATE VIEW v_kinds AS SELECT CASE WHEN title = 'x' THEN 1\n ELSE 2\n END AS kind FROM vb_posts`);
    const again = await backUp();
    expect((await call("POST", `/admin/backups/${again.name}/restore`)).status).toBe(200);
  });

  it("a psql that fails early on a large archive ends the restore at once (no hang), and the next one runs", async () => {
    await db.exec(`INSERT INTO vb_posts (id, title, created_at, updated_at) SELECT 'bulk' || g, repeat('x', 400), 0, 0 FROM generate_series(1, 15000) g`);
    const { name, path } = await backUp();
    expect(readFileSync(path).length).toBeGreaterThan(0);
    const fake = join(dir, "psql_fails.sh");
    writeFileSync(fake, "#!/bin/sh\nhead -c 1000 > /dev/null\necho 'psql:<stdin>:3: ERROR:  stand-in failure' >&2\nexit 3\n", { mode: 0o755 });
    const before = process.env["VAULTBASE_PSQL"];
    process.env["VAULTBASE_PSQL"] = fake;
    let res: Awaited<ReturnType<typeof call>>;
    try {
      res = await call("POST", `/admin/backups/${name}/restore`);
    } finally {
      if (before === undefined) delete process.env["VAULTBASE_PSQL"]; else process.env["VAULTBASE_PSQL"] = before;
    }
    expect(res.status).toBe(422);
    expect(res.json.error).toMatch(/stand-in failure/);
    expect((await call("POST", `/admin/backups/${name}/restore`)).status).toBe(200);
  }, 60_000);

  it("functions of custom types, range types and aggregates without arguments move both ways", async () => {
    await db.exec(`CREATE TYPE pair AS (a int, b int)`);
    await db.exec(`CREATE FUNCTION pair_sum(p pair) RETURNS int LANGUAGE sql IMMUTABLE AS 'SELECT ($1).a + ($1).b'`);
    await db.exec(`CREATE TYPE floatrange AS RANGE (subtype = float8)`);
    await db.exec(`CREATE AGGREGATE count_all(*) (SFUNC = int8inc, STYPE = int8, INITCOND = '0')`);
    const { name } = await backUp();
    const res = await call("POST", `/admin/backups/${name}/restore`);
    expect(res.json?.error ?? null).toBeNull();
    expect(res.status).toBe(200);
    expect((await db.get<{ n: number }>(`SELECT pair_sum(ROW(1, 2)::pair) AS n`))!.n).toBe(3);
    expect((await db.get<{ ok: boolean }>(`SELECT floatrange(1, 2) @> 1.5::float8 AS ok`))!.ok).toBe(true);
    expect((await db.get<{ n: number }>(`SELECT count_all(*) AS n FROM vb_posts`))!.n).toBe(1);
    const [kept] = await listPreviousData();
    expect((await call("POST", `/admin/restores/${encodeURIComponent(kept!.schema)}/undo`)).status).toBe(200);
    expect((await db.get<{ n: number }>(`SELECT pair_sum(ROW(2, 2)::pair) AS n`))!.n).toBe(4);
  });

  it("an object the swap can't move is refused by name, before anything changes", async () => {
    const { name } = await backUp();
    await db.exec(`CREATE STATISTICS posts_stats ON id, title FROM vb_posts`);
    await createRecord("posts", { title: "After" });
    const res = await call("POST", `/admin/backups/${name}/restore`);
    expect(res.status).toBe(422);
    expect(res.json.error).toMatch(/statistics posts_stats/);
    expect(await titles()).toEqual(["After", "Café"]);
    expect(await notedSchemas()).toEqual([]);
  });

  it("a failure after the swap says the data changed, and keeps the previous data", async () => {
    const { path } = await backUp();
    await createRecord("posts", { title: "After" });
    let err: unknown = null;
    try {
      await restoreArchive(path, "test", dir, { afterSwap: async () => { throw new Error("migration broke"); } });
    } catch (e) { err = e; }
    expect(err).toBeInstanceOf(RestoreSwapped);
    expect((err as Error).message).toMatch(/in place, but bringing it up to date failed: migration broke/);
    const { _resetCollectionCache } = await import("../core/collections.ts");
    _resetCollectionCache();
    expect(await titles()).toEqual(["Café"]);
    expect((await listPreviousData()).length).toBe(1);
  });

  it("refuses with 501 when the client tools are missing", async () => {
    const before = process.env["VAULTBASE_PG_RESTORE"];
    process.env["VAULTBASE_PG_RESTORE"] = "/nonexistent/pg_restore";
    try {
      const { name } = await backUp();
      const res = await call("POST", `/admin/backups/${name}/restore`);
      expect(res.status).toBe(501);
      expect(res.json.error).toMatch(/pg_restore and psql/);
      expect((await call("GET", "/admin/restores")).json.data.can_restore).toBe(false);
    } finally {
      if (before === undefined) delete process.env["VAULTBASE_PG_RESTORE"]; else process.env["VAULTBASE_PG_RESTORE"] = before;
    }
  });
});

describe.skipIf(!canRestore)("restore on Postgres: another install's backup", () => {
  afterEach(async () => {
    await closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it("restores a backup taken in another schema", async () => {
    await setUp();
    const { path } = await backUp();
    const archive = join(dir, "other.dump");
    copyFileSync(path, archive);
    await closeDb(); // drops that schema
    await initDb(":memory:");
    await runMigrations();
    await getDb().insert(admin).values({ id: "a1", email: "ops@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
    const form = new FormData();
    form.append("file", new File([readFileSync(archive)], "other.dump"));
    const res = await call("POST", "/admin/restore", form);
    expect(res.status).toBe(200);
    expect(await titles()).toEqual(["Café"]);
  });
});

describe.skipIf(!canRestore)("restore on Postgres: other servers", () => {
  beforeEach(async () => {
    await setUp();
    await import("../core/peer-handlers.ts");
    await startPeers(getDriver() as unknown as Parameters<typeof startPeers>[0]);
  });
  afterEach(async () => {
    await stopPeers();
    await closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a second server serves the restored data and carries on writing", async () => {
    const { name } = await backUp();
    await createRecord("posts", { title: "After" });
    await createPublicCollection({ name: "later", fields: JSON.stringify([{ name: "title", type: "text" }]) });

    // The other server: its own process, caches and peer connection.
    const src = resolve(import.meta.dir, "..");
    const script = `
      const { initDb } = await import(${JSON.stringify(`${src}/db/client.ts`)});
      const { getDriver } = await import(${JSON.stringify(`${src}/db/index.ts`)});
      const { getCollection } = await import(${JSON.stringify(`${src}/core/collections.ts`)});
      const { listRecords, createRecord } = await import(${JSON.stringify(`${src}/core/records.ts`)});
      const { loadSettings } = await import(${JSON.stringify(`${src}/api/settings.ts`)});
      await initDb(process.env.URL);
      await loadSettings();
      await import(${JSON.stringify(`${src}/core/peer-handlers.ts`)});
      const { startPeers } = await import(${JSON.stringify(`${src}/core/peers.ts`)});
      await startPeers(getDriver());
      const server = Bun.serve({ port: 0, async fetch(req) {
        const u = new URL(req.url);
        try {
          if (u.pathname === "/state") return Response.json({
            later: !!(await getCollection("later")),
            titles: (await listRecords("posts", { perPage: 100, sort: "title" })).data.map((r) => r.title),
          });
          if (u.pathname === "/write") { await createRecord("posts", { title: u.searchParams.get("t") }); return Response.json({ ok: true }); }
        } catch (e) { return Response.json({ error: String(e && e.message || e) }, { status: 500 }); }
        return new Response("", { status: 404 });
      } });
      console.log(server.port);
    `;
    const other = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe", stderr: "pipe",
      env: { ...process.env, URL: (getDriver() as PostgresDriver).url, VAULTBASE_TEST_DB: "" },
    });
    try {
      const reader = other.stdout.getReader();
      const port = Number(new TextDecoder().decode((await reader.read()).value).trim());
      expect(port).toBeGreaterThan(0);
      const state = async () => (await fetch(`http://127.0.0.1:${port}/state`)).json() as Promise<{ later: boolean; titles: string[] }>;
      expect(await state()).toEqual({ later: true, titles: ["After", "Café"] });

      expect((await call("POST", `/admin/backups/${name}/restore`)).status).toBe(200);
      let s = await state();
      for (let i = 0; i < 50 && (s.later || s.titles.length !== 1); i++) { await Bun.sleep(100); s = await state(); }
      expect(s).toEqual({ later: false, titles: ["Café"] });

      const w = await fetch(`http://127.0.0.1:${port}/write?t=From%20the%20other`);
      expect(w.status).toBe(200);
      expect(await titles()).toEqual(["Café", "From the other"]);
    } finally {
      other.kill();
      await other.exited;
    }
  }, 30_000);

  it("writes wait while another server swaps, and go on once it's done", async () => {
    await _peersIdle();
    const schema = await schemaNow();
    const peer = new SQL(`${PG}${PG.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`, { max: 1 });
    const channel = `vaultbase_${schema}`.slice(0, 63);
    try {
      await peer.notify(channel, JSON.stringify({ from: "other", m: [{ k: "restore:begin", ms: 10_000 }] }));
      await Bun.sleep(150);
      let done = false;
      const write = createRecord("posts", { title: "Held" }).then(() => { done = true; });
      await Bun.sleep(300);
      expect(done).toBe(false);
      await peer.notify(channel, JSON.stringify({ from: "other", m: [{ k: "cache:restored" }] }));
      await write;
      expect(done).toBe(true);
    } finally {
      await peer.close();
    }
  });

  it("a hold the other server keeps renewing lasts; one it stops renewing ends, dropping the caches", async () => {
    await _peersIdle();
    const schema = await schemaNow();
    const peer = new SQL(`${PG}${PG.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`, { max: 1 });
    const channel = `vaultbase_${schema}`.slice(0, 63);
    const begin = () => peer.notify(channel, JSON.stringify({ from: "other", m: [{ k: "restore:begin", ms: 600 }] }));
    try {
      await getCollection("posts"); // cached
      await begin();
      await Bun.sleep(150);
      let done = false;
      const write = createRecord("posts", { title: "Held" }).then(() => { done = true; });
      await Bun.sleep(400);
      await begin(); // renewed before the first 600 ms ran out
      await Bun.sleep(400);
      expect(done).toBe(false);
      // Renewal stops (the other server died): the hold ends, the caches go.
      await db.run(`UPDATE vaultbase_collections SET list_rule = 'id = "x"' WHERE name = 'posts'`);
      await write;
      expect(done).toBe(true);
      await _peersIdle();
      expect((await getCollection("posts"))!.list_rule).toBe('id = "x"');
    } finally {
      await peer.close();
    }
  });
});

describe.skipIf(!canRestore)("restore on Postgres: the public schema", () => {
  it("restores an install in public, its extensions staying where they are", async () => {
    const dbname = `vb_restore_pub_${process.pid}`;
    const base = PG.replace(/\?.*$/, "");
    const adminSql = new SQL(base, { max: 1 });
    try {
      await adminSql.unsafe(`CREATE DATABASE ${dbname}`).simple();
    } catch (e) {
      console.warn(`[pg-restore test] skipped: can't create a database (${(e as Error).message})`);
      await adminSql.close();
      return;
    }
    const url = base.replace(/\/[^/]*$/, `/${dbname}`);
    dir = mkdtempSync(join(tmpdir(), "vb-pgrestore-pub-"));
    try {
      await initDb(url);
      await runMigrations();
      await getDb().insert(admin).values({ id: "a1", email: "ops@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
      setBackupsDir(join(dir, "backups"));
      app = makeBackupPlugin(SECRET, join(dir, "data.db"));
      expect(await schemaNow()).toBe("public");
      await createPublicCollection({ name: "posts", fields: JSON.stringify([{ name: "title", type: "text", options: { searchable: true } }]) });
      await createRecord("posts", { title: "Café" });
      const ext = async () => (await db.get<{ s: string }>(`SELECT n.nspname AS s FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'unaccent'`))?.s ?? null;
      const extBefore = await ext();
      const { name } = await backUp();
      await createRecord("posts", { title: "After" });

      const res = await call("POST", `/admin/backups/${name}/restore`);
      expect(res.status).toBe(200);
      expect(await titles()).toEqual(["Café"]);
      expect(await ext()).toBe(extBefore);
      expect((await listRecords("posts", { search: "cafe" })).totalItems).toBe(1);
      await createRecord("posts", { title: "Über" });
      if (extBefore) expect((await listRecords("posts", { search: "uber" })).totalItems).toBe(1);
      // The schema itself stayed: owner and grants as they were.
      const pub = await db.get<{ acl: string }>(`SELECT nspacl::text AS acl FROM pg_namespace WHERE nspname = 'public'`);
      expect(pub?.acl ?? "").toContain("=U/");
    } finally {
      await closeDb();
      await adminSql.unsafe(`DROP DATABASE IF EXISTS ${dbname} WITH (FORCE)`).simple();
      await adminSql.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe.skipIf(!onSqlite)("restore on SQLite: a Postgres backup", () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "vb-pgrestore-sqlite-"));
    await initDb(":memory:");
    await runMigrations();
    await getDb().insert(admin).values({ id: "a1", email: "ops@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
    app = makeBackupPlugin(SECRET, join(dir, "data.db"));
  });
  afterEach(async () => {
    await closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is refused, saying what it is", async () => {
    const form = new FormData();
    form.append("file", new File(["PGDMP\u0001rest"], "x.dump"));
    const res = await call("POST", "/admin/restore", form);
    expect(res.status).toBe(422);
    expect(res.json.error).toMatch(/Postgres backup, and this server runs on SQLite/);
    expect((await call("GET", "/admin/restores")).status).toBe(404);
  });
});

describe("restore files left in the data directory", () => {
  it("are swept at boot once an hour old", () => {
    const d = mkdtempSync(join(tmpdir(), "vb-sweep-"));
    try {
      for (const f of [".restore-upload-1-2.dump", ".restore-3-4.list", ".restore-upload-5-6.dump", "data.db", ".restore-x.dump"]) writeFileSync(join(d, f), "x");
      const old = new Date(Date.now() - 2 * 3_600_000);
      for (const f of [".restore-upload-1-2.dump", ".restore-3-4.list", "data.db", ".restore-x.dump"]) utimesSync(join(d, f), old, old);
      sweepRestoreFiles(d);
      expect(require("fs").readdirSync(d).sort()).toEqual([".restore-upload-5-6.dump", ".restore-x.dump", "data.db"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
