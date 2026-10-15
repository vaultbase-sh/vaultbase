/**
 * The SQLite driver: one `bun:sqlite` connection, the pragmas the server
 * has always set, a prepared-statement cache, and today's SQL dialect
 * verbatim (the golden tests in `__tests__/golden-sql.test.ts` hold it to
 * that).
 *
 * Everything here is synchronous: `all`, `get`, `run` and `exec` return
 * plain values, which is what keeps the facade free for the hot path.
 * Transactions run on the shared connection, so statements issued by other
 * requests while one is open join it, exactly as before the facade; the
 * write gate and group commit (core/write-gate.ts, core/group-commit.ts)
 * are what keep that orderly.
 */
import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";
import type { Capabilities, DbDriver, Dialect, RunOptions, RunResult, SyncDb, TimeBucket, TransactionOptions } from "./driver.ts";
import type { ColumnSpec, IndexSpec } from "./ddl.ts";
import { flushTableReports, noteTableWrite } from "../core/table-writes.ts";

/** WAL file cap on disk (bytes); shared with the background checkpointer. */
export const JOURNAL_SIZE_LIMIT = 67_108_864;

/**
 * bun:sqlite re-parses SQL on every `prepare()`, which dominated list
 * latency under load before statements were cached. One statement per
 * unique SQL string, oldest evicted past the cap, all dropped on DDL that
 * changes a table's shape ({@link SqliteDriver.invalidateStatements}).
 */
const STMT_CACHE_MAX = 256;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function columnDef(c: ColumnSpec): string {
  let out = `${c.name} ${c.type.toUpperCase()}`;
  if (c.primaryKey) out += " PRIMARY KEY";
  else if (c.notNull) out += " NOT NULL";
  if (c.unique) out += " UNIQUE";
  if (c.default?.kind === "epochNow") out += " DEFAULT (unixepoch())";
  else if (c.default?.kind === "literal") out += ` DEFAULT ${typeof c.default.value === "number" ? String(c.default.value) : `'${c.default.value.replace(/'/g, "''")}'`}`;
  return out;
}

export const SQLITE_DIALECT: Dialect = {
  name: "sqlite",
  epochNow: "unixepoch()",
  always: "1",
  never: "1=0",
  tieBreak: "rowid",
  columnType(fieldType) {
    switch (fieldType) {
      case "number": return "REAL";
      case "bool": return "INTEGER";
      case "date":
      case "autodate": return "INTEGER";
      default: return "TEXT";
    }
  },
  quoteIdent,
  like: (left, pattern) => `coalesce(${left} LIKE ${pattern}, 0)`,
  jsonExtract: (expr, path) => `json_extract(${expr}, '${path}')`,
  jsonArrayLength: (expr) => `json_array_length(${expr})`,
  jsonEach: (expr) => `json_each(${expr})`,
  jsonGroupArray: (expr) => `json_group_array(${expr})`,
  createTable: (name, columns) => `CREATE TABLE IF NOT EXISTS ${name} (\n  ${columns.map(columnDef).join(",\n  ")}\n)`,
  addColumn: (table, column) => {
    if (column.unique) throw new Error(`${table}.${column.name}: SQLite cannot add a UNIQUE column; add an index`);
    return `ALTER TABLE ${table} ADD COLUMN ${columnDef(column)}`;
  },
  createIndex: (ix: IndexSpec) => `CREATE ${ix.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${ix.name} ON ${ix.table}(${ix.columns.join(", ")})${ix.where ? ` WHERE ${ix.where}` : ""}`,
  listColumnsSql: (table) => `SELECT name FROM pragma_table_info('${table.replace(/'/g, "''")}')`,
  createView: (name, body) => `CREATE VIEW IF NOT EXISTS ${name} AS ${body}`,
  indexExistsSql: () => `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`,
  listIndexesSql: () => `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`,
  // SQLite keeps an index's name through a table rename; recreate it under the new one.
  renameIndex: (name, newName, sql) => [`DROP INDEX ${quoteIdent(name)}`, sql.replace(name, newName)],
  timeBucket: (format, expr) => `strftime('${SQLITE_BUCKET[format]}', ${expr}, 'unixepoch')`,
  isUniqueViolation: (e, column) =>
    e instanceof Error && /UNIQUE constraint failed/i.test(e.message) && (!column || e.message.includes(`.${column}`)),
};

const SQLITE_BUCKET: Record<TimeBucket, string> = {
  hour: "%Y-%m-%dT%H:00",
  day: "%Y-%m-%d",
  week: "%Y-W%W",
  month: "%Y-%m",
  year: "%Y",
};

export const SQLITE_CAPABILITIES: Capabilities = {
  fileBackups: true,
  sandbox: true,
  checkpointer: true,
  readWorkerThreads: true,
  foreignCommitProbe: true,
  explain: "sqlite",
  fts: "fts5",
  statementAtomicity: true,
};

type AnyStatement = Statement<unknown, SQLQueryBindings[]>;

export class SqliteDriver implements DbDriver {
  readonly name = "sqlite" as const;
  readonly dialect = SQLITE_DIALECT;
  readonly capabilities = SQLITE_CAPABILITIES;
  readonly sync: SyncDb;
  /** The connection, for the SQLite-only modules (checkpointer, backups, sandbox, CLI). */
  readonly raw: Database;

  private readonly statements = new Map<string, AnyStatement>();
  private readonly changesProbe: AnyStatement;
  private readonly schemaProbe: AnyStatement;
  private traceFn: ((sql: string) => void) | null = null;
  private savepointSeq = 0;

  /**
   * `path` is a file path or `:memory:`. The pragmas are the ones the
   * server has always set; CLI paths that never start the checkpointer
   * keep the inline autocheckpoint.
   */
  constructor(path: string) {
    const raw = new Database(path, { create: true });
    this.raw = raw;
    const isMemory = path === ":memory:";
    // Wait up to 5 s for a lock instead of failing at once. Set first: the
    // WAL switch below needs a lock, and with several processes opening the
    // database together (a CLI next to the server) it used to fail with
    // SQLITE_BUSY before any timeout applied.
    raw.exec("PRAGMA busy_timeout = 5000;");
    if (!isMemory) {
      // WAL: concurrent readers + single writer.
      raw.exec("PRAGMA journal_mode = WAL;");
      // WAL-recommended; crash-safe, much faster than FULL.
      raw.exec("PRAGMA synchronous = NORMAL;");
      // 256 MB OS file mapping, faster than read() syscalls. Meaningless on
      // `:memory:` (and SQLITE_NOMEM there).
      raw.exec("PRAGMA mmap_size = 268435456;");
      // Inline autocheckpoint until the background checkpointer takes over
      // (db/checkpointer.ts switches this to 0 once its worker is up, and
      // back if the worker dies).
      raw.exec("PRAGMA wal_autocheckpoint = 10000;");
      // Cap the WAL file at 64 MB on disk: a sustained-write workload could
      // balloon it to gigabytes before the next checkpoint truncated it.
      // Advisory (SQLite shrinks the file at the next checkpoint); never
      // blocks a write.
      raw.exec(`PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT};`);
    }
    // 32 MB page cache (negative = KiB).
    raw.exec("PRAGMA cache_size = -32000;");
    raw.exec("PRAGMA temp_store = MEMORY;");
    // Better PRAGMA optimize plans on skewed tables (audit log, history)
    // without crossing into seconds of boot time.
    try { raw.exec("PRAGMA analysis_limit = 400;"); } catch { /* noop */ }
    try { raw.exec("PRAGMA optimize;"); } catch { /* noop */ }

    this.changesProbe = raw.prepare("SELECT total_changes() AS t");
    this.schemaProbe = raw.prepare("PRAGMA schema_version");
    const self = this;
    this.sync = {
      all: (sql, params) => self.all(sql, params),
      get: (sql, params) => self.get(sql, params),
      run: (sql, params, opts) => self.run(sql, params, opts),
      exec: (sql) => self.exec(sql),
      describe: (sql) => self.describe(sql),
      get inTransaction() { return self.raw.inTransaction; },
      transaction: (fn, opts) => self.transactionSync(fn, opts),
    };
  }

  get inTransaction(): boolean {
    return this.raw.inTransaction;
  }

  private prepare(sql: string): AnyStatement {
    const hit = this.statements.get(sql);
    if (hit) return hit;
    if (this.statements.size >= STMT_CACHE_MAX) {
      const oldest = this.statements.keys().next().value;
      if (oldest !== undefined) this.statements.delete(oldest);
    }
    const stmt = this.raw.prepare(sql) as AnyStatement;
    this.statements.set(sql, stmt);
    return stmt;
  }

  all<T = Record<string, unknown>>(sql: string, params: ReadonlyArray<unknown> = []): T[] {
    this.traceFn?.(sql);
    return this.prepare(sql).all(...(params as SQLQueryBindings[])) as T[];
  }

  get<T = Record<string, unknown>>(sql: string, params: ReadonlyArray<unknown> = []): T | null {
    this.traceFn?.(sql);
    return (this.prepare(sql).get(...(params as SQLQueryBindings[])) ?? null) as T | null;
  }

  /**
   * `trackedChanges` is measured (the `total_changes()` difference around
   * the statement, trigger rows included) only when `opts.table` asks for
   * the write to be reported; otherwise it equals `changes`.
   */
  run(sql: string, params: ReadonlyArray<unknown> = [], opts?: RunOptions): RunResult {
    this.traceFn?.(sql);
    const table = opts?.table;
    const before = table ? this.totalChanges() : 0;
    const r = this.prepare(sql).run(...(params as SQLQueryBindings[]));
    const tracked = table ? this.totalChanges() - before : r.changes;
    if (table) {
      noteTableWrite(table, tracked);
      // Autocommit: the rows are visible now. Inside a transaction the
      // commit site flushes (group commit, batch, cascading delete).
      if (!this.raw.inTransaction) flushTableReports();
    }
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid, trackedChanges: tracked };
  }

  exec(sql: string): void {
    this.traceFn?.(sql);
    this.raw.exec(sql);
  }

  describe(sql: string): string[] {
    this.traceFn?.(sql);
    return [...this.prepare(sql).columnNames];
  }

  schemaToken(): number {
    this.traceFn?.("PRAGMA schema_version");
    return (this.schemaProbe.get() as { schema_version: number }).schema_version;
  }

  private totalChanges(): number {
    return (this.changesProbe.get() as { t: number }).t;
  }

  async transaction<T>(fn: () => Promise<T>, opts?: TransactionOptions): Promise<T> {
    if (this.raw.inTransaction) return this.savepoint(fn);
    this.exec(opts?.immediate === false ? "BEGIN" : "BEGIN IMMEDIATE");
    try {
      const out = await fn();
      this.exec("COMMIT");
      return out;
    } catch (e) {
      // A statement that failed because the connection was closed, or a
      // COMMIT that failed, may have ended the transaction already.
      if (this.raw.inTransaction) { try { this.exec("ROLLBACK"); } catch { /* closed */ } }
      throw e;
    }
  }

  private transactionSync<T>(fn: () => T, opts?: TransactionOptions): T {
    if (this.raw.inTransaction) {
      const name = `vb_sp_${++this.savepointSeq}`;
      this.exec(`SAVEPOINT ${name}`);
      try {
        const out = fn();
        this.exec(`RELEASE ${name}`);
        return out;
      } catch (e) {
        this.exec(`ROLLBACK TO ${name}`);
        this.exec(`RELEASE ${name}`);
        throw e;
      }
    }
    this.exec(opts?.immediate === false ? "BEGIN" : "BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.exec("COMMIT");
      return out;
    } catch (e) {
      if (this.raw.inTransaction) { try { this.exec("ROLLBACK"); } catch { /* closed */ } }
      throw e;
    }
  }

  async savepoint<T>(fn: () => Promise<T>): Promise<T> {
    const name = `vb_sp_${++this.savepointSeq}`;
    this.exec(`SAVEPOINT ${name}`);
    try {
      const out = await fn();
      this.exec(`RELEASE ${name}`);
      return out;
    } catch (e) {
      this.exec(`ROLLBACK TO ${name}`);
      this.exec(`RELEASE ${name}`);
      throw e;
    }
  }

  trace(fn: ((sql: string) => void) | null): void {
    this.traceFn = fn;
  }

  preparedStatementCount(): number {
    return this.statements.size;
  }

  invalidateStatements(): void {
    this.statements.clear();
  }

  close(): void {
    this.statements.clear();
    this.raw.close();
  }
}
