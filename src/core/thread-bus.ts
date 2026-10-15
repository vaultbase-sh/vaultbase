/**
 * Messages from the main thread to the read worker threads (core/read-pool.ts).
 *
 * Workers keep their own caches and SQLite connection. What changes on the
 * main thread reaches them here: which tables a committed write touched (so
 * a worker's list-totals cache keeps the other tables), that the collection
 * cache must be dropped, that a setting changed. Without a pool, `broadcast`
 * has no sender and does nothing; on a worker it does nothing either.
 */
export type BusMessage =
  | { type: "bus"; kind: "tables"; tables: Array<[table: string, changes: number]> }
  | { type: "bus"; kind: "collections" }
  | { type: "bus"; kind: "settings"; key: string };

let sender: ((m: BusMessage) => void) | null = null;

/** The pool installs the function that posts to every worker. */
export function setBusSender(fn: ((m: BusMessage) => void) | null): void {
  sender = fn;
}

export function broadcast(m: BusMessage): void {
  sender?.(m);
}

/** True on a read worker thread. */
export function isReadWorker(): boolean {
  return process.env["VAULTBASE_READ_WORKER"] !== undefined;
}
