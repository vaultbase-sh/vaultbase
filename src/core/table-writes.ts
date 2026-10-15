/**
 * Which tables this process has written, for caches keyed on table contents
 * (the list totals cache in records.ts).
 *
 * SQLite's `total_changes()` says that *something* changed on this
 * connection, not what. The record and user write paths report the table
 * and the row count of every statement they run here; a cache then compares
 * the counter's movement with the rows reported. When they match, only the
 * reported tables changed and other tables' entries stay valid. When they
 * don't (raw SQL from a hook or the SQL page, an internal table), the cache
 * falls back to clearing everything, as before.
 */
import type { Database } from "bun:sqlite";

const versions = new Map<string, number>();
let reported = 0;

/** A write this process made: `changes` rows in `table` (the SQLite table name). */
export function noteTableWrite(table: string, changes: number): void {
  reported += changes;
  versions.set(table, (versions.get(table) ?? 0) + 1);
}

function totalChanges(client: Database): number {
  return (client.query("SELECT total_changes() AS t").get() as { t: number }).t;
}

/**
 * Run a write to `table` and report every row it moved the connection's
 * counter by, trigger rows included: `changes()` leaves those out, but
 * `total_changes()` counts them, and a full-text index on the table adds
 * rows through triggers on every write.
 */
export function trackWrite<T>(client: Database, table: string, fn: () => T): T {
  const before = totalChanges(client);
  const out = fn();
  noteTableWrite(table, totalChanges(client) - before);
  return out;
}

/** Version of a table's contents as seen through reported writes. */
export function tableVersion(table: string): number {
  return versions.get(table) ?? 0;
}

/** Rows reported since the last call, then zero. */
export function takeReportedChanges(): number {
  const n = reported;
  reported = 0;
  return n;
}

export function _resetTableWrites(): void {
  versions.clear();
  reported = 0;
}
