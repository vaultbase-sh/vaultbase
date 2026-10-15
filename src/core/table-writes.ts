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
import { broadcast } from "./thread-bus.ts";

const versions = new Map<string, number>();
let reported = 0;
/** Reports of writes not yet committed, sent to the read workers at COMMIT. */
const pending = new Map<string, number>();

/** Apply a report: `changes` rows in `table`. On a worker this is what the bus delivers. */
export function applyTableReport(table: string, changes: number): void {
  reported += changes;
  versions.set(table, (versions.get(table) ?? 0) + 1);
}

/** A write this thread made: `changes` rows in `table` (the SQLite table name). */
export function noteTableWrite(table: string, changes: number): void {
  applyTableReport(table, changes);
  pending.set(table, (pending.get(table) ?? 0) + changes);
}

/**
 * Send the pending reports to the read workers. Called once the rows are
 * committed, so a worker that hears about a table sees the new rows when
 * it recounts; a worker that sees the commit first (its `data_version`
 * moved with nothing reported) empties its cache instead, which is safe.
 */
export function flushTableReports(): void {
  if (pending.size === 0) return;
  const tables = [...pending.entries()];
  pending.clear();
  broadcast({ type: "bus", kind: "tables", tables });
}

/** Drop pending reports after a rollback: nothing became visible. */
export function discardTableReports(): void {
  pending.clear();
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
  // Autocommit: the rows are visible now. Inside a transaction the commit
  // site flushes (group commit, batch, cascading delete).
  if (!client.inTransaction) flushTableReports();
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
  pending.clear();
  reported = 0;
}
