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
import { AsyncLocalStorage } from "node:async_hooks";
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
const EXPLAIN_RE = /^\s*EXPLAIN\b/i;
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
  else if (c.default?.kind === "epochMsNow") out += " DEFAULT (unixepoch('subsec') * 1000)";
  else if (c.default?.kind === "literal") out += ` DEFAULT ${typeof c.default.value === "number" ? String(c.default.value) : `'${c.default.value.replace(/'/g, "''")}'`}`;
  return out;
}

export const SQLITE_DIALECT: Dialect = {
  name: "sqlite",
  epochNow: "unixepoch()",
  always: "1",
  never: "1=0",
  tieBreak: "rowid",
  indexTail: [],
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
  asText: (expr) => expr,
  addColumnExpressionDefault: false,
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
  isMissingTable: (e) => e instanceof Error && /no such table/i.test(e.message),
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

/** Statements that change the schema, after which the token memo must not be reused. */
const DDL_RE = /^\s*(CREATE|ALTER|DROP)\b/i;

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
  /** The schema token read this event-loop turn; see schemaToken(). */
  private tokenThisTurn: number | null = null;

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
      run: (sql, params, opts) => self.runNow(sql, params, opts),
      exec: (sql) => self.execNow(sql),
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
    if (EXPLAIN_RE.test(sql)) {
      // EXPLAIN QUERY PLAN over an FTS5 MATCH stays "in progress" after its
      // last row; cached, it would block VACUUM INTO (backups) until restart.
      // Plans are rare: prepare one, read it, finalize it.
      const stmt = this.raw.prepare(sql);
      try {
        return stmt.all(...(params as SQLQueryBindings[])) as T[];
      } finally {
        stmt.finalize();
      }
    }
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
  /**
   * Writes wait while another async context's transaction is open (see
   * `own`), then run synchronously; with no transaction open elsewhere they
   * run at once.
   */
  run(sql: string, params: ReadonlyArray<unknown> = [], opts?: RunOptions): RunResult | Promise<RunResult> {
    return this.foreignTx() ? this.afterForeignTx(() => this.runNow(sql, params, opts)) : this.runNow(sql, params, opts);
  }

  exec(sql: string): void | Promise<void> {
    return this.foreignTx() ? this.afterForeignTx(() => this.execNow(sql)) : this.execNow(sql);
  }

  private runNow(sql: string, params: ReadonlyArray<unknown> = [], opts?: RunOptions): RunResult {
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

  private execNow(sql: string): void {
    this.traceFn?.(sql);
    this.raw.exec(sql);
    if (DDL_RE.test(sql)) this.tokenThisTurn = null;
  }

  describe(sql: string): string[] {
    this.traceFn?.(sql);
    return [...this.prepare(sql).columnNames];
  }

  /**
   * `schema_version`, read once per event-loop turn: the caches keyed on it
   * ask several times per request, and a change made by another connection
   * is seen on the next turn, which is soon enough. This connection's own
   * DDL clears the memo at once (see exec).
   */
  schemaToken(): number {
    if (this.tokenThisTurn !== null) return this.tokenThisTurn;
    this.traceFn?.("PRAGMA schema_version");
    const token = (this.schemaProbe.get() as { schema_version: number }).schema_version;
    this.tokenThisTurn = token;
    setImmediate(() => { this.tokenThisTurn = null; });
    return token;
  }

  private totalChanges(): number {
    return (this.changesProbe.get() as { t: number }).t;
  }

  /**
   * The one connection is shared by every request, and `fn` awaits between
   * its statements; while it runs, this context owns the connection's
   * transaction and writes from other contexts wait for it (`own`), so none
   * lands inside it to be lost with its rollback, or committed by it.
   * Nested in the owner's own context: a savepoint. Inside the open write
   * group (a hook of a record write): a savepoint that keeps the group from
   * committing until it ends.
   */
  async transaction<T>(fn: () => Promise<T>, opts?: TransactionOptions): Promise<T> {
    if (this.owner && this.ownerAls.getStore() === this.owner.id) return this.savepoint(fn);
    while (this.foreignTx()) await this.owner!.done;
    if (this.raw.inTransaction) return this.own(() => this.savepoint(fn), true);
    return this.own(async () => {
      this.execNow(opts?.immediate === false ? "BEGIN" : "BEGIN IMMEDIATE");
      try {
        const out = await fn();
        this.execNow("COMMIT");
        return out;
      } catch (e) {
        // A statement that failed because the connection was closed, or a
        // COMMIT that failed, may have ended the transaction already.
        if (this.raw.inTransaction) { try { this.execNow("ROLLBACK"); } catch { /* closed */ } }
        throw e;
      }
    }, false);
  }

  /** Whether a savepoint owns the open write group, which must not commit under it. */
  get holdsWriteGroup(): boolean {
    return this.owner?.inGroup === true;
  }

  /** Called when a savepoint that held the write group ends (group-commit flushes then). */
  onGroupReleased: (() => void) | null = null;

  private owner: { id: object; done: Promise<void>; inGroup: boolean } | null = null;
  private readonly ownerAls = new AsyncLocalStorage<object>();

  /** Whether another async context's transaction is open. */
  private foreignTx(): boolean {
    return this.owner !== null && this.ownerAls.getStore() !== this.owner.id;
  }

  private async afterForeignTx<T>(fn: () => T): Promise<T> {
    while (this.foreignTx()) await this.owner!.done;
    return fn();
  }

  private async own<T>(body: () => Promise<T>, inGroup: boolean): Promise<T> {
    let release!: () => void;
    const id = {};
    this.owner = { id, done: new Promise<void>((r) => { release = r; }), inGroup };
    try {
      return await this.ownerAls.run(id, body);
    } finally {
      this.owner = null;
      // Commit a group that wanted to commit while held, before any waiter
      // resumes and finds it still open.
      if (inGroup) this.onGroupReleased?.();
      release();
    }
  }

  private transactionSync<T>(fn: () => T, opts?: TransactionOptions): T {
    if (this.raw.inTransaction) {
      const name = `vb_sp_${++this.savepointSeq}`;
      this.execNow(`SAVEPOINT ${name}`);
      try {
        const out = fn();
        this.execNow(`RELEASE ${name}`);
        return out;
      } catch (e) {
        this.execNow(`ROLLBACK TO ${name}`);
        this.execNow(`RELEASE ${name}`);
        throw e;
      }
    }
    this.execNow(opts?.immediate === false ? "BEGIN" : "BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.execNow("COMMIT");
      return out;
    } catch (e) {
      if (this.raw.inTransaction) { try { this.execNow("ROLLBACK"); } catch { /* closed */ } }
      throw e;
    }
  }

  async savepoint<T>(fn: () => Promise<T>): Promise<T> {
    const name = `vb_sp_${++this.savepointSeq}`;
    this.execNow(`SAVEPOINT ${name}`);
    try {
      const out = await fn();
      this.execNow(`RELEASE ${name}`);
      return out;
    } catch (e) {
      this.execNow(`ROLLBACK TO ${name}`);
      this.execNow(`RELEASE ${name}`);
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
