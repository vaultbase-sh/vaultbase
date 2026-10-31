import { afterEach, describe, expect, test } from "bun:test";
import { onSqlite } from "./_helpers.ts";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { checkpointStats, startCheckpointer, stopCheckpointer } from "../db/checkpointer.ts";

let dir = "";
let db: Database | null = null;

afterEach(async () => {
  await stopCheckpointer();
  db?.close();
  db = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function open(): Database {
  dir = mkdtempSync(join(tmpdir(), "vb-ckpt-"));
  const d = new Database(join(dir, "data.db"), { create: true });
  // Same as initDb: writers wait out the worker's brief RESTART lock.
  d.exec("PRAGMA busy_timeout = 5000;");
  d.exec("PRAGMA journal_mode = WAL;");
  d.exec("PRAGMA wal_autocheckpoint = 10000;");
  d.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  return d;
}

const autocheckpoint = (d: Database) =>
  (d.query("PRAGMA wal_autocheckpoint").get() as { wal_autocheckpoint: number }).wal_autocheckpoint;

describe.skipIf(!onSqlite)("background checkpointer", () => {
  test("takes over checkpointing and drains the WAL off the main connection", async () => {
    db = open();
    await startCheckpointer(db, join(dir, "data.db"), 67_108_864);
    expect(checkpointStats()?.mode).toBe("worker");
    expect(autocheckpoint(db)).toBe(0);

    const ins = db.prepare("INSERT INTO t (v) VALUES (?)");
    for (let i = 0; i < 2_000; i++) ins.run("x".repeat(200));
    ins.finalize(); // else close() defers and Windows can't remove the dir

    // A few worker passes later every frame has been copied back.
    let s = checkpointStats()!;
    for (let i = 0; i < 40 && !(s.passes > 0 && s.checkpointed_frames === s.wal_frames && s.wal_frames > 0); i++) {
      await Bun.sleep(50);
      s = checkpointStats()!;
    }
    expect(s.passes).toBeGreaterThan(0);
    expect(s.wal_frames).toBeGreaterThan(0);
    expect(s.checkpointed_frames).toBe(s.wal_frames);
  });

  test("rewinds the WAL under nonstop writes instead of letting it grow", async () => {
    db = open();
    await startCheckpointer(db, join(dir, "data.db"), 67_108_864);
    const ins = db.prepare("INSERT INTO t (v) VALUES (?)");
    // Back-to-back commits of ~one page each until the worker has rewound
    // the WAL a few times (10 s cap), yielding briefly so its reports land.
    // On a loaded machine the writes outrun the worker, so the WAL size at
    // any one instant proves nothing. What the worker owes is: rewinds
    // happen, the WAL never reaches the runaway threshold that hands
    // checkpointing back to SQLite, and it shrinks once the writes stop.
    //
    // The writer pauses while the worker is more than two rewinds behind
    // (RESTART_FRAMES is 15,000): unthrottled, a busy machine let it outrun
    // the worker for the whole loop, built a WAL near the runaway threshold,
    // and then needed longer than the test allowed to drain it, which made
    // this test fail now and then in full-suite runs while proving nothing
    // about the checkpointer. It counts frames not yet copied, not the WAL's
    // size: a WAL the worker has caught up on keeps its size until the next
    // write, so pausing on that would wait for nothing.
    const row = "x".repeat(3_000);
    const until = Date.now() + 15_000;
    let peak = 0;
    const behind = () => { const c = checkpointStats(); return c ? c.wal_frames - c.checkpointed_frames : 0; };
    while (Date.now() < until && (checkpointStats()?.restarts ?? 0) < 3) {
      if (behind() > 30_000) { await Bun.sleep(20); continue; }
      for (let i = 0; i < 500; i++) ins.run(row);
      await Bun.sleep(1);
      peak = Math.max(peak, checkpointStats()?.wal_frames ?? 0);
    }
    ins.finalize();
    let s = checkpointStats()!;
    expect(s.mode).toBe("worker");
    expect(s.restarts).toBeGreaterThan(0);
    expect(peak).toBeLessThan(100_000);
    // Writes stopped: once the worker has copied what was left (a pass over
    // tens of thousands of frames takes seconds on a loaded machine, and over
    // 30 s on a slow CI runner's disk), the next write starts the WAL over.
    // SQLite rewinds the log at a write, never at the checkpoint itself, so
    // without one the WAL keeps reporting its old size however long this
    // waits (what made this test fail now and then in full-suite runs).
    const one = db.prepare("INSERT INTO t (v) VALUES (?)");
    for (let i = 0; i < 1_800 && s.wal_frames >= 40_000; i++) {
      if (s.checkpointed_frames === s.wal_frames) one.run("x");
      await Bun.sleep(50);
      s = checkpointStats()!;
    }
    one.finalize();
    // With the worker's numbers, so a failure shows whether it stalled
    // (passes stopped) or its rewinds were refused (passes go on).
    if (s.wal_frames >= 40_000) throw new Error(`the WAL didn't shrink: ${JSON.stringify(s)}`);
  }, 120_000);

  // A writer that holds the lock almost all the time, as group commit does
  // under steady load: each transaction stays open across a few awaits,
  // commits, and the next begins after one turn of the event loop. The worker's RESTART polls for the lock and
  // loses every time, and the WAL used to grow until checkpointing fell back
  // to SQLite's own. Now the worker asks, and the main thread rewinds in
  // that turn of the loop.
  test("rewinds from the main thread when the worker keeps losing the write lock", async () => {
    db = open();
    await startCheckpointer(db, join(dir, "data.db"), 67_108_864);
    const ins = db.prepare("INSERT INTO t (v) VALUES (?)");
    const row = "x".repeat(3_000);
    const until = Date.now() + 30_000;
    let peak = 0;
    // Main steps in only when the worker's copy is nearly done (within
    // STARVED_MAX_BEHIND, 4,096 frames). On a loaded machine the writer
    // outran the copy, so main was never asked and the WAL headed for the
    // runaway threshold: the test failed now and then in full-suite runs and
    // on CI while proving nothing. The writer still holds the lock as often,
    // which is what the worker loses to, but adds no rows while the copy is
    // behind; a PASSIVE copy doesn't need the lock and catches up.
    const behind = () => { const c = checkpointStats(); return c ? c.wal_frames - c.checkpointed_frames : 0; };
    while (Date.now() < until && (checkpointStats()?.main_restarts ?? 0) < 2) {
      // The lock is held across awaits, as a group commit's window is.
      db.exec("BEGIN IMMEDIATE");
      const rows = behind() > 3_000 ? 0 : 25;
      for (let j = 0; j < 4; j++) {
        for (let i = 0; i < rows; i++) ins.run(row);
        await Bun.sleep(2);
      }
      db.exec("COMMIT");
      await new Promise((r) => setImmediate(r));
      peak = Math.max(peak, checkpointStats()?.wal_frames ?? 0);
      if (peak > 90_000) break; // heading for the runaway fallback: failed
    }
    ins.finalize();
    const s = checkpointStats()!;
    expect(s.mode).toBe("worker");
    expect(s.main_restarts).toBeGreaterThanOrEqual(2);
    expect(peak).toBeLessThan(90_000);
  }, 60_000);

  test("stop hands checkpointing back to SQLite", async () => {
    db = open();
    await startCheckpointer(db, join(dir, "data.db"), 67_108_864);
    await stopCheckpointer();
    expect(checkpointStats()?.mode).toBe("inline");
    expect(autocheckpoint(db)).toBe(10_000);
  });

  test("a database the worker can't open leaves autocheckpoint on", async () => {
    db = open();
    await startCheckpointer(db, join(dir, "missing", "nope.db"), 67_108_864);
    expect(checkpointStats()?.mode).toBe("inline");
    expect(autocheckpoint(db)).toBe(10_000);
  });
});
