/**
 * Stored row counts for record tables (SQLite).
 *
 * A list's `totalItems` was `SELECT COUNT(*)`, which reads the whole table:
 * tens of ms at a few hundred thousand rows. The totals cache keeps it per
 * table version, but every write moves the version, so under steady writes
 * every list counted again, and the synchronous count blocked the thread
 * serving it (a read worker answering nothing else meanwhile).
 *
 * Each record table now has two triggers that keep its row count in
 * `vaultbase_row_counts`, in the same transaction as the insert or delete,
 * so the stored count is exact for any write: the API, hooks, raw SQL. A
 * list with no filter and no rule clause reads it instead of counting.
 *
 * The count is trusted only while both triggers named for that exact table
 * are on it; otherwise lists count as before. The triggers and the initial
 * count are made in one transaction, and a renamed table's triggers (which
 * keep their old names, and the old name inside their body) are replaced,
 * so a missing or stale trigger costs speed, never a wrong total.
 *
 * SQLite only: Postgres lists count as before.
 */
import { db } from "../db/index.ts";

const COUNTS = "vaultbase_row_counts";

/** SQLite identifier quoting that escapes embedded `"` (DDL-safe). */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function triggerNames(table: string): [string, string] {
  return [`vb_rowcount_ins_${table}`, `vb_rowcount_del_${table}`];
}

function supported(): boolean {
  return db.name === "sqlite";
}

/**
 * Give `table` its count triggers and an exact count, replacing triggers
 * that belong to another name (a rename). Cheap when they are already in
 * place: no recount. Writer only; idempotent; run at boot for every table.
 */
export async function ensureRowCount(table: string): Promise<void> {
  if (!supported()) return;
  const [ins, del] = triggerNames(table);
  await db.exec(`CREATE TABLE IF NOT EXISTS ${COUNTS} (table_name TEXT PRIMARY KEY, n INTEGER NOT NULL)`);
  await db.transaction(async () => {
    // Count triggers on this table under another table's name (it was
    // renamed), or under this name on another table (a table renamed away
    // from this name): either would update the wrong row.
    const stale = await db.all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'vb\\_rowcount\\_%' ESCAPE '\\'
         AND ((tbl_name = ? AND name NOT IN (?, ?)) OR (name IN (?, ?) AND tbl_name != ?))`,
      [table, ins, del, ins, del, table],
    );
    for (const { name } of stale) await db.exec(`DROP TRIGGER IF EXISTS ${quoteIdent(name)}`);
    const have = await db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND name IN (?, ?)`,
      [table, ins, del],
    );
    const row = await db.get<{ n: number }>(`SELECT n FROM ${COUNTS} WHERE table_name = ?`, [table]);
    if (have?.c === 2 && row) return;
    const t = quoteIdent(table);
    const key = `'${table.replace(/'/g, "''")}'`;
    await db.exec(`DROP TRIGGER IF EXISTS ${quoteIdent(ins)}`);
    await db.exec(`DROP TRIGGER IF EXISTS ${quoteIdent(del)}`);
    await db.exec(`CREATE TRIGGER ${quoteIdent(ins)} AFTER INSERT ON ${t} BEGIN UPDATE ${COUNTS} SET n = n + 1 WHERE table_name = ${key}; END`);
    await db.exec(`CREATE TRIGGER ${quoteIdent(del)} AFTER DELETE ON ${t} BEGIN UPDATE ${COUNTS} SET n = n - 1 WHERE table_name = ${key}; END`);
    await db.run(
      `INSERT INTO ${COUNTS} (table_name, n) SELECT ?, COUNT(*) FROM ${t} WHERE 1 ON CONFLICT(table_name) DO UPDATE SET n = excluded.n`,
      [table],
    );
  });
}

/** Forget a dropped table's count (its triggers went with it). */
export async function forgetRowCount(table: string): Promise<void> {
  if (!supported()) return;
  const exists = await db.get(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [COUNTS]);
  if (exists) await db.run(`DELETE FROM ${COUNTS} WHERE table_name = ?`, [table]);
}

/** Whether `table` has both its count triggers, per schema version. */
const tracked = new Map<string, boolean>();
let trackedAt: number | null = null;

/**
 * The stored row count of `table`, or null when it isn't kept (no
 * triggers, another database): count it instead.
 */
export async function storedRowCount(table: string): Promise<number | null> {
  if (!supported()) return null;
  const token = db.schemaToken();
  if (trackedAt !== token) { tracked.clear(); trackedAt = token; }
  let on = tracked.get(table);
  if (on === undefined) {
    const [ins, del] = triggerNames(table);
    const have = await db.get<{ c: number }>(
      `SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? AND name IN (?, ?)`,
      [table, ins, del],
    );
    on = have?.c === 2;
    tracked.set(table, on);
  }
  if (!on) return null;
  const row = await db.get<{ n: number }>(`SELECT n FROM ${COUNTS} WHERE table_name = ?`, [table]);
  return row ? row.n : null;
}
