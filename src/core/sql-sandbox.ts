/**
 * Per-admin SQL sandbox — in-memory snapshot of the live DB.
 *
 * Why in-memory: bun:sqlite on Windows refuses to reopen a file produced
 * by `VACUUM INTO` (SQLITE_MISUSE). `Database.deserialize(bytes, false)`
 * is the supported path, and it gives us better isolation than a file
 * copy anyway — sandbox mutations live in RAM, can never leak to disk
 * even if cleanup misfires.
 *
 * Lifecycle:
 *
 *   • One slot per admin id, kept in `_sandboxes`.
 *   • `resetSandbox()` reads the current live DB into a fresh Database
 *     handle. State lives until reset/drop/idle eviction.
 *   • `runSqlAgainstSandbox()` executes a statement against the admin's
 *     handle; mutations persist for subsequent queries.
 *   • Eviction: idle > SANDBOX_IDLE_TTL_SEC, swept hourly.
 *   • Process restart drops every sandbox — accepted, this is a dev tool.
 *
 * Browser tabs from the same admin share the slot. A DROP in tab A is
 * visible in tab B. Documented in the UI.
 */

import { Database } from "bun:sqlite";

export const SANDBOX_IDLE_TTL_SEC = 60 * 60; // 1h

interface SandboxSlot {
  db: Database;
  /** Unix-seconds the snapshot was created. */
  createdAt: number;
  /** Snapshot size in bytes (approximate — what we deserialised from). */
  sizeBytes: number;
  /** Unix-seconds of last query touch. */
  lastUsedAt: number;
}

const _sandboxes = new Map<string, SandboxSlot>();

export function sandboxExists(adminId: string): boolean {
  return _sandboxes.has(adminId);
}

export interface SandboxInfo {
  exists: boolean;
  /** Unix-seconds the snapshot was created (or 0 if missing). */
  createdAt: number;
  /** Snapshot size in bytes (or 0 if missing). */
  sizeBytes: number;
  /** Idle seconds since last query against this sandbox. */
  idleSec: number;
}

export function describeSandbox(adminId: string): SandboxInfo {
  const slot = _sandboxes.get(adminId);
  if (!slot) return { exists: false, createdAt: 0, sizeBytes: 0, idleSec: 0 };
  return {
    exists: true,
    createdAt: slot.createdAt,
    sizeBytes: slot.sizeBytes,
    idleSec: Math.floor(Date.now() / 1000) - slot.lastUsedAt,
  };
}

/**
 * Snapshot the live DB into the admin's sandbox slot. Replaces any
 * existing slot.
 *
 * Implementation: open a fresh in-memory Database, ATTACH the live DB
 * read-only, replay every schema object (tables / views / indexes /
 * triggers) by their stored CREATE statement, then `INSERT INTO main.t
 * SELECT * FROM live.t` per table.
 *
 * Why not Database.deserialize + serialize: bun:sqlite on Windows
 * cannot deserialize a snapshot taken from a WAL-mode source — both
 * VACUUM INTO + serialize() produce images the reader rejects with
 * SQLITE_CANTOPEN. The schema-replay path sidesteps that entirely and
 * has the bonus of being source-agnostic (works on any SQLite build).
 */
export function resetSandbox(adminId: string, livePath: string): SandboxInfo {
  // Drop the previous slot first so we close its handle deterministically.
  const old = _sandboxes.get(adminId);
  if (old) {
    try { old.db.close(); } catch { /* already closed */ }
    _sandboxes.delete(adminId);
  }

  const db = new Database(":memory:");
  db.exec("PRAGMA busy_timeout = 1000;");

  const escapedPath = livePath.split("\\").join("/").replace(/'/g, "''");
  db.exec(`ATTACH DATABASE '${escapedPath}' AS _vb_live`);
  let approxSize = 0;
  try {
    // Order matters — tables before indexes/views/triggers reference them.
    const objs = db.prepare(
      `SELECT type, name, sql FROM _vb_live.sqlite_master
       WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL`,
    ).all() as Array<{ type: string; name: string; sql: string }>;
    const order = ["table", "view", "index", "trigger"];
    const sorted = [...objs].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
    for (const obj of sorted) {
      try {
        db.exec(obj.sql);
        if (obj.type === "table") {
          db.exec(`INSERT INTO main."${obj.name}" SELECT * FROM _vb_live."${obj.name}"`);
        }
      } catch { /* skip objects that fail to recreate (rare, e.g. virtual tables) */ }
    }
    // Tally a rough size proxy: sum row counts × something. SQLite has no
    // bytes-per-table API; use page_count × page_size on the in-memory DB.
    const pc = db.prepare("PRAGMA page_count").get() as { page_count?: number };
    const ps = db.prepare("PRAGMA page_size").get() as { page_size?: number };
    approxSize = (pc?.page_count ?? 0) * (ps?.page_size ?? 0);
  } finally {
    db.exec("DETACH DATABASE _vb_live");
  }

  const now = Math.floor(Date.now() / 1000);
  const slot: SandboxSlot = {
    db,
    createdAt: now,
    sizeBytes: approxSize,
    lastUsedAt: now,
  };
  _sandboxes.set(adminId, slot);
  return {
    exists: true,
    createdAt: now,
    sizeBytes: approxSize,
    idleSec: 0,
  };
}

/** Get the live Database handle for an admin's sandbox, or null if unset. */
export function getSandboxDb(adminId: string): Database | null {
  const slot = _sandboxes.get(adminId);
  if (!slot) return null;
  slot.lastUsedAt = Math.floor(Date.now() / 1000);
  return slot.db;
}

export function dropSandbox(adminId: string): boolean {
  const slot = _sandboxes.get(adminId);
  if (!slot) return false;
  try { slot.db.close(); } catch { /* already closed */ }
  _sandboxes.delete(adminId);
  return true;
}

/**
 * Sweep idle sandboxes. Called by the hourly prune cron. Returns the
 * number of slots evicted.
 */
export function pruneStaleSandboxes(ttlSec: number = SANDBOX_IDLE_TTL_SEC): number {
  const cutoff = Math.floor(Date.now() / 1000) - ttlSec;
  let removed = 0;
  for (const [id, slot] of _sandboxes.entries()) {
    if (slot.lastUsedAt < cutoff) {
      try { slot.db.close(); } catch { /* already closed */ }
      _sandboxes.delete(id);
      removed++;
    }
  }
  return removed;
}

/** Test-only: drop every slot. Useful for `afterEach` hygiene. */
export function _resetSandboxRegistryForTests(): void {
  for (const [, slot] of _sandboxes.entries()) {
    try { slot.db.close(); } catch { /* already closed */ }
  }
  _sandboxes.clear();
}

/** No-op shim to keep the older API call site (server.ts) happy. */
export function setSandboxDir(_dir: string): void {
  /* sandbox is in-memory; directory is no longer used */
}
