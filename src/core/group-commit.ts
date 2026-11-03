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
 *     atomicity), so one bad write doesn't spoil the group. When SQLite
 *     ends the whole transaction instead (a trigger's `RAISE(ROLLBACK)`),
 *     every write that joined the group is reported failed and its side
 *     effects are dropped; the next write opens a new group.
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
import { db, driverOpen, getDriver } from "../db/index.ts";
import { discardTableReports, flushTableReports } from "./table-writes.ts";
import type { SqliteDriver } from "../db/sqlite.ts";

// The group spans event-loop turns, so it opens and commits with plain
// statements rather than db.transaction(), whose scope is a callback.
export interface Group {
  waiters: Array<{ resolve: () => void; reject: (e: unknown) => void }>;
  effects: Array<() => void>;
  state: "open" | "committed" | "failed";
  failure?: unknown;
}

let open: Group | null = null;
let flushScheduled = false;

// Never close the connection under an open group.
onBeforeCloseDb(() => flushGroupCommit());

function enabled(): boolean {
  if (process.env["VAULTBASE_GROUP_COMMIT"] === "0") return false;
  // One shared connection with one writer is what the group amortises;
  // a pooled driver has nothing to gain and no synchronous surface.
  if (driverOpen() && getDriver().name !== "sqlite") return false;
  return !process.env["VAULTBASE_WORKER_ID"];
}

function fail(g: Group, failure: unknown): void {
  g.state = "failed";
  g.failure = failure;
  g.effects = [];
  discardTableReports();
  for (const w of g.waiters.splice(0)) w.reject(failure);
}

/**
 * The open group's transaction ended without our COMMIT: SQLite rolled the
 * whole thing back (a trigger's RAISE(ROLLBACK)). Every write that joined
 * it is lost, and none of them may be reported saved.
 */
function noticeRollback(): void {
  if (!open || db.sync.inTransaction) return;
  const g = open;
  open = null;
  fail(g, new Error("The write was rolled back with others made at the same moment; nothing was saved. Try again."));
}

/**
 * Make sure a group transaction is open for the write about to run, and
 * return it, so the write waits on the commit of the group it actually
 * wrote in. Null when group commit is off, or when the connection is
 * already inside some other transaction (a batch's own BEGIN).
 */
export function joinGroupCommit(): Group | null {
  noticeRollback();
  if (open) return open;
  if (!enabled()) return null;
  if (db.sync.inTransaction) return null;
  db.sync.exec("BEGIN IMMEDIATE");
  open = { waiters: [], effects: [], state: "open" };
  if (!flushScheduled) {
    flushScheduled = true;
    setImmediate(() => {
      flushScheduled = false;
      flushGroupCommit();
    });
  }
  return open;
}

/** Resolves once group `g` is committed; rejects if it failed or was rolled back. */
export function awaitCommit(g: Group | null): Promise<void> {
  noticeRollback();
  if (!g || g.state === "committed") return Promise.resolve();
  if (g.state === "failed") return Promise.reject(g.failure);
  return new Promise((resolve, reject) => g.waiters.push({ resolve, reject }));
}

/**
 * Queue a side effect until group `g` (by default the open one) commits.
 * Returns false when there is none, i.e. the caller's writes are already
 * committed and the effect should run now. An effect of a failed group is
 * dropped.
 */
export function deferUntilGroupCommit(effect: () => void, g: Group | null | undefined = open): boolean {
  noticeRollback();
  if (!g || g.state === "committed") return false;
  if (g.state === "open") g.effects.push(effect);
  return true;
}

/**
 * Commit the open group now, if any. Synchronous; safe to call anywhere.
 * While a hook's transaction is a savepoint inside the group, the commit
 * waits for it to end (SqliteDriver.holdsWriteGroup), so the group never
 * commits half of it; the driver calls back here when it does.
 */
export function flushGroupCommit(): void {
  const g = open;
  if (!g) return;
  const driver = getDriver() as Partial<SqliteDriver>;
  if (driver.holdsWriteGroup) {
    driver.onGroupReleased = () => {
      driver.onGroupReleased = null;
      flushGroupCommit();
    };
    return;
  }
  if (!db.sync.inTransaction) { noticeRollback(); return; }
  open = null;
  try {
    db.sync.exec("COMMIT");
  } catch (e) {
    try { if (db.sync.inTransaction) db.sync.exec("ROLLBACK"); } catch { /* closed */ }
    fail(g, e);
    return;
  }
  g.state = "committed";
  flushTableReports();
  for (const w of g.waiters.splice(0)) w.resolve();
  for (const f of g.effects.splice(0)) {
    try { f(); } catch { /* side effects never fail committed writes */ }
  }
}

/** True while a group transaction is open (tests, diagnostics). */
export function groupCommitOpen(): boolean {
  return open !== null;
}
