/**
 * Raw SQL execution for the admin SQL runner page.
 *
 * Two modes:
 *
 *   • read-only — query goes against the live DB via a fresh `bun:sqlite`
 *     connection opened with `readonly: true`. `PRAGMA query_only = ON`
 *     belt-and-suspenders the kernel; a regex pre-filter rejects the
 *     mutating-keyword set before SQLite ever sees the SQL. Fast, no
 *     disk cost.
 *
 *   • sandbox — query runs against a per-admin SQLite snapshot at
 *     `<dataDir>/sandboxes/<adminId>.db`. Created on demand via
 *     `VACUUM INTO`, atomic + WAL-aware. Caller can DROP TABLE freely;
 *     nothing touches the live DB. Snapshots are pruned by an idle
 *     timer (see `pruneStaleSandboxes`).
 *
 * Both modes apply:
 *   • 5s wall-clock budget, enforced by running the statement off the main
 *     thread and killing it when the budget runs out (see sql-exec.ts).
 *   • 1000-row hard cap on result sets (truncated flag in the response).
 *   • SQLite errors flow back as structured `{error, code}` rather than
 *     thrown — the calling endpoint returns 200 OK with the error body
 *     so the UI can render it inline.
 */

import { Database } from "bun:sqlite";
import { getSandboxDb, replaceSandboxDb } from "./sql-sandbox.ts";
import { execOnImage, execReadOnly, ExecTimeout, type ExecResult } from "./sql-exec.ts";
import { scanSql } from "./sql-scan.ts";
import { db } from "../db/index.ts";
import { ReadOnlyBusy, ReadOnlyUnavailable, withReadOnlyLogin } from "./pg-readonly.ts";
import { DeadlineExceeded, PostgresDriver } from "../db/postgres.ts";
import { getDriver } from "../db/index.ts";
import { toPositional } from "../db/placeholders.ts";

export { scanSql };

export const MAX_SQL_RESULT_ROWS = 1000;
export const SQL_QUERY_TIMEOUT_MS = 5000;

/**
 * Statements forbidden in read-only mode. We keep the list conservative —
 * `PRAGMA writable_schema`, `ATTACH`, and `DETACH` can subvert read-only
 * even with `query_only=ON` on older SQLite builds, so they're rejected
 * outright. The lexer here is naïve (single-pass keyword scan) but the
 * SQLite-level `query_only` PRAGMA + `readonly` connection flag are the
 * load-bearing protections; this is a friendlier error surface.
 */
const FORBIDDEN_RO_KEYWORDS = [
  "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "REPLACE",
  "TRUNCATE", "ATTACH", "DETACH", "REINDEX", "VACUUM",
];

export interface RunSqlOptions {
  sql: string;
  /** Path to the actual data.db file. */
  dbPath: string;
  /** Admin id — required for sandbox mode (looks up the in-memory slot). */
  adminId?: string;
  /** Read-only against live DB, or sandbox copy with mutation allowed. */
  mode: "readonly" | "sandbox";
  /** Optional positional parameters bound to `?` placeholders. */
  params?: ReadonlyArray<string | number | bigint | boolean | null | Uint8Array>;
  /** Override the default 5s timeout (clamped 100ms..30s). */
  timeoutMs?: number;
}

export interface RunSqlResult {
  ok: boolean;
  /** Column names in row order, or empty when no rows returned. */
  columns: string[];
  /** Rows as positional arrays (matches `columns` order). */
  rows: unknown[][];
  /** Total rows before truncation; a lower bound when `rowCountExact` is false. */
  rowCount: number;
  /**
   * False when the total isn't known: on Postgres a query fetches only
   * MAX_SQL_RESULT_ROWS + 1 rows, so a truncated result has "more than
   * rowCount" rows.
   */
  rowCountExact?: boolean;
  /** True when the result was sliced down to MAX_SQL_RESULT_ROWS. */
  truncated: boolean;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** SQLite error message — populated when `ok === false`. */
  error?: string;
  /** SQLite error code (e.g. "SQLITE_ERROR", "TIMEOUT"). */
  errorCode?: string;
  /** True when the query mutated the sandbox (UPDATE/INSERT/DELETE). */
  changes?: number;
}

/**
 * Cheap, single-pass keyword filter. Strips line + block comments first,
 * then trims string literals down to placeholders so a SELECT containing
 * the literal "DELETE" in a WHERE doesn't false-positive.
 */
export function detectMutation(sql: string): string | null {
  return detectKeyword(sql, FORBIDDEN_RO_KEYWORDS);
}

function detectKeyword(sql: string, keywords: readonly string[]): string | null {
  const { words } = scanSql(sql);
  for (const kw of keywords) {
    if (words.includes(kw)) return kw;
  }
  return null;
}

/**
 * Never allowed in the sandbox: they reach files outside it. `ATTACH` can
 * open the live database (or any file) read-write, and `VACUUM INTO` writes
 * a file anywhere the server can.
 */
const FORBIDDEN_SANDBOX_KEYWORDS = [
  "ATTACH", "DETACH", "VACUUM",
  // Deprecated pragmas that set a process-wide directory: run in the sandbox
  // they would change where the live database's connection writes too.
  "TEMP_STORE_DIRECTORY", "DATA_STORE_DIRECTORY",
];

const sandboxTails = new Map<string, Promise<unknown>>();

/** Run `fn` after every earlier sandbox query of the same admin has settled. */
function sandboxQueue<T>(adminId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sandboxTails.get(adminId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  sandboxTails.set(adminId, tail);
  void tail.then(() => { if (sandboxTails.get(adminId) === tail) sandboxTails.delete(adminId); });
  return run;
}

/** What a read-only run on Postgres may start with. */
const PG_READ_STATEMENTS = new Set(["SELECT", "WITH", "VALUES", "TABLE", "EXPLAIN", "SHOW"]);

/**
 * Why Postgres can't run `sql` in read-only mode, or null. Only a clearer
 * error than Postgres would give: what makes a run safe is the login it
 * runs as (see core/pg-readonly.ts), not this check.
 */
export function postgresReadOnlyRefusal(sql: string): string | null {
  const first = scanSql(sql).words[0] ?? "";
  if (!PG_READ_STATEMENTS.has(first)) return `Read-only mode runs ${[...PG_READ_STATEMENTS].join(", ")} statements only.`;
  return null;
}

/** Test hook: the Postgres read-only execution alone, without the statement check before it. */
export const _runReadOnlyOnDriverForTests = (sql: string): Promise<ExecResult> =>
  runReadOnlyOnDriver({ sql, params: [], maxRows: MAX_SQL_RESULT_ROWS }, SQL_QUERY_TIMEOUT_MS);

/**
 * Read-only on Postgres: over the read-only login, on a connection of its
 * own, in a read-only transaction that is always rolled back. The statement
 * always goes over the extended protocol (a trailing typed parameter nobody
 * references), where Postgres itself accepts exactly one statement. A query
 * runs through a cursor and only maxRows + 1 rows are fetched, so a huge
 * result never reaches this process; past maxRows the total isn't known and
 * is reported as maxRows + 1 (truncated).
 */
async function runReadOnlyOnDriver(req: { sql: string; params: ReadonlyArray<unknown>; maxRows: number }, timeoutMs: number): Promise<ExecResult> {
  const driver = getDriver();
  if (!(driver instanceof PostgresDriver)) throw new Error(`read-only SQL is not available on ${driver.name}`);
  // A trailing `;` would count as a second, empty statement.
  const sql = req.sql.replace(/[\s;]+$/, "");
  // Without parameters a $1 would read the internal one appended below.
  if (req.params.length === 0 && /\$\d/.test(sql.replace(/'(?:[^']|'')*'/g, "''"))) {
    return { ok: false, error: "There are no parameters for $1: pass them, or use ? placeholders with parameters.", code: "VAULTBASE_READONLY" };
  }
  const text = toPositional(sql, req.params.length > 0);
  try {
    const viaCursor = ["SELECT", "WITH", "VALUES", "TABLE"].includes(scanSql(sql).words[0] ?? "");
    return await withReadOnlyLogin(timeoutMs, async () => {
      let rows: Record<string, unknown>[];
      if (viaCursor) {
        await driver.allPositional(`DECLARE vb_readonly NO SCROLL CURSOR FOR ${text}`, [...req.params, 0]);
        rows = await driver.allPositional<Record<string, unknown>>(`FETCH ${req.maxRows + 1} FROM vb_readonly`, []);
      } else {
        rows = await driver.allPositional<Record<string, unknown>>(text, [...req.params, 0]);
      }
      return { ok: true as const, total: rows.length, rows: rows.slice(0, req.maxRows) };
    });
  } catch (e) {
    if (e instanceof ReadOnlyUnavailable) return { ok: false, error: `Read-only SQL isn't available: ${e.message}`, code: "VAULTBASE_NO_READONLY" };
    if (e instanceof ReadOnlyBusy) return { ok: false, error: e.message, code: "VAULTBASE_BUSY" };
    if (e instanceof DeadlineExceeded) throw new ExecTimeout();
    const code = (e as { errno?: unknown }).errno;
    if (code === "57014") throw new ExecTimeout();
    return { ok: false, error: e instanceof Error ? e.message : String(e), code: typeof code === "string" ? code : null };
  }
}

export async function runSql(opts: RunSqlOptions): Promise<RunSqlResult> {
  const start = Date.now();
  const timeout = Math.min(Math.max(opts.timeoutMs ?? SQL_QUERY_TIMEOUT_MS, 100), 30_000);
  const fail = (error: string, errorCode: string): RunSqlResult => ({
    ok: false,
    columns: [], rows: [], rowCount: 0, truncated: false,
    durationMs: Date.now() - start,
    error, errorCode,
  });

  // One statement per run. bun:sqlite's run() executes a whole script, so
  // a second statement would slip past any check made on the first.
  if (scanSql(opts.sql).statements > 1) {
    return fail("Run one statement at a time.", "VAULTBASE_MULTI_STATEMENT");
  }

  // Read-only safety: reject mutating SQL before opening the connection.
  if (opts.mode === "readonly") {
    const bad = detectMutation(opts.sql);
    if (bad) return fail(`${bad} statements are blocked in read-only mode. Switch to sandbox to run them safely.`, "VAULTBASE_READONLY");
    if (db.name === "postgres") {
      const refused = postgresReadOnlyRefusal(opts.sql);
      if (refused) return fail(refused, "VAULTBASE_READONLY");
    }
  } else {
    const bad = detectKeyword(opts.sql, FORBIDDEN_SANDBOX_KEYWORDS);
    if (bad) return fail(`${bad} is not allowed in the sandbox: it reaches files outside it.`, "VAULTBASE_SANDBOX");
  }

  const req = { sql: opts.sql, params: opts.params ?? [], maxRows: MAX_SQL_RESULT_ROWS };
  let out: ExecResult;
  try {
    if (!db.capabilities.sandbox && opts.mode === "sandbox") {
      return fail("The SQL sandbox is not available on this database.", "VAULTBASE_NO_SANDBOX");
    }
    if (db.name !== "sqlite") {
      // No file to open read-only: a read-only transaction with a statement
      // timeout on the pool does the same job on the server side.
      out = await runReadOnlyOnDriver(req, timeout);
    } else if (opts.mode === "sandbox") {
      if (!opts.adminId) return fail("adminId is required for sandbox mode", "VAULTBASE_NO_SANDBOX");
      const sb = getSandboxDb(opts.adminId);
      if (!sb) return fail("Sandbox not initialised — reset the sandbox first.", "VAULTBASE_NO_SANDBOX");
      // One sandbox query at a time per admin: two in flight would each
      // start from the same image and the later one would drop the other's
      // changes when it hands its image back.
      const adminId = opts.adminId;
      const r = await sandboxQueue(adminId, async () => {
        const current = getSandboxDb(adminId);
        if (!current) throw new Error("Sandbox not initialised — reset the sandbox first.");
        const res = await execOnImage(current.serialize(), req, timeout);
        // Only if the sandbox is still the one this query started from: a
        // reset while it ran must not be undone by the old image coming back.
        if (res.image) replaceSandboxDb(adminId, Database.deserialize(res.image), current);
        return res;
      });
      out = r.out;
    } else {
      out = await execReadOnly(opts.dbPath, req, timeout);
    }
  } catch (e) {
    if (e instanceof ExecTimeout) return fail(`Query exceeded ${timeout}ms time budget`, "TIMEOUT");
    return fail(e instanceof Error ? e.message : String(e), "SQLITE_ERROR");
  }
  if (!out.ok) return fail(out.error, out.code ?? "SQLITE_ERROR");

  const truncated = out.total > MAX_SQL_RESULT_ROWS;
  // Postgres fetched one row past the cap and doesn't know the rest.
  const exact = !(truncated && db.name === "postgres");
  const total = exact ? out.total : MAX_SQL_RESULT_ROWS;
  const sliced = out.rows;
  const columns = sliced[0] && typeof sliced[0] === "object"
    ? Object.keys(sliced[0] as Record<string, unknown>)
    : [];
  const positional = sliced.map((r) =>
    columns.map((c) => (r as Record<string, unknown>)[c]),
  );

  return {
    ok: true,
    columns,
    rows: positional,
    rowCount: total,
    ...(exact ? {} : { rowCountExact: false }),
    truncated,
    durationMs: Date.now() - start,
    ...(out.changes !== undefined ? { changes: out.changes } : {}),
  };
}

function extractSqliteCode(e: unknown): string | null {
  if (e && typeof e === "object" && "code" in e) {
    const c = (e as { code: unknown }).code;
    if (typeof c === "string") return c;
  }
  return null;
}

