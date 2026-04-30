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
export function initDb(url: string): DB {
  let path = url;
  if (url.startsWith("file:")) path = url.slice(5);
  _client = new Database(path, { create: true });
  const isMemory = path === ":memory:";
  // ── Performance pragmas ───────────────────────────────────────────────
  if (!isMemory) {
    // WAL: concurrent readers + single writer (massively better for read load).
    _client.exec("PRAGMA journal_mode = WAL;");
    // synchronous=NORMAL is WAL-recommended; crash-safe, much faster than FULL.
    _client.exec("PRAGMA synchronous = NORMAL;");
    // 256 MB OS file mapping — faster than read() syscalls. mmap is meaningless
    // on `:memory:` (and triggers SQLITE_NOMEM there).
    _client.exec("PRAGMA mmap_size = 268435456;");
    // Push WAL checkpoint cost off the request path during write bursts.
    // Default 1000 pages (~4 MB at 4 KB pages) causes periodic mid-burst
    // stalls; 10 000 pages (~40 MB) lets the WAL grow during sustained writes
    // and checkpoints during quieter periods. Doesn't disable autocheckpoint
    // entirely — unbounded WAL is worse than periodic stalls.
    _client.exec("PRAGMA wal_autocheckpoint = 10000;");
  }
  // 32 MB page cache (negative = KiB, so -32000 ≈ 32 MB).
  _client.exec("PRAGMA cache_size = -32000;");
  // Temp tables / sort buffers in RAM.
  _client.exec("PRAGMA temp_store = MEMORY;");
  // Per-connection statement timeout to bound pathological queries.
  _client.exec("PRAGMA busy_timeout = 5000;");
  try { _client.exec("PRAGMA optimize;"); } catch { /* noop */ }

  _db = drizzle(_client, { schema });
  return _db;
}

export function closeDb(): void {
  _client?.close();
  _client = null;
  _db = null;
  // Drop module-level prepared-statement cache; otherwise the next initDb
  // reuses statements bound to a closed DB (test isolation, schema swap).
  void clearAllStmtCachesOnClose();
}

/** Lazy-imported invalidator — module dep ordering keeps this lazy. */
async function clearAllStmtCachesOnClose(): Promise<void> {
  try {
    const mod = await import("../core/records.ts");
    mod.invalidatePreparedStatements?.();
  } catch { /* records module not loaded — nothing to clear */ }
}
