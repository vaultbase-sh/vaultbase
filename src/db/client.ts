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
    // Cap the WAL file at 64 MB on disk. Without this, a sustained-write
    // workload can balloon the WAL to gigabytes before the next checkpoint
    // truncates it, eating disk on small VPS boxes. The limit is advisory
    // (SQLite shrinks the file on the next checkpoint) — it never blocks
    // a write or causes corruption.
    _client.exec("PRAGMA journal_size_limit = 67108864;");
  }
  // 32 MB page cache (negative = KiB, so -32000 ≈ 32 MB).
  _client.exec("PRAGMA cache_size = -32000;");
  // Temp tables / sort buffers in RAM.
  _client.exec("PRAGMA temp_store = MEMORY;");
  // Per-connection statement timeout to bound pathological queries.
  _client.exec("PRAGMA busy_timeout = 5000;");
  // Improve PRAGMA optimize's plan quality without making it slow at boot.
  // Default analysis sample size is 100 rows per index; 400 gives noticeably
  // better stats on tables with skewed distributions (audit log, log files,
  // record_history) without crossing into seconds-of-boot cost.
  try { _client.exec("PRAGMA analysis_limit = 400;"); } catch { /* noop */ }
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
  try {
    const mod = await import("../core/users-table.ts");
    mod.invalidateUserTableColumnCache?.();
  } catch { /* not loaded */ }
  try {
    const mod = await import("../core/collections.ts");
    mod._resetCollectionCache?.();
  } catch { /* not loaded */ }
}
