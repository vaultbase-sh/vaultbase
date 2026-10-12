/**
 * The admin SQL runner promised a 5 s budget, but bun:sqlite runs a
 * statement synchronously on the server's own thread: the timer meant to
 * interrupt it could never fire, and one runaway query stalled every other
 * request until it finished. Statements now run off the main thread and are
 * killed when the budget runs out.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { runSql } from "../core/sql-runner.ts";
import { resetSandbox, _resetSandboxRegistryForTests } from "../core/sql-sandbox.ts";

const RUNAWAY = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c";
let tmpDir: string;
let dbPath: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-sqltimeout-"));
  setLogsDir(tmpDir);
  dbPath = join(tmpDir, "data.db");
  initDb(dbPath);
  await runMigrations();
});

afterEach(() => {
  _resetSandboxRegistryForTests();
  closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

/** Count event-loop ticks while `p` runs: zero means the server was frozen. */
async function ticksDuring<T>(p: () => Promise<T>): Promise<{ value: T; ticks: number }> {
  let ticks = 0;
  const iv = setInterval(() => { ticks++; }, 50);
  try {
    return { value: await p(), ticks };
  } finally {
    clearInterval(iv);
  }
}

describe("SQL time budget", () => {
  it("read-only: a runaway query times out and the server keeps serving", async () => {
    const t0 = Date.now();
    const { value, ticks } = await ticksDuring(() => runSql({ sql: RUNAWAY, dbPath, mode: "readonly", timeoutMs: 500 }));
    expect(value.ok).toBe(false);
    expect(value.errorCode).toBe("TIMEOUT");
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(ticks).toBeGreaterThan(3);
  });

  it("read-only: a killed query leaves no lock behind (the WAL still checkpoints)", async () => {
    await runSql({ sql: RUNAWAY, dbPath, mode: "readonly", timeoutMs: 300 });
    getRawClient().exec("CREATE TABLE IF NOT EXISTS t_after (x)");
    for (let i = 0; i < 20; i++) getRawClient().exec("INSERT INTO t_after VALUES (1)");
    const r = getRawClient().query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
    expect(r.busy).toBe(0);
  });

  it("sandbox: a runaway query times out, and the sandbox still works afterwards", async () => {
    resetSandbox("a1", dbPath);
    const { value, ticks } = await ticksDuring(() => runSql({ sql: RUNAWAY, dbPath, adminId: "a1", mode: "sandbox", timeoutMs: 500 }));
    expect(value.errorCode).toBe("TIMEOUT");
    expect(ticks).toBeGreaterThan(3);
    const ok = await runSql({ sql: "SELECT 1 AS one", dbPath, adminId: "a1", mode: "sandbox" });
    expect(ok.ok).toBe(true);
    expect(ok.rows).toEqual([[1]]);
  });

  it("normal queries are unaffected (legitimate path)", async () => {
    const r = await runSql({ sql: "SELECT ? AS a, ? AS b", params: [7, "x"], dbPath, mode: "readonly" });
    expect(r.ok).toBe(true);
    expect(r.columns).toEqual(["a", "b"]);
    expect(r.rows).toEqual([[7, "x"]]);
  });
});

describe("sandbox isolation", () => {
  it("ATTACH can't reach the live database from the sandbox", async () => {
    resetSandbox("a1", dbPath);
    const r = await runSql({ sql: `ATTACH DATABASE '${dbPath}' AS live`, dbPath, adminId: "a1", mode: "sandbox" });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("VAULTBASE_SANDBOX");
  });

  it("VACUUM INTO can't write a file", async () => {
    resetSandbox("a1", dbPath);
    const target = join(tmpDir, "copy.db");
    const r = await runSql({ sql: `VACUUM INTO '${target}'`, dbPath, adminId: "a1", mode: "sandbox" });
    expect(r.ok).toBe(false);
    expect(await Bun.file(target).exists()).toBe(false);
  });

  it("sandbox writes persist between queries and never reach the live file", async () => {
    resetSandbox("a1", dbPath);
    expect((await runSql({ sql: "CREATE TABLE scratch (x)", dbPath, adminId: "a1", mode: "sandbox" })).ok).toBe(true);
    expect((await runSql({ sql: "INSERT INTO scratch VALUES (42)", dbPath, adminId: "a1", mode: "sandbox" })).changes).toBe(1);
    const r = await runSql({ sql: "SELECT x FROM scratch", dbPath, adminId: "a1", mode: "sandbox" });
    expect(r.rows).toEqual([[42]]);
    const live = new Database(dbPath, { readonly: true });
    expect(live.query("SELECT name FROM sqlite_master WHERE name = 'scratch'").all()).toHaveLength(0);
    live.close();
  });
});
