/**
 * The database driver contract. Core code talks to the database through
 * the facade in `./index.ts`, which delegates to the driver chosen at
 * start-up; the driver owns the connection, the dialect (the SQL fragments
 * that differ between databases) and the capabilities (the features the
 * server adapts to rather than ports).
 *
 * SQLite is the default and the only driver today. Its `all`, `get`, `run`
 * and `exec` return plain values, so the hot path pays no promise; call
 * sites `await` uniformly (awaiting a non-promise is a microtask) and a
 * driver with an asynchronous client slots in without touching them.
 *
 * `sync` is the same surface typed synchronously. It exists for the code
 * that cannot await yet (the filter compiler's lookups, the hook API's
 * `helpers.db`, caches read per request) and is only honoured by SQLite;
 * every caller is debt to pay down before another driver can be selected.
 */

import type { ColumnSpec, IndexSpec } from "./ddl.ts";

export type MaybePromise<T> = T | Promise<T>;

export interface RunResult {
  /** Rows the statement changed. */
  changes: number;
  lastInsertRowid: number | bigint;
  /**
   * Rows the connection's change counter moved by, trigger rows included
   * (SQLite `total_changes()`; equal to `changes` where triggers are not
   * used). The list-totals cache compares this with what the write paths
   * report (see core/table-writes.ts).
   */
  trackedChanges: number;
}

export interface RunOptions {
  /**
   * The table this write targets, when the caller wants it reported to
   * the caches keyed on table contents. The driver reports `trackedChanges`
   * rows for it and, outside a transaction, flushes the report to the read
   * workers at once; inside one, the commit site flushes.
   */
  table?: string;
}

export interface TransactionOptions {
  /**
   * Take the write lock when the transaction opens (SQLite `BEGIN
   * IMMEDIATE`) rather than at its first write. Default true: a writer
   * that waits for the lock up front cannot be told to retry halfway.
   */
  immediate?: boolean;
}

/** SQL fragments and names that differ between databases. SQLite's are today's strings. */
export interface Dialect {
  readonly name: "sqlite" | "postgres";
  /** Current Unix time in seconds, as a column default or in an expression. */
  readonly epochNow: string;
  /** Predicates that are always true / always false, as written in a WHERE. */
  readonly always: string;
  readonly never: string;
  /** The column that orders rows physically and breaks ties on a sort. */
  readonly tieBreak: string;
  /**
   * Columns to append to a non-unique index so it serves a sort that ends
   * with the tie-break, and a deep page from the index alone. Empty on
   * SQLite, whose indexes carry the rowid already; the primary key on
   * databases that don't.
   */
  readonly indexTail: string[];
  /**
   * Postgres only: how the filter compiler lines up a bound value with the
   * expression it is compared with, so comparisons answer as on SQLite.
   * Bound numbers are typed parameters there, and `#>>` reads JSON as text;
   * SQLite compares a column by its affinity and json_extract keeps the JSON
   * type. Undefined on SQLite, which needs none of it.
   */
  readonly typedCompare?: {
    /** The jsonb form (`#>`) of an expression made by jsonExtract, or null when `expr` is not one. */
    jsonb(expr: string): string | null;
    /** A jsonb expression as a number (booleans as 1/0) or as text; NULL when the JSON value is another type. */
    as(jsonb: string, kind: "number" | "text"): string;
    /** Like jsonEach, with `value` as jsonb. */
    eachJsonb(expr: string): string;
    /** Appended to an item's text value so it orders by character code, as on SQLite and in rules.ts. */
    readonly itemTextOrder: string;
  };
  /**
   * SQLite only: a JSON path read from an item (`items:any(qty = 3)`,
   * `items.qty ?= 3`) as the bound value's type, NULL for a JSON value of
   * another type; null when `expr` isn't a JSON path. Group subfields are
   * typed, so `qty = "3"` matches nothing, as on Postgres and in rules.ts,
   * instead of SQLite's ordering of numbers before text.
   */
  itemCompare?(expr: string, kind: "number" | "text"): string | null;
  /**
   * Two JSON paths read from one item (`items:any(qty > stock)`) compared
   * by JSON type: a number or boolean (as 1/0) with a number or boolean,
   * text with text by character code; NULL for values of different types.
   * Null when either side isn't a JSON path.
   */
  itemPair(a: string, op: string, b: string): string | null;
  /**
   * `:length` of a value read by a JSON path, by its JSON type: a list's
   * count, a string's characters, 0 for another value, NULL when missing.
   * Null when `expr` isn't a JSON path.
   */
  jsonPathLength(expr: string): string | null;
  /** SQLite only: like itemCompare, for the `value` of a jsonEach row (a list inside an item). */
  itemElement?(kind: "number" | "text"): string;
  /** Storage type for a built-in field type (`TEXT`, `INTEGER`, `REAL`). */
  columnType(fieldType: string): string;
  quoteIdent(name: string): string;
  /** A `~` match: `left` contains the pattern `pattern` (a SQL expression). NULL-safe, 0/1. */
  like(left: string, pattern: string): string;
  jsonExtract(expr: string, path: string): string;
  jsonArrayLength(expr: string): string;
  /** A table expression yielding one row per element of the JSON array `expr`, with a `value` column. */
  jsonEach(expr: string): string;
  /**
   * The elements of a list of items (a group field, a JSON list of objects)
   * for `items:any(...)` and `items.f ?= v`. A value that isn't a JSON array
   * (another field's text, an encrypted value) has no elements instead of
   * failing the query.
   */
  readonly items: {
    /** A FROM item: one row per element of `expr`, as `alias`. */
    from(expr: string, alias: string): string;
    /** The element of row `alias`, as JSON that jsonExtract reads. */
    value(alias: string): string;
    /** Whether the element of row `alias` is a JSON object. */
    isObject(alias: string): string;
    /** The number of elements; NULL when `expr` isn't a JSON array. */
    length(expr: string): string;
  };
  jsonGroupArray(expr: string): string;
  /** `expr` as text, for LIKE and length over a value that may be JSON-typed. */
  asText(expr: string): string;
  /** Whether ADD COLUMN accepts an expression default; SQLite does not. */
  readonly addColumnExpressionDefault: boolean;

  /** DDL for the fixed tables (db/ddl.ts). */
  createTable(name: string, columns: ColumnSpec[]): string;
  addColumn(table: string, column: ColumnSpec): string;
  createIndex(index: IndexSpec): string;
  /** A query whose rows carry the table's column names in a `name` column. */
  listColumnsSql(table: string): string;
  /** A view over a SELECT body, replacing an existing one of that name. */
  createView(name: string, body: string): string;
  /** `SELECT 1 …` with one `?` for the index name. */
  indexExistsSql(): string;
  /** Rows `{ name, sql }` for every index of the table named by one `?`. */
  listIndexesSql(): string;
  /** Statements that rename an index, given its current definition. */
  renameIndex(name: string, newName: string, sql: string): string[];
  /**
   * The name to create an object under, given the name it is built as.
   * Postgres cuts names to 63 bytes, so two long names could become one, and
   * the name made was not the name asked for: a longer one keeps its first
   * 54 characters and ends in a hash of the whole. SQLite keeps names whole.
   * Built names are ASCII (identifiers are checked against [A-Za-z0-9_]).
   */
  fitIdent(name: string): string;
  /** A time bucket of an epoch-seconds expression, in one of the five formats of aggregate.ts. */
  timeBucket(format: TimeBucket, expr: string): string;
  /** Whether `e` is a unique-constraint failure; `column` narrows it to one column. */
  isUniqueViolation(e: unknown, column?: string): boolean;
  /** Whether `e` says the table a statement named does not exist. */
  isMissingTable(e: unknown): boolean;
}

export type TimeBucket = "hour" | "day" | "week" | "month" | "year";

export interface Capabilities {
  /** `VACUUM INTO`-style file backups and file-swap restore. */
  fileBackups: boolean;
  /** The in-memory SQL sandbox. */
  sandbox: boolean;
  checkpointer: boolean;
  /** Read worker threads sharing the database file. */
  readWorkerThreads: boolean;
  /** Detecting commits by other connections (SQLite `data_version`). */
  foreignCommitProbe: boolean;
  explain: "sqlite" | "pg" | "none";
  fts: "fts5" | "tsvector" | "none";
  /** A failing statement inside a transaction undoes only itself. */
  statementAtomicity: boolean;
}

/** The driver's surface typed synchronously. SQLite only; see the module comment. */
export interface SyncDb {
  all<T = Record<string, unknown>>(sql: string, params?: ReadonlyArray<unknown>): T[];
  get<T = Record<string, unknown>>(sql: string, params?: ReadonlyArray<unknown>): T | null;
  run(sql: string, params?: ReadonlyArray<unknown>, opts?: RunOptions): RunResult;
  /** One or more statements, no parameters, no result. */
  exec(sql: string): void;
  /** Column names a SELECT would produce, without running it. */
  describe(sql: string): string[];
  readonly inTransaction: boolean;
  /**
   * A transaction around synchronous work: nothing else can run on the
   * connection between its BEGIN and COMMIT, which schema changes rely on
   * (a write that joined an open transaction would vanish with its
   * rollback). Nested in an open transaction it is a savepoint.
   */
  transaction<T>(fn: () => T, opts?: TransactionOptions): T;
}

export interface DbDriver {
  readonly name: "sqlite" | "postgres";
  readonly dialect: Dialect;
  readonly capabilities: Capabilities;
  readonly sync: SyncDb;

  all<T = Record<string, unknown>>(sql: string, params?: ReadonlyArray<unknown>): MaybePromise<T[]>;
  get<T = Record<string, unknown>>(sql: string, params?: ReadonlyArray<unknown>): MaybePromise<T | null>;
  run(sql: string, params?: ReadonlyArray<unknown>, opts?: RunOptions): MaybePromise<RunResult>;
  exec(sql: string): MaybePromise<void>;
  describe(sql: string): MaybePromise<string[]>;
  readonly inTransaction: boolean;

  /**
   * A number that changes whenever the schema does: SQLite's
   * `schema_version`, which any connection's DDL moves; a driver without
   * such a counter keeps one in memory and bumps it on its own DDL. Caches
   * derived from the schema (table columns, the sensitive-column map) key
   * on it. Synchronous on every driver, so the request path can check it.
   */
  schemaToken(): number;

  /**
   * Run `fn` in a transaction and commit when it resolves, roll back when
   * it throws. Nested inside an open transaction it becomes a savepoint,
   * so a failure inside `fn` undoes `fn`'s work and nothing outside it.
   */
  transaction<T>(fn: () => Promise<T>, opts?: TransactionOptions): Promise<T>;
  /** A savepoint around `fn`; outside a transaction it opens one. */
  savepoint<T>(fn: () => Promise<T>): Promise<T>;

  /**
   * Observe every statement the driver runs (tests pin the SQL of whole
   * operations this way). `null` stops it.
   */
  trace(fn: ((sql: string) => void) | null): void;
  /** Statements held in the prepared-statement cache (tests). */
  preparedStatementCount(): number;
  /** Drop cached statements; call after DDL that changes a table's shape. */
  invalidateStatements(): void;

  close(): void;
}
