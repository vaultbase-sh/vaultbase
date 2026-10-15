import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.ts";

type DB = ReturnType<typeof drizzle<typeof schema>>;

let _db: DB | null = null;
let _client: Database | null = null;

export function getDb(): DB {
  if (!_db) throw new Error("DB not initialized. Call initDb() first.");
  return _db;
}

/**
 * Underlying `bun:sqlite` Database — exposed so hook helpers can run raw
 * SQL via prepared statements. Throws if the DB hasn't been initialised.
 */
export function getRawClient(): Database {
  if (!_client) throw new Error("DB not initialized. Call initDb() first.");
  return _client;
}

/**
 * Initialize SQLite. Accepts:
 *   ":memory:"             — in-memory DB (tests)
 *   "file:./path/data.db"  — file URL (legacy libSQL syntax, parsed)
 *   "./path/data.db"       — direct path
 */
/** WAL file cap on disk (bytes); shared with the background checkpointer. */
export const JOURNAL_SIZE_LIMIT = 67_108_864;

export function initDb(url: string): DB {
  let path = url;
  if (url.startsWith("file:")) path = url.slice(5);
  _client = new Database(path, { create: true });
  const isMemory = path === ":memory:";
  // Wait up to 5 s for a lock instead of failing at once. Set first: the
  // WAL switch below needs a lock, and with several processes opening the
  // database together (cluster workers, a CLI next to the server) it used to
  // fail with SQLITE_BUSY before any timeout applied.
  _client.exec("PRAGMA busy_timeout = 5000;");
  // ── Performance pragmas ───────────────────────────────────────────────
  if (!isMemory) {
    // WAL: concurrent readers + single writer (massively better for read load).
    _client.exec("PRAGMA journal_mode = WAL;");
    // synchronous=NORMAL is WAL-recommended; crash-safe, much faster than FULL.
    _client.exec("PRAGMA synchronous = NORMAL;");
    // 256 MB OS file mapping — faster than read() syscalls. mmap is meaningless
    // on `:memory:` (and triggers SQLITE_NOMEM there).
    _client.exec("PRAGMA mmap_size = 268435456;");
    // Inline autocheckpoint until the background checkpointer takes over
    // (src/db/checkpointer.ts switches this to 0 once its worker is up, and
    // back if the worker dies). CLI paths that never start it keep this.
    _client.exec("PRAGMA wal_autocheckpoint = 10000;");
    // Cap the WAL file at 64 MB on disk. Without this, a sustained-write
    // workload can balloon the WAL to gigabytes before the next checkpoint
    // truncates it, eating disk on small VPS boxes. The limit is advisory
    // (SQLite shrinks the file on the next checkpoint) — it never blocks
    // a write or causes corruption.
    _client.exec(`PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT};`);
  }
  // 32 MB page cache (negative = KiB, so -32000 ≈ 32 MB).
  _client.exec("PRAGMA cache_size = -32000;");
  // Temp tables / sort buffers in RAM.
  _client.exec("PRAGMA temp_store = MEMORY;");
  // Improve PRAGMA optimize's plan quality without making it slow at boot.
  // Default analysis sample size is 100 rows per index; 400 gives noticeably
  // better stats on tables with skewed distributions (audit log, log files,
  // record_history) without crossing into seconds-of-boot cost.
  try { _client.exec("PRAGMA analysis_limit = 400;"); } catch { /* noop */ }
  try { _client.exec("PRAGMA optimize;"); } catch { /* noop */ }

  _db = drizzle(_client, { schema });
  return _db;
}

/** Run before the connection closes (e.g. commit an open write group). */
const beforeClose: Array<() => void> = [];
export function onBeforeCloseDb(fn: () => void): void {
  beforeClose.push(fn);
}

/**
 * Run right after the connection closes, synchronously: modules that cache
 * prepared statements or anything else bound to the connection register
 * here at load time, so nothing can see a reopened database through
 * objects that belong to the old one. This used to go through a lazy
 * import, which cleared the caches a few ticks after the close.
 */
const afterClose: Array<() => void> = [];
export function onCloseDb(fn: () => void): void {
  afterClose.push(fn);
}

export function closeDb(): void {
  if (_client) for (const fn of beforeClose) { try { fn(); } catch { /* closing anyway */ } }
  _client?.close();
  _client = null;
  _db = null;
  for (const fn of afterClose) { try { fn(); } catch { /* best effort */ } }
}
