/**
 * Run one admin SQL statement off the main thread, so a time budget can
 * actually be enforced.
 *
 * bun:sqlite is synchronous: a statement run on the server's own thread
 * blocks the event loop until it finishes, so the `setTimeout` meant to
 * interrupt it can never fire, and a runaway query (a recursive CTE, a huge
 * cross join) stalls every request until it completes.
 *
 *   • Live database (read-only mode): a child process opens the file
 *     read-only and is killed when the budget runs out. A killed process
 *     releases its SQLite locks with it; a killed worker thread would not,
 *     and its open read transaction would pin the WAL until restart.
 *   • Sandbox: the sandbox is an in-memory database, so a worker thread gets
 *     a serialized copy, runs the statement, and hands back the new image if
 *     anything changed. Terminating that worker touches nothing on disk.
 *
 * The compiled binary runs the child with BUN_BE_BUN=1, which makes a
 * `bun build --compile` executable behave as the bun CLI for `-e`.
 */

export interface ExecRequest {
  sql: string;
  params: ReadonlyArray<unknown>;
  /** Rows to send back; the total count is still reported. */
  maxRows: number;
}

export type ExecResult =
  | { ok: true; rows: Record<string, unknown>[]; total: number; changes?: number }
  | { ok: false; error: string; code: string | null };

export class ExecTimeout extends Error {}

/** Shared by the child process and the worker: run a statement, describe the outcome. */
const RUN_STATEMENT = `
const enc = (v) => v instanceof Uint8Array ? { $b64: Buffer.from(v).toString("base64") } : typeof v === "bigint" ? String(v) : v;
const dec = (v) => v && typeof v === "object" && typeof v.$b64 === "string" ? new Uint8Array(Buffer.from(v.$b64, "base64")) : v;
function runStatement(db, req) {
  try {
    const params = req.params.map(dec);
    const stmt = db.prepare(req.sql);
    if (stmt.columnNames.length > 0) {
      const rows = stmt.all(...params);
      return { ok: true, total: rows.length, rows: rows.slice(0, req.maxRows).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, enc(v)]))) };
    }
    const r = db.run(req.sql, ...params);
    return { ok: true, total: 0, rows: [], changes: r.changes };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e), code: e && typeof e.code === "string" ? e.code : null };
  }
}
`;

const CHILD_CODE = `
import { Database } from "bun:sqlite";
${RUN_STATEMENT}
const req = JSON.parse(await Bun.stdin.text());
let out;
try {
  const db = new Database(req.path, { readonly: true, create: false });
  db.exec("PRAGMA busy_timeout = 1000");
  db.exec("PRAGMA query_only = ON");
  out = runStatement(db, req);
  db.close();
} catch (e) {
  out = { ok: false, error: e && e.message ? e.message : String(e), code: e && typeof e.code === "string" ? e.code : null };
}
process.stdout.write(JSON.stringify(out));
`;

const WORKER_CODE = `
import { Database } from "bun:sqlite";
${RUN_STATEMENT}
self.onmessage = (e) => {
  const { image, req } = e.data;
  const db = Database.deserialize(image);
  const before = db.query("SELECT total_changes() AS c, (SELECT schema_version FROM pragma_schema_version) AS s").get();
  const out = runStatement(db, req);
  const after = db.query("SELECT total_changes() AS c, (SELECT schema_version FROM pragma_schema_version) AS s").get();
  const changed = before.c !== after.c || before.s !== after.s;
  postMessage({ out, image: changed ? db.serialize() : null });
  db.close();
};
`;

function decodeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      if (v && typeof v === "object" && typeof (v as { $b64?: unknown }).$b64 === "string") {
        r[k] = new Uint8Array(Buffer.from((v as { $b64: string }).$b64, "base64"));
      }
    }
  }
  return rows;
}

function encodeParams(params: ReadonlyArray<unknown>): unknown[] {
  return params.map((v) =>
    v instanceof Uint8Array ? { $b64: Buffer.from(v).toString("base64") } : typeof v === "bigint" ? String(v) : v,
  );
}

/** Run a read-only statement against the database file at `path`. */
export async function execReadOnly(path: string, req: ExecRequest, timeoutMs: number): Promise<ExecResult> {
  const child = Bun.spawn([process.execPath, "-e", CHILD_CODE], {
    env: { ...process.env, BUN_BE_BUN: "1" },
    stdin: new TextEncoder().encode(JSON.stringify({ ...req, params: encodeParams(req.params), path })),
    stdout: "pipe",
    stderr: "pipe",
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(9); }, timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (timedOut) throw new ExecTimeout();
    if (!stdout) return { ok: false, error: stderr.trim().slice(0, 500) || "SQL process failed", code: null };
    const out = JSON.parse(stdout) as ExecResult;
    if (out.ok) decodeRows(out.rows);
    return out;
  } finally {
    clearTimeout(timer);
  }
}

let workerUrl: string | null = null;

/**
 * Run a statement against a serialized in-memory database. Returns the
 * result and, when the statement changed anything, the new image.
 */
export async function execOnImage(
  image: Uint8Array,
  req: ExecRequest,
  timeoutMs: number,
): Promise<{ out: ExecResult; image: Uint8Array | null }> {
  workerUrl ??= URL.createObjectURL(new Blob([WORKER_CODE], { type: "application/javascript" }));
  const worker = new Worker(workerUrl);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ExecTimeout()), timeoutMs);
      worker.onmessage = (e: MessageEvent) => {
        clearTimeout(timer);
        const data = e.data as { out: ExecResult; image: Uint8Array | null };
        if (data.out.ok) decodeRows(data.out.rows);
        resolve(data);
      };
      worker.onerror = (e) => { clearTimeout(timer); reject(new Error(e.message)); };
      worker.postMessage({ image, req: { ...req, params: encodeParams(req.params) } });
    });
  } finally {
    worker.terminate();
  }
}
