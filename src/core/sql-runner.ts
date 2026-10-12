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

/**
 * Split SQL into the words SQLite will see, in one left-to-right pass that
 * knows which characters start a string, a quoted identifier or a comment.
 * Stripping each kind with its own regex, one after another, got the order
 * wrong for some input: `'--'` inside a string was taken for a comment
 * start, which hid every keyword after it on the line while SQLite still ran
 * them. Also counts statements (`;` outside literals and comments).
 */
export function scanSql(sql: string): { words: string[]; statements: number } {
  const words: string[] = [];
  let statements = 0;
  let pending = false; // anything since the last `;`
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? n : end + 1;
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      for (;;) {
        const k = sql.indexOf(close, j);
        if (k < 0) { j = n; break; }
        // A doubled quote is an escaped quote, not the end ([…] has no escape).
        if (close !== "]" && sql[k + 1] === close) { j = k + 2; continue; }
        j = k + 1;
        break;
      }
      i = j;
      pending = true;
    } else if (c === ";") {
      if (pending) statements++;
      pending = false;
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j]!)) j++;
      words.push(sql.slice(i, j).toUpperCase());
      pending = true;
      i = j;
    } else {
      if (!/\s/.test(c)) pending = true;
      i++;
    }
  }
  if (pending) statements++;
  return { words, statements };
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
const FORBIDDEN_SANDBOX_KEYWORDS = ["ATTACH", "DETACH", "VACUUM"];

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
    if (opts.mode === "sandbox") {
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
        if (res.image) replaceSandboxDb(adminId, Database.deserialize(res.image));
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

