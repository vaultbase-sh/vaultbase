/**
 * Group commit for ordinary record writes.
 *
 * Every record write used to be its own implicit transaction, and the commit
 * (WAL frames for the table page and each index page) was ~60% of a create's
 * cost. Writes landing in the same event-loop turn now share one
 * transaction: the first opens `BEGIN IMMEDIATE`, the rest join, and the
 * group commits at the end of the turn (`setImmediate`). Measured in
 * isolation: 41 µs/row one-per-commit, 17 µs at 10 per commit.
 *
 * Guarantees:
 *   - A write only returns after the COMMIT that holds its statements
 *     ({@link awaitCommit}). If that COMMIT fails, every write in the group
 *     gets the error — nothing is reported saved that isn't.
 *   - A failing statement only undoes itself (SQLite statement-level
 *     atomicity), so one bad write doesn't spoil the group.
 *   - Side effects queued with `afterCommit` run after the group commits.
 *   - Batches, cascading deletes and schema changes commit the open group
 *     first ({@link flushGroupCommit}) and then run as before.
 *
 * Trade-off: other requests on this connection can read a joined write for
 * up to one loop turn before it commits; it only disappears if the COMMIT
 * itself fails (disk full, I/O error).
 *
 * Off under cluster mode: the open group holds SQLite's write lock for the
 * turn, and other worker processes would block on it. `VAULTBASE_GROUP_COMMIT=0`
 * turns it off everywhere.
 */
import { onBeforeCloseDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { discardTableReports, flushTableReports } from "./table-writes.ts";

// The group spans event-loop turns, so it opens and commits with plain
// statements rather than db.transaction(), whose scope is a callback.
interface Group {
  waiters: Array<{ resolve: () => void; reject: (e: unknown) => void }>;
  effects: Array<() => void>;
}

let open: Group | null = null;
let flushScheduled = false;

// Never close the connection under an open group.
onBeforeCloseDb(() => flushGroupCommit());

function enabled(): boolean {
  if (process.env["VAULTBASE_GROUP_COMMIT"] === "0") return false;
  return !process.env["VAULTBASE_WORKER_ID"];
}

/**
 * Make sure a group transaction is open for the write about to run. No-op
 * when group commit is off, or when the connection is already inside some
 * other transaction (a batch's own BEGIN).
 */
export function joinGroupCommit(): void {
  if (open || !enabled()) return;
  if (db.sync.inTransaction) return;
  db.sync.exec("BEGIN IMMEDIATE");
  open = { waiters: [], effects: [] };
  if (!flushScheduled) {
    flushScheduled = true;
    setImmediate(() => {
      flushScheduled = false;
      flushGroupCommit();
    });
  }
}

/** Resolves once everything the caller wrote so far is committed. */
export function awaitCommit(): Promise<void> {
  if (!open) return Promise.resolve();
  return new Promise((resolve, reject) => open!.waiters.push({ resolve, reject }));
}

/**
 * Queue a side effect until the open group commits. Returns false when no
 * group is open, i.e. the caller's writes are already committed.
 */
export function deferUntilGroupCommit(effect: () => void): boolean {
  if (!open) return false;
  open.effects.push(effect);
  return true;
}

/** Commit the open group now, if any. Synchronous; safe to call anywhere. */
export function flushGroupCommit(): void {
  const g = open;
  if (!g) return;
  open = null;
  let failure: unknown = null;
  try {
    if (db.sync.inTransaction) db.sync.exec("COMMIT");
  } catch (e) {
    failure = e;
    try { if (db.sync.inTransaction) db.sync.exec("ROLLBACK"); } catch { /* closed */ }
  }
  if (failure) {
    discardTableReports();
    for (const w of g.waiters) w.reject(failure);
    return;
  }
  flushTableReports();
  for (const w of g.waiters) w.resolve();
  for (const f of g.effects) {
    try { f(); } catch { /* side effects never fail committed writes */ }
  }
}

/** True while a group transaction is open (tests, diagnostics). */
export function groupCommitOpen(): boolean {
  return open !== null;
}
