/**
 * Background WAL checkpointer.
 *
 * SQLite's autocheckpoint runs inside whichever commit pushes the WAL past the
 * threshold, so one unlucky request pays for copying the whole WAL back into
 * the database file — on the event loop. Measured on the write benchmark:
 * p99 ~90 ms with autocheckpoint on, ~18 ms with it off, and the stall grows
 * with the database (each checkpoint touches more distinct pages).
 *
 * Instead, a worker thread holds its own connection and runs
 * `wal_checkpoint(PASSIVE)` on a short interval. PASSIVE never takes the
 * writer lock and never waits, so the request thread keeps committing while
 * pages are copied. Once the worker is up, the main connection's
 * autocheckpoint is switched off; if the worker dies, it is switched back on.
 *
 * The worker also reports WAL size after each pass, so `/_/metrics` can show
 * it without running a checkpoint of its own on every poll.
 */
import type { Database } from "bun:sqlite";

/** How often the worker checkpoints. */
const INTERVAL_MS = 250;

/**
 * Under nonstop writes a PASSIVE pass never finishes "clean" — frames land
 * while it copies — so SQLite never rewinds the WAL and it grows forever.
 * Past this many frames the worker catches up with one more PASSIVE pass
 * (copying only what arrived meanwhile) and then a RESTART, which holds the
 * write lock just long enough for that delta and rewinds the log.
 */
// Each RESTART costs a DB fsync under the write lock (~50-100 ms on Windows),
// so fewer, larger ones win: 4k frames gave p99 ~60 ms on the write bench,
// 15k gave ~50 ms. Kept under journal_size_limit (16 384 frames) so the WAL
// file rewinds in place instead of growing and being truncated.
const RESTART_FRAMES = 15_000; // ~60 MB at 4 KB pages

/**
 * If the WAL still holds this many frames after a pass, the worker is not
 * keeping up (e.g. a long-lived reader pins old frames). Hand checkpointing
 * back to SQLite so the WAL can't grow without bound.
 */
const RUNAWAY_FRAMES = 100_000; // ~400 MB at 4 KB pages

/** What main sets autocheckpoint back to when the worker isn't running. */
const FALLBACK_AUTOCHECKPOINT = 10_000;

const WORKER_CODE = `
const { Database } = require("bun:sqlite");
let db = null;
let stmt = null;
let restartStmt = null;
let restartFrames = 0;
let timer = null;
function pass() {
  const t0 = performance.now();
  try {
    let r = stmt.get();
    const ms = performance.now() - t0;
    let restartMs = null;
    if (r.log >= restartFrames) {
      r = stmt.get();
      const t1 = performance.now();
      const rr = restartStmt.get();
      restartMs = performance.now() - t1;
      // busy=1: a reader or writer was mid-transaction; try again next pass.
      if (!rr.busy) r = rr;
    }
    postMessage({ type: "pass", log: r.log, checkpointed: r.checkpointed, ms, restartMs });
  } catch (e) {
    postMessage({ type: "error", message: String(e && e.message || e) });
  }
}
onmessage = (e) => {
  const m = e.data;
  if (m.type === "start") {
    try {
      db = new Database(m.path);
      // PASSIVE doesn't wait on locks; a short timeout only covers opening.
      db.exec("PRAGMA busy_timeout = 100;");
      db.exec("PRAGMA journal_size_limit = " + m.journalSizeLimit + ";");
      stmt = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
      restartStmt = db.prepare("PRAGMA wal_checkpoint(RESTART)");
      restartFrames = m.restartFrames;
      timer = setInterval(pass, m.intervalMs);
      postMessage({ type: "ready" });
    } catch (err) {
      postMessage({ type: "error", message: String(err && err.message || err) });
    }
  } else if (m.type === "stop") {
    if (timer) clearInterval(timer);
    // Finalize first: an open statement turns close() into a deferred
    // close and the file stays locked (EBUSY on Windows).
    try { stmt && stmt.finalize(); } catch {}
    try { restartStmt && restartStmt.finalize(); } catch {}
    try { db && db.close(); } catch {}
    postMessage({ type: "stopped" });
  }
};
`;

export interface CheckpointStats {
  /** Frames in the WAL after the last pass. */
  wal_frames: number;
  /** Frames copied into the database by the last pass. */
  checkpointed_frames: number;
  /** Duration of the last pass (off the request thread), ms. */
  last_pass_ms: number;
  /** Slowest pass since boot, ms. */
  max_pass_ms: number;
  passes: number;
  /** WAL rewinds done by the worker, and how long the last / slowest held the write lock, ms. */
  restarts: number;
  last_restart_ms: number;
  max_restart_ms: number;
  /** "worker" when running in the background, "inline" when SQLite's autocheckpoint is in charge. */
  mode: "worker" | "inline";
}

let worker: Worker | null = null;
let mainClient: Database | null = null;
let stats: CheckpointStats | null = null;

function fallBackToInline(reason: string): void {
  if (stats?.mode === "inline") return;
  try { mainClient?.exec(`PRAGMA wal_autocheckpoint = ${FALLBACK_AUTOCHECKPOINT};`); } catch { /* closed */ }
  if (stats) stats.mode = "inline";
  process.stderr.write(`vaultbase: background checkpointer off (${reason}); using SQLite autocheckpoint\n`);
}

/**
 * Start checkpointing `path` from a worker thread. Resolves once the worker
 * has its connection open and the main connection's autocheckpoint is off.
 * On any failure the main connection keeps its autocheckpoint.
 */
export function startCheckpointer(client: Database, path: string, journalSizeLimit: number): Promise<void> {
  if (worker) return Promise.resolve();
  mainClient = client;
  stats = { wal_frames: 0, checkpointed_frames: 0, last_pass_ms: 0, max_pass_ms: 0, passes: 0, restarts: 0, last_restart_ms: 0, max_restart_ms: 0, mode: "inline" };
  const url = URL.createObjectURL(new Blob([WORKER_CODE], { type: "application/javascript" }));
  const w = new Worker(url);
  worker = w;

  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      // A background helper must never keep the process alive on its own —
      // but only once startup is done: unref'd while the caller is still
      // awaiting, nothing holds the loop open and the process just exits.
      (w as { unref?: () => void }).unref?.();
      resolve();
    };
    w.onmessage = (e: MessageEvent) => {
      const m = e.data as {
        type: string; log?: number; checkpointed?: number; ms?: number; restartMs?: number | null; message?: string;
      };
      if (m.type === "ready") {
        client.exec("PRAGMA wal_autocheckpoint = 0;");
        stats!.mode = "worker";
        settle();
      } else if (m.type === "pass" && stats) {
        stats.wal_frames = m.log ?? 0;
        stats.checkpointed_frames = m.checkpointed ?? 0;
        stats.last_pass_ms = Math.round((m.ms ?? 0) * 10) / 10;
        if (stats.last_pass_ms > stats.max_pass_ms) stats.max_pass_ms = stats.last_pass_ms;
        stats.passes++;
        if (typeof m.restartMs === "number") {
          stats.restarts++;
          stats.last_restart_ms = Math.round(m.restartMs * 10) / 10;
          if (stats.last_restart_ms > stats.max_restart_ms) stats.max_restart_ms = stats.last_restart_ms;
        }
        if (stats.wal_frames > RUNAWAY_FRAMES) fallBackToInline(`WAL at ${stats.wal_frames} frames`);
      } else if (m.type === "error") {
        fallBackToInline(m.message ?? "worker error");
        settle();
      }
    };
    w.onerror = (e) => { fallBackToInline(e.message); settle(); };
    w.postMessage({ type: "start", path, intervalMs: INTERVAL_MS, restartFrames: RESTART_FRAMES, journalSizeLimit });
  });
}

/** Stop the worker and hand checkpointing back to the main connection. */
export async function stopCheckpointer(): Promise<void> {
  const w = worker;
  if (!w) return;
  worker = null;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1_000);
    w.onmessage = (e: MessageEvent) => {
      if ((e.data as { type: string }).type === "stopped") { clearTimeout(timer); resolve(); }
    };
    w.postMessage({ type: "stop" });
  });
  w.terminate();
  try { mainClient?.exec(`PRAGMA wal_autocheckpoint = ${FALLBACK_AUTOCHECKPOINT};`); } catch { /* closed */ }
  if (stats) stats.mode = "inline";
  mainClient = null;
}

/** Last pass's numbers, or null when no checkpointer was started (e.g. `:memory:`). */
export function checkpointStats(): CheckpointStats | null {
  return stats ? { ...stats } : null;
}
