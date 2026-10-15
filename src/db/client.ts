/**
 * Opening and closing the database. `initDb` builds the driver (SQLite;
 * see sqlite.ts) and installs it behind the facade in index.ts; the
 * drizzle handle and the raw connection are kept for the modules that
 * still use them directly.
 */
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.ts";
import { _setDriver } from "./index.ts";
import { SqliteDriver } from "./sqlite.ts";

export { JOURNAL_SIZE_LIMIT } from "./sqlite.ts";

type DB = ReturnType<typeof drizzle<typeof schema>>;

let _db: DB | null = null;
let _driver: SqliteDriver | null = null;

export function getDb(): DB {
  if (!_db) throw new Error("DB not initialized. Call initDb() first.");
  return _db;
}

/**
 * Underlying `bun:sqlite` Database, for the SQLite-only modules (the
 * checkpointer, file backups, the sandbox, CLI file tools) and for code
 * not yet moved to the facade. Throws if the DB hasn't been initialised.
 */
export function getRawClient(): Database {
  if (!_driver) throw new Error("DB not initialized. Call initDb() first.");
  return _driver.raw;
}

/**
 * Open the database. Accepts:
 *   ":memory:"             — in-memory DB (tests)
 *   "file:./path/data.db"  — file URL (legacy libSQL syntax, parsed)
 *   "./path/data.db"       — direct path
 */
export function initDb(url: string): DB {
  let path = url;
  if (url.startsWith("file:")) path = url.slice(5);
  _driver = new SqliteDriver(path);
  _setDriver(_driver);
  _db = drizzle(_driver.raw, { schema });
  return _db;
}

/** Run before the connection closes (e.g. commit an open write group). */
const beforeClose: Array<() => void> = [];
export function onBeforeCloseDb(fn: () => void): void {
  beforeClose.push(fn);
}

/**
 * Run right after the connection closes, synchronously: modules that cache
 * prepared statements or anything else bound to the connection register
 * here at load time, so nothing can see a reopened database through
 * objects that belong to the old one. This used to go through a lazy
 * import, which cleared the caches a few ticks after the close.
 */
const afterClose: Array<() => void> = [];
export function onCloseDb(fn: () => void): void {
  afterClose.push(fn);
}

export function closeDb(): void {
  if (_driver) for (const fn of beforeClose) { try { fn(); } catch { /* closing anyway */ } }
  _driver?.close();
  _driver = null;
  _db = null;
  _setDriver(null);
  for (const fn of afterClose) { try { fn(); } catch { /* best effort */ } }
}
