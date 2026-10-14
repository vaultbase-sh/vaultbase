import { afterEach, describe, expect, test } from "bun:test";
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

describe("background checkpointer", () => {
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
    const row = "x".repeat(3_000);
    const until = Date.now() + 10_000;
    while (Date.now() < until && (checkpointStats()?.restarts ?? 0) < 3) {
      for (let i = 0; i < 500; i++) ins.run(row);
      await Bun.sleep(1);
    }
    ins.finalize();
    const s = checkpointStats()!;
    expect(s.mode).toBe("worker");
    expect(s.restarts).toBeGreaterThan(0);
    // Without rewinds this climbs past 100k frames and trips the fallback.
    expect(s.wal_frames).toBeLessThan(40_000);
  }, 15_000);

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
