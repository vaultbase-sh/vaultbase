/**
 * Migrations swallowed every error from `ALTER TABLE … ADD COLUMN` as
 * "column exists", so a locked database or a full disk left the schema
 * half-migrated without a word. And `busy_timeout` was set after the WAL
 * switch, so a second process opening the database while another held a
 * lock failed at once with SQLITE_BUSY.
 */
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { addColumn } from "../db/migrate.ts";
import { initDb, closeDb } from "../db/client.ts";

describe("addColumn", () => {
  it("tolerates a column that already exists (legitimate path)", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (a TEXT)");
    addColumn(db, "ALTER TABLE t ADD COLUMN b TEXT");
    expect(() => addColumn(db, "ALTER TABLE t ADD COLUMN b TEXT")).not.toThrow();
  });

  it("surfaces any other failure", () => {
    const db = new Database(":memory:");
    expect(() => addColumn(db, "ALTER TABLE missing ADD COLUMN b TEXT")).toThrow(/no such table/);
    db.exec("CREATE TABLE t (a TEXT)");
    db.exec("PRAGMA query_only = 1");
    expect(() => addColumn(db, "ALTER TABLE t ADD COLUMN c TEXT")).toThrow();
  });
});

describe("opening a locked database", () => {
  it("waits for the lock instead of failing with SQLITE_BUSY", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vb-busy-"));
    const path = join(dir, "data.db");
    new Database(path, { create: true }).close();
    // Another process holds an exclusive lock for a moment.
    const holder = Bun.spawn([process.execPath, "-e", `
      const { Database } = require("bun:sqlite");
      const db = new Database(${JSON.stringify(path)});
      db.exec("BEGIN EXCLUSIVE");
      console.log("locked");
      setTimeout(() => { db.exec("COMMIT"); db.close(); }, 400);
    `], { stdout: "pipe", env: { ...process.env, BUN_BE_BUN: "1" } });
    const reader = holder.stdout.getReader();
    await reader.read(); // "locked"
    try {
      expect(() => initDb(`file:${path}`)).not.toThrow();
    } finally {
      await closeDb();
      await holder.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
