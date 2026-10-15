/**
 * The Postgres driver: a `Bun.sql` pool, statements rewritten from `?` to
 * `$n`, and transactions pinned to one connection through AsyncLocalStorage
 * so every `db.*` call made inside `db.transaction(fn)` — hooks included —
 * runs on that connection without passing handles around.
 *
 * What differs from SQLite and is handled here or declared through the
 * capabilities: no synchronous surface (`db.sync` throws), no statement
 * cache to speak of (the server prepares per connection), `lastInsertRowid`
 * is always 0 (ids are strings chosen by the server), the schema token is
 * an in-process counter bumped by this process's own DDL, and a failing
 * statement aborts the whole transaction (callers that need per-statement
 * atomicity wrap each statement in a savepoint; see `statementAtomicity`).
 *
 * Integer columns are `integer` (32-bit): `bigint` comes back from the
 * client as a string, which the rest of the server would have to convert
 * everywhere. Epoch seconds fit until 2038; revisit before then.
 */
import { SQL } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Capabilities, DbDriver, Dialect, RunOptions, RunResult, SyncDb, TimeBucket, TransactionOptions } from "./driver.ts";
import type { ColumnSpec, IndexSpec } from "./ddl.ts";
import { toPositional } from "./placeholders.ts";
import { flushTableReports, noteTableWrite } from "../core/table-writes.ts";

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** An identifier as it may arrive from callers: quoted or bare. */
function bareIdent(name: string): string {
  return name.startsWith('"') && name.endsWith('"') ? name.slice(1, -1).replace(/""/g, '"') : name;
}

function sqlLiteral(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function columnDef(c: ColumnSpec): string {
  const type = c.type === "real" ? "double precision" : c.type === "blob" ? "bytea" : c.type;
  let out = `${c.name} ${type}`;
  if (c.primaryKey) out += " PRIMARY KEY";
  else if (c.notNull) out += " NOT NULL";
  if (c.unique) out += " UNIQUE";
  if (c.default?.kind === "epochNow") out += ` DEFAULT ${POSTGRES_DIALECT.epochNow}`;
  else if (c.default?.kind === "literal") out += ` DEFAULT ${typeof c.default.value === "number" ? String(c.default.value) : sqlLiteral(c.default.value)}`;
  return out;
}

/** `$.a` or `$."a b"` (one segment, as the filter compiler emits) to a jsonb path array. */
function jsonPathArray(path: string): string {
  const seg = path.replace(/^\$\./, "").replace(/^"(.*)"$/, "$1");
  return `'{${seg.replace(/'/g, "''")}}'`;
}

export const POSTGRES_DIALECT: Dialect = {
  name: "postgres",
  epochNow: "(extract(epoch from now())::integer)",
  always: "TRUE",
  never: "FALSE",
  tieBreak: `"id"`,
  columnType(fieldType) {
    switch (fieldType) {
      case "number": return "double precision";
      case "bool": return "integer";
      case "date":
      case "autodate": return "integer";
      default: return "text";
    }
  },
  quoteIdent,
  like: (left, pattern) => `COALESCE(${left} ILIKE ${pattern}, FALSE)`,
  jsonExtract: (expr, path) => `(${expr}::jsonb #>> ${jsonPathArray(path)})`,
  // NULL for anything that is not a JSON array, as SQLite answers, instead of a cast error.
  jsonArrayLength: (expr) => `(CASE WHEN ${expr} LIKE '[%' THEN jsonb_array_length(${expr}::jsonb) END)`,
  jsonEach: (expr) => `jsonb_array_elements_text(${expr}::jsonb)`,
  jsonGroupArray: (expr) => `json_agg(${expr})`,
  createTable: (name, columns) => `CREATE TABLE IF NOT EXISTS ${name} (\n  ${columns.map(columnDef).join(",\n  ")}\n)`,
  addColumn: (table, column) => `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${columnDef(column)}`,
  createIndex: (ix: IndexSpec) => `CREATE ${ix.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${ix.name} ON ${ix.table}(${ix.columns.join(", ")})${ix.where ? ` WHERE ${ix.where}` : ""}`,
  listColumnsSql: (table) =>
    `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ${sqlLiteral(bareIdent(table))} ORDER BY ordinal_position`,
  createView: (name, body) => `CREATE OR REPLACE VIEW ${name} AS ${body}`,
  indexExistsSql: () => `SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ?`,
  listIndexesSql: () => `SELECT indexname AS name, indexdef AS sql FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ?`,
  renameIndex: (name, newName) => [`ALTER INDEX ${quoteIdent(name)} RENAME TO ${quoteIdent(newName)}`],
  timeBucket: (format, expr) => `to_char(to_timestamp(${expr}), '${PG_BUCKET[format]}')`,
  isUniqueViolation: (e, column) =>
    typeof e === "object" && e !== null && (e as { errno?: unknown }).errno === "23505" &&
    (!column || String((e as { message?: string }).message).includes(`_${column}_`)),
};

// `to_char` formats for the five buckets. Weeks are ISO weeks here, where
// SQLite counts weeks from the first Monday of the year.
const PG_BUCKET: Record<TimeBucket, string> = {
  hour: 'YYYY-MM-DD"T"HH24:00',
  day: "YYYY-MM-DD",
  week: 'IYYY-"W"IW',
  month: "YYYY-MM",
  year: "YYYY",
};

export const POSTGRES_CAPABILITIES: Capabilities = {
  fileBackups: false,
  sandbox: false,
  checkpointer: false,
  readWorkerThreads: false,
  foreignCommitProbe: false,
  explain: "none",
  fts: "none",
  statementAtomicity: false,
};

const DDL_RE = /^\s*(CREATE|ALTER|DROP)\b/i;

type Rows = unknown[] & { count?: number };

/**
 * Rows as the rest of the server expects them: BigInt (COUNT, SUM, bigint
 * columns) as numbers. Values past 2^53 would lose precision; nothing here
 * counts that high.
 */
function plainRows<T>(rows: Rows): T[] {
  const out = new Array<T>(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] as Record<string, unknown>;
    let copy: Record<string, unknown> | null = null;
    for (const k in r) {
      const v = r[k];
      if (typeof v === "bigint") { copy ??= { ...r }; copy[k] = Number(v); }
    }
    out[i] = (copy ?? r) as T;
  }
  return out;
}

export class PostgresDriver implements DbDriver {
  readonly name = "postgres" as const;
  readonly dialect = POSTGRES_DIALECT;
  readonly capabilities = POSTGRES_CAPABILITIES;

  private readonly pool: SQL;
  private readonly als = new AsyncLocalStorage<SQL>();
  private token = 1;
  private traceFn: ((sql: string) => void) | null = null;
  private savepointSeq = 0;

  constructor(url: string, opts: { max?: number } = {}) {
    // bigint: COUNT, SUM and bigint columns come back as BigInt instead of
    // strings; the row mapper turns them into numbers (see `rows`).
    const Client = SQL as unknown as new (url: string, options: Record<string, unknown>) => SQL;
    this.pool = new Client(url, { max: opts.max ?? 8, bigint: true });
  }

  /** The pool, for the drizzle handle. */
  get raw(): SQL {
    return this.pool;
  }

  get sync(): SyncDb {
    throw new Error("db.sync is not available on Postgres: this code path must await the database (see src/db/driver.ts)");
  }

  /** Confirms the server answers; throws with the connection error otherwise. */
  async open(): Promise<void> {
    await this.pool.unsafe("SELECT 1");
  }

  private conn(): SQL {
    return this.als.getStore() ?? this.pool;
  }

  async all<T = Record<string, unknown>>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T[]> {
    this.traceFn?.(sql);
    const rows = await this.conn().unsafe(toPositional(sql), params as unknown[]);
    return plainRows<T>(rows as Rows);
  }

  async get<T = Record<string, unknown>>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T | null> {
    const rows = await this.all<T>(sql, params);
    return rows[0] ?? null;
  }

  async run(sql: string, params: ReadonlyArray<unknown> = [], opts?: RunOptions): Promise<RunResult> {
    this.traceFn?.(sql);
    const rows = (await this.conn().unsafe(toPositional(sql), params as unknown[])) as Rows;
    const changes = rows.count ?? 0;
    if (opts?.table) {
      noteTableWrite(opts.table, changes);
      if (!this.inTransaction) flushTableReports();
    }
    return { changes, lastInsertRowid: 0, trackedChanges: changes };
  }

  async exec(sql: string): Promise<void> {
    this.traceFn?.(sql);
    await this.conn().unsafe(sql).simple();
    if (DDL_RE.test(sql)) this.token++;
  }

  /**
   * Column names of a SELECT: a temporary view in a reserved session
   * reports them through information_schema even when the query would
   * return no rows.
   */
  async describe(sql: string): Promise<string[]> {
    this.traceFn?.(sql);
    const session = this.als.getStore() ?? await this.pool.reserve();
    try {
      await session.unsafe(`CREATE TEMP VIEW vb_describe AS ${sql}`).simple();
      try {
        const rows = await session.unsafe(
          `SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'vb_describe' ORDER BY ordinal_position`,
        );
        return Array.from(rows as Rows).map((r) => (r as { name: string }).name);
      } finally {
        await session.unsafe(`DROP VIEW vb_describe`).simple();
      }
    } finally {
      if (session !== this.als.getStore()) (session as unknown as { release: () => void }).release();
    }
  }

  get inTransaction(): boolean {
    return this.als.getStore() !== undefined;
  }

  schemaToken(): number {
    return this.token;
  }

  async transaction<T>(fn: () => Promise<T>, _opts?: TransactionOptions): Promise<T> {
    if (this.als.getStore()) return this.savepoint(fn);
    this.traceFn?.("BEGIN");
    try {
      return await this.pool.begin(async (tx) => this.als.run(tx as unknown as SQL, fn)) as T;
    } finally {
      this.traceFn?.("COMMIT");
    }
  }

  async savepoint<T>(fn: () => Promise<T>): Promise<T> {
    const conn = this.als.getStore();
    if (!conn) return this.transaction(fn);
    const name = `vb_sp_${++this.savepointSeq}`;
    await this.exec(`SAVEPOINT ${name}`);
    try {
      const out = await fn();
      await this.exec(`RELEASE SAVEPOINT ${name}`);
      return out;
    } catch (e) {
      await this.exec(`ROLLBACK TO SAVEPOINT ${name}`);
      await this.exec(`RELEASE SAVEPOINT ${name}`);
      throw e;
    }
  }

  trace(fn: ((sql: string) => void) | null): void {
    this.traceFn = fn;
  }

  preparedStatementCount(): number {
    return 0;
  }

  invalidateStatements(): void {
    this.token++;
  }

  close(): void {
    // Queries still in flight (side effects after a test, a request racing a
    // shutdown) reject with "Connection closed"; that is their callers'
    // problem, not an unhandled rejection of the close itself.
    this.pool.close({ timeout: 2 }).catch(() => { /* already closed */ });
  }
}
