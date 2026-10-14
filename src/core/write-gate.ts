/**
 * Coordinates record writes with batch transactions on the single shared
 * SQLite connection.
 *
 * A batch runs BEGIN … COMMIT on the shared connection and awaits hooks in
 * between. Any other write that lands while that transaction is open becomes
 * part of it, and is rolled back with it. So:
 *
 *   - ordinary record writes take the gate in *shared* mode: they run
 *     concurrently with each other, but not while a batch holds it;
 *   - a batch takes it in *exclusive* mode: it waits for in-flight writes to
 *     drain, then runs alone. New batches and writes queue behind it.
 *
 * Writes made from inside a gated call (the batch's own ops, hooks writing
 * records) are recognised via AsyncLocalStorage and pass straight through.
 *
 * Side effects of writes inside a batch (realtime, webhooks, after-hooks) are
 * queued with `afterCommit` and only run once the batch commits.
 *
 * Ordinary writes also share commits with each other (group-commit.ts): a
 * shared write joins the turn's group transaction and returns only once it
 * commits. A batch commits any open group before its own BEGIN.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { awaitCommit, deferUntilGroupCommit, flushGroupCommit, joinGroupCommit } from "./group-commit.ts";

interface GateContext {
  exclusive: boolean;
  /** Side effects held until COMMIT (exclusive mode only). */
  deferred: Array<() => void>;
}

const als = new AsyncLocalStorage<GateContext>();

let sharedHolders = 0;
let exclusiveHeld = false;
let exclusiveWaiting = 0;
let waiters: Array<() => void> = [];

function wakeAll(): void {
  const w = waiters;
  waiters = [];
  for (const f of w) f();
}

function nextWake(): Promise<void> {
  return new Promise<void>((r) => waiters.push(r));
}

// The availability check and the acquisition below must happen with no
// `await` in between, or two callers can both see the gate free.

/** Run an ordinary record write. Concurrent with other writes, never inside an open batch. */
export async function withSharedWrite<T>(fn: () => Promise<T>): Promise<T> {
  if (als.getStore()) return fn(); // already inside a gated call
  // Exclusive waiters get priority so a steady stream of writes can't starve a batch.
  while (exclusiveHeld || exclusiveWaiting > 0) await nextWake();
  sharedHolders++;
  try {
    joinGroupCommit();
    let result: T;
    try {
      result = await als.run({ exclusive: false, deferred: [] }, fn);
    } catch (e) {
      // A failed write may still have changed rows before throwing (as it
      // would have in autocommit); let those commit before the caller moves on.
      await awaitCommit().catch(() => { /* the write's own error wins */ });
      throw e;
    }
    // Don't report the write before the COMMIT that holds it.
    await awaitCommit();
    return result;
  } finally {
    sharedHolders--;
    wakeAll();
  }
}

/**
 * Run `fn` with the shared connection to itself. `fn` receives `commit` and
 * `rollback` callbacks to call after its own COMMIT / ROLLBACK: commit runs
 * the deferred side effects, rollback discards them.
 */
export async function withExclusiveWrite<T>(
  fn: (tx: { commit: () => void; rollback: () => void }) => Promise<T>,
): Promise<T> {
  exclusiveWaiting++;
  try {
    while (exclusiveHeld || sharedHolders > 0) await nextWake();
  } finally {
    exclusiveWaiting--;
  }
  exclusiveHeld = true;
  // The batch runs its own BEGIN on the shared connection.
  flushGroupCommit();
  const ctx: GateContext = { exclusive: true, deferred: [] };
  const tx = {
    commit: () => {
      // Transaction is closed: effects queued from here on (e.g. an
      // after-hook that writes another record) run immediately.
      ctx.exclusive = false;
      const effects = ctx.deferred.splice(0);
      for (const f of effects) {
        try { f(); } catch { /* side effects never fail the committed batch */ }
      }
    },
    rollback: () => { ctx.deferred.length = 0; },
  };
  try {
    return await als.run(ctx, () => fn(tx));
  } finally {
    exclusiveHeld = false;
    wakeAll();
  }
}

/** Which gate the current async context holds, if any. */
export function gateMode(): "exclusive" | "shared" | null {
  const ctx = als.getStore();
  if (!ctx) return null;
  return ctx.exclusive ? "exclusive" : "shared";
}

/** Run now, or after COMMIT when called inside a batch or an open write group. */
export function afterCommit(effect: () => void): void {
  const ctx = als.getStore();
  if (ctx?.exclusive) ctx.deferred.push(effect);
  else if (!deferUntilGroupCommit(effect)) effect();
}
