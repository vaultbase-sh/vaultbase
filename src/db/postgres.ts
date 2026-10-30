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
 * Integer columns are `bigint`, so epoch seconds past 2038 (and the
 * millisecond epochs clients sometimes send to date fields) fit; the client
 * returns them as BigInt and the row mapper turns them into numbers.
 */
import { SQL } from "bun";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
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
  // integer → bigint: epoch columns (created_at, expires_at, …) outlive 2038.
  const type = c.type === "real" ? "double precision" : c.type === "blob" ? "bytea" : c.type === "integer" ? "bigint" : c.type;
  let out = `${c.name} ${type}`;
  if (c.primaryKey) out += " PRIMARY KEY";
  else if (c.notNull) out += " NOT NULL";
  if (c.unique) out += " UNIQUE";
  if (c.default?.kind === "epochNow") out += ` DEFAULT ${POSTGRES_DIALECT.epochNow}`;
  else if (c.default?.kind === "epochMsNow") out += " DEFAULT (extract(epoch from clock_timestamp()) * 1000)";
  else if (c.default?.kind === "literal") out += ` DEFAULT ${typeof c.default.value === "number" ? String(c.default.value) : sqlLiteral(c.default.value)}`;
  return out;
}

/** `$.a` or `$."a b"` (one segment, as the filter compiler emits) to a jsonb path array. */
function jsonPathArray(path: string): string {
  const seg = path.replace(/^\$\./, "").replace(/^"(.*)"$/, "$1");
  return `'{${seg.replace(/'/g, "''")}}'`;
}

/** JSON `expr` as jsonb when it is an array, else NULL; text that isn't JSON still fails. */
function pgArray(expr: string): string {
  // A JSON path read as jsonb by a jsonpath, parsed once: a CASE naming the
  // value twice parsed the whole column twice per row. `#>>` gives a string
  // value as plain text, which doesn't cast back.
  const m = JSON_TEXT_RE.exec(expr);
  const segs = m ? m[2]!.slice(2, -2).split(",") : [];
  if (m && segs.every((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s))) {
    const path = segs.map((s) => `."${s}"`).join("");
    return `jsonb_path_query_first(${m[1]}::jsonb, 'strict $${path} ? (@.type() == "array")', '{}', true)`;
  }
  const j = m ? `(${m[1]}::jsonb #> ${m[2]})` : `(${expr})::jsonb`;
  return `(CASE WHEN jsonb_typeof(${j}) = 'array' THEN ${j} END)`;
}

/** `expr` as jsonb when it is a JSON array, else NULL. */
function pgItems(expr: string): string {
  return `(CASE WHEN (${expr})::text LIKE '[%' AND pg_input_is_valid((${expr})::text, 'jsonb') THEN (${expr})::text::jsonb END)`;
}

/** The jsonb form (`#>`) of an expression jsonExtract made, or null. */
function pgJsonb(expr: string): string | null {
  const m = JSON_TEXT_RE.exec(expr);
  return m ? `(${m[1]}::jsonb #> ${m[2]})` : null;
}

/** An expression jsonExtract made: `(<expr>::jsonb #>> '{a,b}')`. */
const JSON_TEXT_RE = /^\((.+)::jsonb #>> ('\{[^']*\}')\)$/s;

/** Postgres cuts identifiers longer than this (NAMEDATALEN - 1). */
const MAX_IDENT_BYTES = 63;

export const POSTGRES_DIALECT: Dialect = {
  name: "postgres",
  epochNow: "(extract(epoch from now())::bigint)",
  always: "TRUE",
  never: "FALSE",
  tieBreak: `"id"`,
  indexTail: [`"id"`],
  typedCompare: {
    jsonb: (expr) => pgJsonb(expr),
    as: (j, kind) => kind === "number"
      ? `(CASE jsonb_typeof(${j}) WHEN 'number' THEN (${j})::numeric WHEN 'boolean' THEN (CASE WHEN (${j})::boolean THEN 1 ELSE 0 END) END)`
      : `(CASE WHEN jsonb_typeof(${j}) = 'string' THEN ${j} #>> '{}' END)`,
    eachJsonb: (expr) => `jsonb_array_elements(${pgArray(expr)})`,
    itemTextOrder: `COLLATE "C"`,
  },
  jsonPathLength: (expr) => {
    const j = pgJsonb(expr);
    if (!j) return null;
    return `(CASE jsonb_typeof(${j}) WHEN 'array' THEN jsonb_array_length(${j}) WHEN 'string' THEN length(${expr})` +
      ` WHEN 'number' THEN 0 WHEN 'boolean' THEN 0 WHEN 'object' THEN 0 END)`;
  },
  itemPair: (a, op, b) => {
    const ja = pgJsonb(a);
    const jb = pgJsonb(b);
    if (!ja || !jb) return null;
    const num = (j: string) => `jsonb_typeof(${j}) IN ('number', 'boolean')`;
    const str = (j: string) => `jsonb_typeof(${j}) = 'string'`;
    const t = POSTGRES_DIALECT.typedCompare!;
    return `(CASE WHEN ${num(ja)} AND ${num(jb)} THEN ${t.as(ja, "number")} ${op} ${t.as(jb, "number")}` +
      ` WHEN ${str(ja)} AND ${str(jb)} THEN ${t.as(ja, "text")} ${t.itemTextOrder} ${op} ${t.as(jb, "text")} ${t.itemTextOrder} END)`;
  },
  columnType(fieldType) {
    switch (fieldType) {
      case "number": return "double precision";
      case "bool": return "integer";
      case "date":
      case "autodate": return "bigint";
      default: return "text";
    }
  },
  quoteIdent,
  like: (left, pattern) => `COALESCE(${left} ILIKE ${pattern}, FALSE)`,
  // One `#>>` over the whole path: `a.b.c` reads through objects only, as
  // json_extract does, instead of re-parsing each step's text as JSON.
  jsonExtract: (expr, path) => {
    const m = JSON_TEXT_RE.exec(expr);
    const seg = jsonPathArray(path).slice(2, -2);
    return m ? `(${m[1]}::jsonb #>> '{${m[2]!.slice(2, -2)},${seg}}')` : `(${expr}::jsonb #>> '{${seg}}')`;
  },
  // NULL for anything that is not a JSON array, as SQLite answers, instead of a cast error.
  jsonArrayLength: (expr) => `(CASE WHEN (${expr})::text LIKE '[%' THEN jsonb_array_length((${expr})::text::jsonb) END)`,
  // Only an array has elements: jsonb_array_elements fails on a scalar or an object.
  jsonEach: (expr) => `jsonb_array_elements_text(${pgArray(expr)})`,
  // pg_input_is_valid first (Postgres 16+): casting text that isn't JSON fails.
  items: {
    from: (expr, alias) => `jsonb_array_elements(${pgItems(expr)}) AS ${alias}(value)`,
    value: (alias) => `${alias}.value`,
    isObject: (alias) => `jsonb_typeof(${alias}.value) = 'object'`,
    length: (expr) => `jsonb_array_length(${pgItems(expr)})`,
  },
  jsonGroupArray: (expr) => `json_agg(${expr})`,
  asText: (expr) => `(${expr})::text`,
  addColumnExpressionDefault: true,
  createTable: (name, columns) => `CREATE TABLE IF NOT EXISTS ${name} (\n  ${columns.map(columnDef).join(",\n  ")}\n)`,
  addColumn: (table, column) => `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${columnDef(column)}`,
  createIndex: (ix: IndexSpec) => `CREATE ${ix.unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS ${ix.name} ON ${ix.table}(${ix.columns.join(", ")})${ix.where ? ` WHERE ${ix.where}` : ""}`,
  listColumnsSql: (table) =>
    `SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ${sqlLiteral(bareIdent(table))} ORDER BY ordinal_position`,
  createView: (name, body) => `CREATE OR REPLACE VIEW ${name} AS ${body}`,
  indexExistsSql: () => `SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ?`,
  listIndexesSql: () => `SELECT indexname AS name, indexdef AS sql FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ?`,
  renameIndex: (name, newName) => [`ALTER INDEX ${quoteIdent(name)} RENAME TO ${quoteIdent(newName)}`],
  fitIdent: (name) => Buffer.byteLength(name) <= MAX_IDENT_BYTES ? name
    : `${name.slice(0, MAX_IDENT_BYTES - 9)}_${createHash("md5").update(name).digest("hex").slice(0, 8)}`,
  timeBucket: (format, expr) => `to_char(to_timestamp(${expr}), '${PG_BUCKET[format]}')`,
  isMissingTable: (e) => typeof e === "object" && e !== null && (e as { errno?: unknown }).errno === "42P01",
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
  explain: "pg",
  fts: "tsvector",
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
  if (rows.count !== undefined) (out as Rows).count = rows.count;
  return out;
}

/** One row in array form (drizzle's `.values()`), BigInt as numbers. */
function plainValues(row: unknown[]): unknown[] {
  return row.some((v) => typeof v === "bigint") ? row.map((v) => (typeof v === "bigint" ? Number(v) : v)) : row;
}

/** Postgres refused a prepared statement whose result columns changed under it. */
function isStalePlan(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { errno?: unknown }).errno === "0A000" &&
    /cached plan must not change result type/.test(String((e as { message?: unknown }).message));
}

/**
 * The vb_ table a raw write touched, for the list totals cache: SQLite sees
 * every write through its change counter, Postgres only through these
 * reports. `"*"` when it is a write that reaches some vb_ table but not one
 * this can name (a CTE, a join): every cached count is then retired. Null
 * for anything else (reads, writes to vaultbase_ tables).
 */
export function rawWriteTarget(sql: string): string | null {
  const writesSomeVbTable = () => (/\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/i.test(sql) && /\bvb_/i.test(sql) ? "*" : null);
  // A script of several statements: no single table to name.
  if (sql.replace(/[\s;]+$/, "").includes(";")) return writesSomeVbTable();
  const head = /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE(?:\s+TABLE)?|WITH|EXPLAIN|COPY)\b/i.exec(sql);
  if (!head) return null;
  const kind = head[1]!.toUpperCase();
  // EXPLAIN ANALYZE runs the write it explains; COPY ... FROM writes rows.
  if (kind === "EXPLAIN") return writesSomeVbTable();
  if (kind === "COPY") return /\bFROM\b/i.test(sql) && /\bvb_/i.test(sql) ? "*" : null;
  if (kind !== "WITH") {
    const rest = sql.slice(head.index + head[0].length);
    // A quoted name keeps its case (collection names may have capitals); an unquoted one folds to lower case, as Postgres does.
    const target = /^\s*(?:ONLY\s+)?(?:(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\.)?(?:"(vb_[^"]+)"|(vb_[A-Za-z0-9_]+))/i.exec(rest);
    if (target) {
      // TRUNCATE a, b names several; CASCADE reaches others.
      if (/^TRUNCATE/i.test(head[1]!) && (/^\s*,/.test(rest.slice(target[0].length)) || /\bCASCADE\b/i.test(rest))) return "*";
      return target[1] ?? target[2]!.toLowerCase();
    }
  }
  return writesSomeVbTable();
}

/** withMigrationLock with `wait: false` found the lock held: another server is migrating or restoring. */
export class MigrationLockBusy extends Error {
  constructor() { super("another server is migrating or restoring this database"); }
}

/** An isolated() call outlived its deadline; its connection was closed. */
export class DeadlineExceeded extends Error {
  constructor() { super("the run outlived its time budget and its connection was closed"); }
}

export class PostgresDriver implements DbDriver {
  readonly name = "postgres" as const;
  readonly dialect = POSTGRES_DIALECT;
  readonly capabilities = POSTGRES_CAPABILITIES;

  private readonly pool: SQL;
  /** The connection URL, for tools that open their own connection (pg_dump). */
  readonly url: string;
  private readonly als = new AsyncLocalStorage<SQL>();
  private readonly migrationLockHeld = new AsyncLocalStorage<true>();
  private token = 1;
  private traceFn: ((sql: string) => void) | null = null;
  private savepointSeq = 0;

  constructor(url: string, opts: { max?: number } = {}) {
    this.url = url;
    // bigint: COUNT, SUM and bigint columns come back as BigInt instead of
    // strings; the row mapper turns them into numbers (see `rows`).
    const Client = SQL as unknown as new (url: string, options: Record<string, unknown>) => SQL;
    this.pool = new Client(url, { max: opts.max ?? 8, bigint: true });
  }

  /** The pool. Drizzle gets `drizzleClient` instead. */
  get raw(): SQL {
    return this.pool;
  }

  /**
   * The client the drizzle handle runs on. Each query goes to the current
   * transaction's connection when there is one (a drizzle write inside a
   * batch used to commit on its own pooled connection: kept after a
   * rollback, and a second connection held per transaction), and its rows
   * come back with BigInt turned into numbers, as the driver's own queries
   * do: drizzle maps rows through the SQLite table definitions, which pass
   * BigInt through. Drizzle uses `unsafe` (awaited, or `.values()`) only;
   * the server never opens a drizzle transaction.
   */
  get drizzleClient(): SQL {
    const self = this;
    const client = {
      unsafe(query: string, params?: unknown[]) {
        return {
          then<A, B>(ok?: ((rows: unknown[]) => A) | null, fail?: ((e: unknown) => B) | null) {
            return self.query(query, params ?? [], false).then((rows) => plainRows(rows as Rows), undefined).then(ok, fail);
          },
          values: () => self.query(query, params ?? [], true).then((rows) => (rows as unknown[][]).map(plainValues)),
        };
      },
    };
    return client as unknown as SQL;
  }

  /**
   * Run one statement. Its text ends with the schema token: Bun.sql keeps a
   * prepared statement per text on each pooled connection, and Postgres
   * refuses one whose result columns changed ("cached plan must not change
   * result type", on every later run), so adding a field broke every list
   * of that table on every connection that had run one. A new token is a
   * new text, prepared afresh. A change made elsewhere (another server, or
   * psql) shows as that error before its notice arrives; it moves the token
   * and the statement runs once more, unless a transaction is open, which
   * the error has already aborted.
   */
  private async query(text: string, params: unknown[], values: boolean): Promise<unknown[]> {
    const run = () => {
      const q = this.conn().unsafe(`${text}\n/* vb:${this.token} */`, params);
      return (values ? q.values() : q) as Promise<unknown[]>;
    };
    try {
      return await run();
    } catch (e) {
      if (!isStalePlan(e) || this.als.getStore()) throw e;
      this.token++;
      return await run();
    }
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
    const rows = await this.query(toPositional(sql, params.length > 0), params as unknown[], false);
    // INSERT ... RETURNING and writes in a CTE come back as rows.
    const table = rawWriteTarget(sql);
    if (table) {
      noteTableWrite(table, (rows as Rows).count ?? 0);
      if (!this.inTransaction) flushTableReports();
    }
    return plainRows<T>(rows as Rows);
  }

  /**
   * Rows of `text`, already in Postgres's `$n` form, with `params`; no `?`
   * conversion. With at least one parameter the statement goes over the
   * extended protocol, which takes exactly one statement.
   */
  async allPositional<T = Record<string, unknown>>(text: string, params: unknown[]): Promise<T[]> {
    this.traceFn?.(text);
    return plainRows<T>((await this.query(text, params, false)) as Rows);
  }

  async get<T = Record<string, unknown>>(sql: string, params: ReadonlyArray<unknown> = []): Promise<T | null> {
    const rows = await this.all<T>(sql, params);
    return rows[0] ?? null;
  }

  async run(sql: string, params: ReadonlyArray<unknown> = [], opts?: RunOptions): Promise<RunResult> {
    this.traceFn?.(sql);
    const rows = (await this.query(toPositional(sql, params.length > 0), params as unknown[], false)) as Rows;
    const changes = rows.count ?? 0;
    const table = opts?.table ?? rawWriteTarget(sql);
    if (table) {
      noteTableWrite(table, changes);
      if (!this.inTransaction) flushTableReports();
    }
    return { changes, lastInsertRowid: 0, trackedChanges: changes };
  }

  async exec(sql: string): Promise<void> {
    this.traceFn?.(sql);
    await this.conn().unsafe(sql).simple();
    if (DDL_RE.test(sql)) this.token++;
    // rawWriteTarget gives "*" for a script of several statements.
    const table = rawWriteTarget(sql);
    if (table) {
      noteTableWrite(table, 0);
      if (!this.inTransaction) flushTableReports();
    }
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
      const out = await this.pool.begin(async (tx) => this.als.run(tx as unknown as SQL, fn)) as T;
      flushTableReports({ bump: true });
      return out;
    } finally {
      this.traceFn?.("COMMIT");
    }
  }

  /**
   * NOTIFY `channel` on the current connection: inside a transaction it is
   * delivered at COMMIT, and not at all after a rollback.
   */
  notify(channel: string, payload: string): Promise<unknown> {
    return this.conn().notify(channel, payload) as unknown as Promise<unknown>;
  }

  /** LISTEN on `channel` (one dedicated connection, re-subscribed after a reconnect). */
  listen(channel: string, onNotify: (payload: string) => void, onListen: () => void): Promise<{ unlisten(): Promise<void> }> {
    return this.pool.listen(channel, onNotify, onListen);
  }

  /**
   * Run `fn` holding this schema's migration lock (a session advisory lock
   * on a connection of its own), so servers booting together migrate one
   * at a time. Re-entrant: a restore holds it throughout and runs the
   * migrations inside, where a second lock request from another connection
   * would wait on the first forever. `wait: false` throws MigrationLockBusy
   * instead of waiting.
   */
  async withMigrationLock<T>(fn: () => Promise<T>, opts: { wait?: boolean } = {}): Promise<T> {
    if (this.migrationLockHeld.getStore()) return fn();
    const lockSql = `hashtext('vaultbase:migrate:' || current_schema())`;
    const conn = await this.pool.reserve();
    try {
      if (opts.wait === false) {
        const rows = await conn.unsafe(`SELECT pg_try_advisory_lock(${lockSql}) AS ok`) as Array<{ ok: boolean }>;
        if (!rows[0]?.ok) throw new MigrationLockBusy();
      } else {
        await conn.unsafe(`SELECT pg_advisory_lock(${lockSql})`);
      }
      try {
        return await this.migrationLockHeld.run(true, fn);
      } finally {
        await conn.unsafe(`SELECT pg_advisory_unlock(${lockSql})`).catch(() => { /* released with the connection */ });
      }
    } finally {
      conn.release();
    }
  }

  /**
   * Run `fn` on a connection opened for this call and closed after it, never
   * one from the pool. Session state the SQL inside leaves behind (settings,
   * advisory locks, prepared statements) goes with the connection instead of
   * reaching later queries on a pooled one.
   *
   * `tx`: "rollback" runs `fn` in a transaction that is always rolled back,
   * "commit" in one committed when `fn` resolves, "none" without a
   * transaction (for statements Postgres refuses inside one, like VACUUM).
   * `url` connects as another login (the read-only one). `deadlineMs` closes
   * the connection if `fn` is still running then, and `fn`'s promise rejects
   * with DeadlineExceeded. Not for use inside
   * an open transaction: a second connection waiting on that transaction's
   * locks would wait forever.
   */
  async isolated<T>(fn: () => Promise<T>, opts: { tx: "rollback" | "commit" | "none"; url?: string; deadlineMs?: number }): Promise<T> {
    if (this.als.getStore()) throw new Error("isolated() can't run inside an open transaction");
    // A commit can succeed after the deadline fired, and the caller would be told it failed.
    if (opts.deadlineMs !== undefined && opts.tx === "commit") throw new Error("isolated(): a deadline can't be combined with tx: \"commit\"");
    const Client = SQL as unknown as new (url: string, options: Record<string, unknown>) => SQL;
    const url = opts.url ?? this.url;
    const conn = new Client(url, { max: 1, bigint: true, connectionTimeout: 10 });
    const rollback = Symbol("rollback");
    let backend: number | null = null;
    const run = async (c: SQL) => {
      if (opts.deadlineMs !== undefined) backend = Number(((await c.unsafe(`SELECT pg_backend_pid() AS p`)) as Array<{ p: unknown }>)[0]!.p);
      return this.als.run(c, fn);
    };
    const work = (async (): Promise<T> => {
      let out: T | undefined;
      try {
        if (opts.tx === "none") {
          const reserved = await conn.reserve();
          try {
            out = await run(reserved as unknown as SQL);
          } finally {
            reserved.release();
          }
          flushTableReports();
        } else {
          await conn.begin(async (tx) => {
            out = await run(tx as unknown as SQL);
            if (opts.tx === "rollback") throw rollback;
          });
          flushTableReports({ bump: true });
        }
      } catch (e) {
        if (e !== rollback) throw e;
      }
      return out as T;
    })();
    if (opts.deadlineMs === undefined) {
      try { return await work; } finally { await conn.close().catch(() => { /* already gone */ }); }
    }
    // Past the deadline the caller gets DeadlineExceeded at once. The backend
    // is ended from a second connection as the same login (a role may always
    // end its own backends; matching the login too, so a reused process id
    // can't be hit), and the client is dropped without waiting for its query.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new DeadlineExceeded());
        const pid = backend;
        if (pid !== null) {
          const killer = new Client(url, { max: 1, connectionTimeout: 5 });
          void killer.unsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = ${pid} AND usename = current_user`)
            .catch(() => { /* gone already */ })
            .finally(() => killer.close().catch(() => { /* gone */ }));
        }
        void conn.close({ timeout: 0 }).catch(() => { /* gone */ });
      }, opts.deadlineMs);
    });
    work.catch(() => { /* reported through the race, or after the deadline: nobody waits */ });
    try {
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
      void conn.close({ timeout: 0 }).catch(() => { /* gone */ });
    }
  }


  /** Another server changed the schema: caches keyed on the token rebuild. */
  noteForeignSchemaChange(): void {
    this.token++;
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
