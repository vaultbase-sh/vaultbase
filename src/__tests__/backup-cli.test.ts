/**
 * Test for `vaultbase backup --to <dest>` CLI subcommand.
 *
 * Covers:
 *   - parseDestination dispatches file:// / bare path / s3:// / r2:// / b2://
 *   - parseBackupArgs flag parsing
 *   - end-to-end: real snapshot + local-file destination round-trip
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { admin } from "../db/schema.ts";
import { parseBackupArgs, parseDestination, runBackup } from "../scripts/backup.ts";

describe("parseDestination", () => {
  it("treats a bare path as a local file", () => {
    const d = parseDestination("/tmp/foo.db");
    expect(d.kind).toBe("file");
    // Windows resolves to `D:\tmp\foo.db`; just confirm the leaf is preserved.
    expect(d.bucket.replace(/\\/g, "/").endsWith("/tmp/foo.db")).toBe(true);
  });

  it("treats file:// as local", () => {
    const d = parseDestination("file:///tmp/x.db");
    expect(d.kind).toBe("file");
  });

  it("parses s3://bucket/key", () => {
    const d = parseDestination("s3://my-bucket/path/snap.db");
    expect(d.kind).toBe("s3");
    expect(d.bucket).toBe("my-bucket");
    expect(d.key).toBe("path/snap.db");
    expect(d.endpointEnvHint).toBe("AWS_ENDPOINT_URL");
  });

  it("parses r2://bucket/key with R2 endpoint hint", () => {
    const d = parseDestination("r2://b/k");
    expect(d.kind).toBe("s3");
    expect(d.endpointEnvHint).toBe("R2_ENDPOINT");
  });

  it("parses b2://bucket/key with B2 endpoint hint", () => {
    const d = parseDestination("b2://b/k");
    expect(d.kind).toBe("s3");
    expect(d.endpointEnvHint).toBe("B2_ENDPOINT");
  });
});

describe("parseBackupArgs", () => {
  it("parses --to in equals form", () => {
    const o = parseBackupArgs(["--to=/tmp/x.db"]);
    expect(o.to).toBe("/tmp/x.db");
    expect(o.gzip).toBe(false);
  });

  it("parses --to as separate token", () => {
    const o = parseBackupArgs(["--to", "/tmp/x.db"]);
    expect(o.to).toBe("/tmp/x.db");
  });

  it("parses --gzip + --quiet flags", () => {
    const o = parseBackupArgs(["--to=/tmp/x", "--gzip", "--quiet"]);
    expect(o.gzip).toBe(true);
    expect(o.quiet).toBe(true);
  });
});

describe("end-to-end: local snapshot", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "vb-backup-"));
    dbPath = join(tmpDir, "vaultbase.db");
    initDb(dbPath);
    await runMigrations();
    await getDb().insert(admin).values({
      id: "a1",
      email: "snap@test.local",
      password_hash: "x",
      password_reset_at: 0,
      created_at: Math.floor(Date.now() / 1000),
    });
  });

  afterEach(() => {
    try { closeDb(); } catch { /* ignore */ }
    // Windows can hold the file lock briefly after close — best-effort rm.
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("writes a valid SQLite file the original DB's data is in", async () => {
    const dest = join(tmpDir, "snap.db");
    closeDb();   // VACUUM INTO opens its own readonly handle; close ours first
    await runBackup(dbPath, ["--to", dest, "--quiet"]);
    expect(existsSync(dest)).toBe(true);
    // Verify by opening the snapshot and reading back the seeded row.
    const { Database } = await import("bun:sqlite");
    const snap = new Database(dest, { readonly: true });
    try {
      const row = snap.query("SELECT email FROM vaultbase_admin WHERE id = 'a1'").get() as { email: string } | null;
      expect(row?.email).toBe("snap@test.local");
    } finally { snap.close(); }
  });

  it("gzips when --gzip is passed", async () => {
    const dest = join(tmpDir, "snap.db");
    closeDb();
    await runBackup(dbPath, ["--to", dest, "--gzip", "--quiet"]);
    // The runner appends .gz when not already there.
    expect(existsSync(`${dest}.gz`)).toBe(true);
    // Magic bytes 0x1f 0x8b for gzip.
    const buf = readFileSync(`${dest}.gz`);
    expect(buf[0]).toBe(0x1f);
    expect(buf[1]).toBe(0x8b);
  });

  it("creates the destination directory if missing", async () => {
    const dest = join(tmpDir, "deep/nested/dir/snap.db");
    closeDb();
    await runBackup(dbPath, ["--to", dest, "--quiet"]);
    expect(existsSync(dest)).toBe(true);
  });

  it("errors clearly when source DB does not exist", async () => {
    closeDb();
    // Use an explicitly nonexistent path — sidesteps Windows file-lock
    // races where rm() fails to remove the live DB file.
    const ghostPath = join(tmpDir, "definitely-not-here.db");
    let caught: unknown = null;
    const origExit = process.exit;
    (process as unknown as { exit: (code?: number) => never }).exit = ((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never;
    try {
      await runBackup(ghostPath, ["--to", join(tmpDir, "x.db"), "--quiet"]);
    } catch (e) { caught = e; }
    finally { process.exit = origExit; }
    expect(String(caught)).toMatch(/source DB not found|exit:1/);
  });
});
