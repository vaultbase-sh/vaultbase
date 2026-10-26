/**
 * The database an install runs on is chosen at install and is final: the
 * data directory records it in `database.json`, and the server refuses to
 * start on another one. Without this a forgotten VAULTBASE_DATABASE_URL
 * started an empty SQLite server with the setup wizard open, and a URL
 * pointing at the wrong database ran migrations into it.
 *
 * What identifies the install is an id kept in the database itself
 * (`vaultbase_install`), so a database moved to another host or provider
 * (a restored copy) is still recognised; the location in the marker is
 * there for the error message. The marker is written once the install has
 * an admin: before that, switching databases loses nothing, and the setup
 * wizard says how. It needs a data directory that persists: one that starts
 * empty every time (some container platforms) has nothing to compare with.
 *
 *   1. checkDataDir: before the database is opened. The driver must match
 *      the marker's, and a SQLite file the marker expects must exist (a
 *      refused start leaves no empty database file behind).
 *   2. checkInstallId: opened, before migrations. The database (its current
 *      schema, on Postgres) must carry the marker's install id. With no
 *      marker yet, a Postgres database without an admin isn't started next
 *      to a SQLite database that has one.
 *   3. recordInstall: after migrations, after the first admin is made, and
 *      after a restore. Gives the database its id and writes the marker.
 *
 * VAULTBASE_DATABASE_MOVED=<value> starts the server on a database the
 * marker doesn't name, and the marker follows: another install's database,
 * by that database's install id, or a copy made before ids existed, by a
 * code from where that copy is and its first admin (`adopt-…`). The refusal prints the exact
 * value. Each names one database, so left set it lets no other through. It
 * never accepts the other driver or an empty database.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { db } from "../db/index.ts";
import { initDb, isPostgresUrl } from "../db/client.ts";

export const MARKER_FILE = "database.json";

type Driver = "sqlite" | "postgres";

/** Where the database is, without credentials: for messages. */
interface Location {
  path?: string;
  host?: string;
  port?: number;
  database?: string;
  schema?: string;
}

interface Marker {
  database: Driver;
  install_id: string;
  location: Location;
  written_at: string;
}

export class InstallMismatchError extends Error {}

const movedTo = () => process.env["VAULTBASE_DATABASE_MOVED"]?.trim() || null;

function readMarker(dataDir: string): Marker | null {
  const path = join(dataDir, MARKER_FILE);
  if (!existsSync(path)) return null;
  let m: Partial<Marker>;
  try {
    m = JSON.parse(readFileSync(path, "utf8")) as Partial<Marker>;
  } catch (e) {
    throw new InstallMismatchError(`${path} can't be read (${e instanceof Error ? e.message : e}). It records which database this install runs on; fix or remove it.`);
  }
  if ((m.database !== "sqlite" && m.database !== "postgres") || typeof m.install_id !== "string" || !m.install_id) {
    throw new InstallMismatchError(`${path} isn't a database record this version understands. Fix or remove it.`);
  }
  return { database: m.database, install_id: m.install_id, location: m.location ?? {}, written_at: m.written_at ?? "" };
}

function describe(driver: Driver, loc: Location): string {
  if (driver === "sqlite") return `SQLite${loc.path ? ` (${loc.path})` : ""}`;
  const where = [loc.host && `${loc.host}${loc.port ? `:${loc.port}` : ""}`, loc.database && `database ${loc.database}`, loc.schema && `schema ${loc.schema}`]
    .filter(Boolean).join(", ");
  return `Postgres${where ? ` (${where})` : ""}`;
}

const FINAL = "The database is chosen at install and can't be changed; to start a new install, use another data directory.";

/** The file a SQLite URL opens. */
function sqlitePath(url: string): string {
  return url.startsWith("file:") ? url.slice(5) : url;
}

/** Step 1, before the database is opened. */
export function checkDataDir(dataDir: string, driver: Driver, url?: string): void {
  const marker = readMarker(dataDir);
  if (!marker) return;
  if (marker.database !== driver) {
    const was = describe(marker.database, marker.location);
    const fix = marker.database === "postgres"
      ? "Set VAULTBASE_DATABASE_URL to that database."
      : "Unset VAULTBASE_DATABASE_URL.";
    throw new InstallMismatchError(
      `this data directory (${resolve(dataDir)}) belongs to an install on ${was}, ` +
      `but the server is configured for ${driver === "sqlite" ? "SQLite (VAULTBASE_DATABASE_URL isn't set)" : "Postgres"}. ${fix} ${FINAL}`,
    );
  }
  if (driver === "sqlite" && url !== undefined && !existsSync(sqlitePath(url))) {
    const path = resolve(sqlitePath(url));
    throw new InstallMismatchError(path === marker.location.path
      ? `this install's database file, ${path}, is missing. Restore it from a backup; to start a new install here ` +
        `instead, remove ${MARKER_FILE} from the data directory (or run \`vaultbase wipe\`).`
      : `the database the server is configured for, ${path}, doesn't exist, and this data directory's install runs on ` +
        `${describe(marker.database, marker.location)}. Check VAULTBASE_DATABASE_URL. ${FINAL}`,
    );
  }
}

function sqliteHasAdmin(path: string): boolean {
  if (!existsSync(path)) return false;
  let d: Database | null = null;
  try {
    d = new Database(path, { readonly: true });
    return !!d.prepare(`SELECT 1 FROM vaultbase_admin LIMIT 1`).get();
  } catch {
    return false; // not a database, or no admin table: not an install
  } finally {
    try { d?.close(); } catch { /* ignore */ }
  }
}

/** Whether the open database (its current schema) has `table`. */
async function hasTable(table: string): Promise<boolean> {
  return (await db.all(db.dialect.listColumnsSql(table))).length > 0;
}

/**
 * The id the open database carries, or null. From the current schema only:
 * an unqualified name on Postgres would find the table in any schema on the
 * search path, while migrations write to the first.
 */
async function installId(): Promise<string | null> {
  if (!(await hasTable("vaultbase_install"))) return null;
  return (await db.get<{ id: string }>(`SELECT id FROM vaultbase_install WHERE key = 'install'`))?.id ?? null;
}

async function hasAdmin(): Promise<boolean> {
  return (await hasTable("vaultbase_admin")) && !!(await db.get(`SELECT 1 FROM vaultbase_admin LIMIT 1`));
}

/** An id to give the database at recordInstall instead of a new one (a copy made before ids). */
let adopt: string | null = null;

/** Step 2: opened, before migrations. */
export async function checkInstallId(dataDir: string): Promise<void> {
  adopt = null;
  const marker = readMarker(dataDir);
  if (!marker) {
    // No record yet (an install from before 0.29, or not set up). A SQLite
    // database here with an admin is an install, unless this Postgres one is
    // too (a SQLite trial left behind when the install moved, before 0.29).
    if (db.name === "postgres" && sqliteHasAdmin(join(dataDir, "data.db")) && !(await hasAdmin())) {
      throw new InstallMismatchError(
        `this data directory (${resolve(dataDir)}) holds a SQLite install (data.db, with an admin), ` +
        `and the Postgres database the server is configured for has no admin. Unset VAULTBASE_DATABASE_URL to start the SQLite install. ` +
        `If this install runs on that Postgres database and data.db is left over, check the URL, then move data.db aside. ${FINAL}`,
      );
    }
    return;
  }
  const id = await installId();
  const value = movedTo();
  if (id === marker.install_id) {
    if (value) process.stderr.write(`vaultbase: VAULTBASE_DATABASE_MOVED is set but not needed; remove it.\n`);
    return;
  }
  const loc = await location();
  const here = describe(marker.database, loc);
  const was = describe(marker.database, marker.location);
  const head = `the database the server is configured for, ${here}, isn't the one this data directory's install runs on, ${was}:`;
  if (!(await hasTable("vaultbase_collections"))) {
    throw new InstallMismatchError(
      `${head} it is empty. Check VAULTBASE_DATABASE_URL. ${FINAL}`,
    );
  }
  // Another install's database, by its id; a copy made before ids, by where
  // it is and its first admin, so a value left set can't adopt another.
  const accepts = id ?? `adopt-${await copyCode(loc)}`;
  if (value === accepts) {
    if (id === null) adopt = marker.install_id;
    process.stderr.write(`vaultbase: VAULTBASE_DATABASE_MOVED: this install now runs on ${here}. Remove the variable once it has started.\n`);
    return;
  }
  throw new InstallMismatchError(
    `${head} ${id === null ? "it has no install id (a copy made before 0.29.0?)" : `it belongs to another install (${id})`}. ` +
    `If this install moved to it, start once with VAULTBASE_DATABASE_MOVED=${accepts}.` +
    (value ? ` (VAULTBASE_DATABASE_MOVED is set to ${value}, which isn't that.)` : ""),
  );
}

/** Names an id-less copy: where it is, and its first admin (ids are unique per install). */
async function copyCode(loc: Location): Promise<string> {
  const first = (await hasTable("vaultbase_admin"))
    ? (await db.get<{ id: string }>(`SELECT id FROM vaultbase_admin ORDER BY created_at, id LIMIT 1`))?.id ?? ""
    : "";
  return createHash("sha256").update(JSON.stringify([loc, first])).digest("hex").slice(0, 12);
}

/** Where the open database is, for the marker and messages. */
async function location(): Promise<Location> {
  if (db.name === "sqlite") {
    const row = await db.get<{ file: string }>(`SELECT file FROM pragma_database_list WHERE name = 'main'`);
    return row?.file ? { path: row.file } : {};
  }
  const row = await db.get<{ d: string; s: string | null }>(`SELECT current_database() AS d, current_schema() AS s`);
  const loc: Location = { ...(row?.d ? { database: row.d } : {}), ...(row?.s ? { schema: row.s } : {}) };
  const url = process.env["VAULTBASE_DATABASE_URL"] ?? "";
  try {
    const u = new URL(url);
    const host = u.searchParams.get("host") || decodeURIComponent(u.hostname);
    if (host) loc.host = host;
    loc.port = Number(u.searchParams.get("port") || u.port || 5432);
  } catch { /* an unusual URL: the database name is enough */ }
  return loc;
}

/**
 * Open the configured database for the server or a command, checked to be
 * this data directory's install (steps 1 and 2). Throws
 * InstallMismatchError, with the fix in its message.
 */
export async function openInstallDatabase(dataDir: string, url: string): Promise<void> {
  checkDataDir(dataDir, isPostgresUrl(url) ? "postgres" : "sqlite", url);
  await initDb(url);
  await checkInstallId(dataDir);
}

/** For a command's catch: the line to print for a refused start, or null. */
export function refusal(e: unknown, command = "vaultbase"): string | null {
  return e instanceof InstallMismatchError ? `${command}: ${e.message}\n` : null;
}

let recordTo: string | null = null;

/** Where recordInstall writes; set by the server at boot. Unset (tests, CLIs), it does nothing. */
export function configureInstallRecord(dataDir: string | null): void {
  recordTo = dataDir;
}

/**
 * Step 3: give the database its install id, and write the marker once the
 * install has an admin, or whenever there is one already (a restore must
 * move it, admin or not). Failing to write the file is a warning, not a stop.
 */
export async function recordInstall(): Promise<void> {
  if (!recordTo) return;
  await db.run(
    `INSERT INTO vaultbase_install (key, id) VALUES ('install', ?) ON CONFLICT (key) DO NOTHING`,
    [adopt ?? crypto.randomUUID()],
  );
  adopt = null;
  const id = await installId();
  if (!id) return;
  const path = join(recordTo, MARKER_FILE);
  if (!existsSync(path) && !(await hasAdmin())) return;
  const marker: Marker = { database: db.name, install_id: id, location: await location(), written_at: new Date().toISOString() };
  try {
    const prev = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Marker : null;
    if (prev && prev.database === marker.database && prev.install_id === marker.install_id
      && JSON.stringify(prev.location) === JSON.stringify(marker.location)) return;
  } catch { /* unreadable: rewrite it */ }
  // A temp file of its own: several processes (cluster workers, servers
  // sharing the directory) may write at once, and a shared one tore.
  const tmp = `${path}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(marker, null, 2) + "\n");
    renameSync(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
    process.stderr.write(`vaultbase: couldn't write ${path} (${e instanceof Error ? e.message : e}); the database this install runs on isn't recorded\n`);
  }
}
