/**
 * The database facade. `db` delegates every call to the driver opened by
 * `initDb` (client.ts), so modules import one object and never hold a
 * connection that `closeDb` could leave dangling (tests open and close the
 * database hundreds of times; restore reopens it in place).
 *
 *   import { db } from "../db/index.ts";
 *   const rows = await db.all<Row>(`SELECT ...`, [a, b]);
 *   await db.transaction(async () => { ... });
 *   db.sync.get(...)           // SQLite only; see driver.ts on `sync`
 *   db.dialect.epochNow        // SQL fragments that differ per database
 *   if (db.capabilities.fts !== "none") ...
 */
import type { DbDriver, SyncDb } from "./driver.ts";

let current: DbDriver | null = null;

/** Install the driver `initDb` opened, or `null` when it closes. */
export function _setDriver(driver: DbDriver | null): void {
  current = driver;
}

/** Whether a driver is open (caches that clear on close check before calling the driver). */
export function driverOpen(): boolean {
  return current !== null;
}

/** The open driver; throws before `initDb` and after `closeDb`. */
export function getDriver(): DbDriver {
  if (!current) throw new Error("DB not initialized. Call initDb() first.");
  return current;
}

const sync: SyncDb = {
  all: (sql, params) => getDriver().sync.all(sql, params),
  get: (sql, params) => getDriver().sync.get(sql, params),
  run: (sql, params, opts) => getDriver().sync.run(sql, params, opts),
  exec: (sql) => getDriver().sync.exec(sql),
  describe: (sql) => getDriver().sync.describe(sql),
  get inTransaction() { return getDriver().sync.inTransaction; },
  transaction: (fn, opts) => getDriver().sync.transaction(fn, opts),
};

export const db: DbDriver = {
  get name() { return getDriver().name; },
  get dialect() { return getDriver().dialect; },
  get capabilities() { return getDriver().capabilities; },
  get inTransaction() { return getDriver().inTransaction; },
  sync,
  all: (sql, params) => getDriver().all(sql, params),
  get: (sql, params) => getDriver().get(sql, params),
  run: (sql, params, opts) => getDriver().run(sql, params, opts),
  exec: (sql) => getDriver().exec(sql),
  describe: (sql) => getDriver().describe(sql),
  schemaToken: () => getDriver().schemaToken(),
  transaction: (fn, opts) => getDriver().transaction(fn, opts),
  savepoint: (fn) => getDriver().savepoint(fn),
  trace: (fn) => getDriver().trace(fn),
  preparedStatementCount: () => getDriver().preparedStatementCount(),
  invalidateStatements: () => getDriver().invalidateStatements(),
  close: () => getDriver().close(),
};

export type { Capabilities, DbDriver, Dialect, MaybePromise, RunOptions, RunResult, SyncDb, TransactionOptions } from "./driver.ts";
