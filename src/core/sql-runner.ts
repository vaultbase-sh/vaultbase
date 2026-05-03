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
 *   • 5s wall-clock budget enforced via `db.interrupt()` from a setTimeout.
 *   • 1000-row hard cap on result sets (truncated flag in the response).
 *   • SQLite errors flow back as structured `{error, code}` rather than
 *     thrown — the calling endpoint returns 200 OK with the error body
 *     so the UI can render it inline.
 */

import { Database } from "bun:sqlite";
import { getSandboxDb } from "./sql-sandbox.ts";

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
  /** Total rows BEFORE truncation. */
  rowCount: number;
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
  const stripped = sql
    .replace(/--[^\n]*/g, " ")           // line comments
    .replace(/\/\*[\s\S]*?\*\//g, " ")    // block comments
    .replace(/'(?:[^']|'')*'/g, "''")     // single-quoted strings
    .replace(/"(?:[^"]|"")*"/g, '""');    // double-quoted identifiers/strings
  const upper = stripped.toUpperCase();
  for (const kw of FORBIDDEN_RO_KEYWORDS) {
    const re = new RegExp(`\\b${kw}\\b`);
    if (re.test(upper)) return kw;
  }
  return null;
}

export async function runSql(opts: RunSqlOptions): Promise<RunSqlResult> {
  const start = Date.now();
  const timeout = Math.min(Math.max(opts.timeoutMs ?? SQL_QUERY_TIMEOUT_MS, 100), 30_000);

  // Read-only safety: reject mutating SQL before opening the connection.
  if (opts.mode === "readonly") {
    const bad = detectMutation(opts.sql);
    if (bad) {
      return {
        ok: false,
        columns: [], rows: [], rowCount: 0, truncated: false,
        durationMs: Date.now() - start,
        error: `${bad} statements are blocked in read-only mode. Switch to sandbox to run them safely.`,
        errorCode: "VAULTBASE_READONLY",
      };
    }
  }

  let db: Database | null = null;
  // True only for the live-DB path — sandbox handles are owned by the
  // sandbox registry and must not be closed here.
  let ownsConnection = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;

  try {
    if (opts.mode === "sandbox") {
      if (!opts.adminId) {
        return {
          ok: false,
          columns: [], rows: [], rowCount: 0, truncated: false,
          durationMs: Date.now() - start,
          error: "adminId is required for sandbox mode",
          errorCode: "VAULTBASE_NO_SANDBOX",
        };
      }
      const sb = getSandboxDb(opts.adminId);
      if (!sb) {
        return {
          ok: false,
          columns: [], rows: [], rowCount: 0, truncated: false,
          durationMs: Date.now() - start,
          error: "Sandbox not initialised — reset the sandbox first.",
          errorCode: "VAULTBASE_NO_SANDBOX",
        };
      }
      db = sb;
      ownsConnection = false;
    } else {
      db = new Database(opts.dbPath, { readonly: true, create: false });
      try { db.exec("PRAGMA query_only = ON"); } catch { /* noop */ }
    }

    timer = setTimeout(() => {
      timedOut = true;
      // bun:sqlite exposes `interrupt` to abort an in-flight statement.
      const anyDb = db as unknown as { interrupt?: () => void };
      try { anyDb.interrupt?.(); } catch { /* noop */ }
    }, timeout);

    const params = (opts.params ?? []) as ReadonlyArray<unknown>;

    // For row-returning statements (SELECT / EXPLAIN / RETURNING) we need
    // a prepared Statement to read columnNames + rows. For mutations
    // (INSERT/UPDATE/DELETE/DDL) we use Database.run(), which is the
    // path bun:sqlite documents for changes-only execution. Distinguish
    // by preparing once + checking columnNames.
    const stmt = db.prepare(opts.sql);
    const colNames = (stmt as unknown as { columnNames?: string[] }).columnNames ?? [];

    let rows: unknown[] = [];
    let changes: number | undefined;
    if (colNames.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out = (stmt as unknown as { all(...a: unknown[]): unknown }).all(...params);
      rows = Array.isArray(out) ? out : [];
    } else {
      // Database.run handles statements that don't return rows. Returns
      // { changes, lastInsertRowid }.
      const r = (db as unknown as { run(sql: string, ...p: unknown[]): { changes: number } })
        .run(opts.sql, ...params);
      changes = typeof r.changes === "number" ? r.changes : undefined;
    }

    const total = rows.length;
    const truncated = total > MAX_SQL_RESULT_ROWS;
    const sliced = truncated ? rows.slice(0, MAX_SQL_RESULT_ROWS) : rows;
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
      truncated,
      durationMs: Date.now() - start,
      ...(changes !== undefined ? { changes } : {}),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      columns: [], rows: [], rowCount: 0, truncated: false,
      durationMs: Date.now() - start,
      error: timedOut ? `Query exceeded ${timeout}ms time budget` : msg,
      errorCode: timedOut ? "TIMEOUT" : extractSqliteCode(e) ?? "SQLITE_ERROR",
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (ownsConnection) {
      try { db?.close(); } catch { /* ignore */ }
    }
  }
}

function extractSqliteCode(e: unknown): string | null {
  if (e && typeof e === "object" && "code" in e) {
    const c = (e as { code: unknown }).code;
    if (typeof c === "string") return c;
  }
  return null;
}

