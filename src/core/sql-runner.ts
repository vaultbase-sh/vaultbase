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

async function runReadOnlyOnDriver(req: { sql: string; params: ReadonlyArray<unknown>; maxRows: number }, timeoutMs: number): Promise<ExecResult> {
  try {
    return await db.transaction(async () => {
      await db.exec("SET TRANSACTION READ ONLY");
      await db.exec(`SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`);
      const rows = await db.all<Record<string, unknown>>(req.sql, req.params);
      return { ok: true as const, total: rows.length, rows: rows.slice(0, req.maxRows) };
    });
  } catch (e) {
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

  const total = out.total;
  const sliced = out.rows;
  const truncated = total > MAX_SQL_RESULT_ROWS;
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

