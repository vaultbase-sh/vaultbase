/**
 * Opening and closing the database. `initDb` builds the driver for the URL
 * it is given and installs it behind the facade in index.ts; the drizzle
 * handle and, on SQLite, the raw connection are kept for the modules that
 * still use them directly.
 *
 *   ":memory:"                 — in-memory SQLite (tests)
 *   "file:./path/data.db"      — SQLite file (legacy libSQL syntax, parsed)
 *   "./path/data.db"           — SQLite file
 *   "postgres://user:pw@host/db" — Postgres (also "postgresql://")
 *
 * SQLite opens synchronously and `initDb` returns the handle; Postgres
 * opens asynchronously and `initDb` returns a promise. Callers that may
 * see either await the result (awaiting a plain value is free).
 *
 * Test harness: with `VAULTBASE_TEST_DB` set to a Postgres URL, every
 * `initDb(":memory:")` opens a fresh schema on that server instead and
 * `closeDb` drops it, so the whole suite runs against Postgres unchanged.
 */
import type { Database } from "bun:sqlite";
import { drizzle as drizzleSqlite } from "drizzle-orm/bun-sqlite";
import { drizzle as drizzlePg } from "drizzle-orm/bun-sql";
import * as schema from "./schema.ts";
import { _setDriver } from "./index.ts";
import { SqliteDriver } from "./sqlite.ts";
import { PostgresDriver } from "./postgres.ts";
import { pgSchema } from "./pg-schema.ts";
import type { DbDriver, MaybePromise } from "./driver.ts";

export { JOURNAL_SIZE_LIMIT } from "./sqlite.ts";

type DB = ReturnType<typeof drizzleSqlite<typeof schema>>;

let _db: DB | null = null;
let _driver: DbDriver | null = null;
let _sqlite: SqliteDriver | null = null;
/** Drops a test schema after the pool closes. */
let _teardown: (() => Promise<void>) | null = null;
let testSchemaSeq = 0;

export function getDb(): DB {
  if (!_db) throw new Error("DB not initialized. Call initDb() first.");
  return _db;
}

/**
 * Underlying `bun:sqlite` Database, for the SQLite-only modules (the
 * checkpointer, file backups, the sandbox, CLI file tools). Throws if the
 * DB hasn't been initialised, and on any other driver.
 */
export function getRawClient(): Database {
  if (!_driver) throw new Error("DB not initialized. Call initDb() first.");
  if (!_sqlite) throw new Error(`the raw SQLite connection is not available on ${_driver.name}`);
  return _sqlite.raw;
}

export function isPostgresUrl(url: string): boolean {
  return /^postgres(ql)?:\/\//i.test(url);
}

function install(driver: DbDriver, db: DB, sqlite: SqliteDriver | null): DB {
  _driver = driver;
  _sqlite = sqlite;
  _db = db;
  _setDriver(driver);
  return db;
}

export function initDb(url: string): MaybePromise<DB> {
  const testDb = process.env["VAULTBASE_TEST_DB"];
  if (url === ":memory:" && testDb && isPostgresUrl(testDb)) return openTestSchema(testDb);
  if (isPostgresUrl(url)) return openPostgres(url);
  let path = url;
  if (url.startsWith("file:")) path = url.slice(5);
  const driver = new SqliteDriver(path);
  return install(driver, drizzleSqlite(driver.raw, { schema }), driver);
}

async function openPostgres(url: string, teardown: (() => Promise<void>) | null = null): Promise<DB> {
  const driver = new PostgresDriver(url);
  await driver.open();
  _teardown = teardown;
  return install(driver, drizzlePg(driver.drizzleClient, { schema: pgSchema }) as unknown as DB, null);
}

async function openTestSchema(base: string): Promise<DB> {
  const name = `vb_test_${process.pid}_${++testSchemaSeq}`;
  const admin = new PostgresDriver(base, { max: 1 });
  await admin.exec(`CREATE SCHEMA ${name}`);
  admin.close();
  const url = `${base}${base.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${name}`)}`;
  return openPostgres(url, async () => {
    const a = new PostgresDriver(base, { max: 1 });
    try { await a.exec(`DROP SCHEMA ${name} CASCADE`); } finally { a.close(); }
  });
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
 * objects that belong to the old one.
 */
const afterClose: Array<() => void> = [];
export function onCloseDb(fn: () => void): void {
  afterClose.push(fn);
}

/**
 * Writes that callers may not await (`setSetting` updates its value in memory
 * at once and writes the row after). On Postgres, closing waits for them
 * before the pool closes and a test schema is dropped: a write landing after
 * the drop failed with `relation ... does not exist` and, unawaited, surfaced
 * as an unhandled error in whatever ran next.
 */
const pendingWrites = new Set<Promise<unknown>>();
export function trackPendingWrite<T>(p: Promise<T>): Promise<T> {
  pendingWrites.add(p);
  const done = () => { pendingWrites.delete(p); };
  p.then(done, done);
  return p;
}

/**
 * Close the database. Synchronous on SQLite. On Postgres the pool closes in
 * the background, after any tracked writes settle, and the returned promise
 * resolves once a test schema, if any, is dropped; callers that do not await
 * it may open the next database at once.
 */
export function closeDb(): MaybePromise<void> {
  if (_driver) for (const fn of beforeClose) { try { fn(); } catch { /* closing anyway */ } }
  const driver = _driver;
  const teardown = _teardown;
  const waits = [...pendingWrites];
  _driver = null;
  _sqlite = null;
  _db = null;
  _teardown = null;
  _setDriver(null);
  if (waits.length > 0 && driver && driver.name !== "sqlite") {
    for (const fn of afterClose) { try { fn(); } catch { /* best effort */ } }
    return Promise.allSettled(waits).then(() => {
      driver.close();
      if (teardown) return teardown();
    });
  }
  driver?.close();
  for (const fn of afterClose) { try { fn(); } catch { /* best effort */ } }
  if (teardown) return teardown();
}
