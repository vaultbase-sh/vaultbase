/**
 * Orphaned-file cleanup.
 *
 * Nothing deletes stored files when their record or collection goes away,
 * or when a file field is pointed at a new upload. Rather than hook every
 * delete path (records API, batch, cascades, collection drops, admin SQL),
 * a periodic sweep checks each `vaultbase_files` row and removes the stored
 * object, its thumbnails and the row once the file is unreferenced:
 *
 *   - its collection no longer exists, or
 *   - its record no longer exists, or
 *   - the record's field no longer names it.
 *
 * Files younger than GRACE_SECONDS are left alone: clients upload first and
 * PATCH the record afterwards, sometimes before the record exists. Files in
 * collections with record history are kept, since restoring an old version
 * may point at them again.
 *
 * Setting `files.orphan_cleanup` = "0" turns the sweep off.
 */
import { existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { db } from "../db/index.ts";
import { getSetting } from "../api/settings.ts";
import { parseFields } from "./collections.ts";
import { deleteFile, thumbCacheDir } from "./storage.ts";
import { forgetThumbVariants } from "./image.ts";
import { maintenanceOn } from "./maintenance-mode.ts";

export const GRACE_SECONDS = 24 * 60 * 60;
const BATCH = 500;

interface FileRow { id: string; collection_id: string; record_id: string; field_name: string; filename: string }
interface ColRow { id: string; name: string; type: string; fields: string; history_enabled: number }

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * The thumbnail cache by source file (`<filename>__<spec>`), listed once per
 * sweep: listing the whole folder for every deleted file was a full scan of
 * it per orphan.
 */
function thumbIndex(): Map<string, string[]> {
  const dir = thumbCacheDir();
  const index = new Map<string, string[]>();
  if (!existsSync(dir)) return index;
  for (const name of readdirSync(dir)) {
    const cut = name.indexOf("__");
    if (cut <= 0) continue;
    const source = name.slice(0, cut);
    let list = index.get(source);
    if (!list) { list = []; index.set(source, list); }
    list.push(name);
  }
  return index;
}

function deleteThumbs(filename: string, index: Map<string, string[]>): void {
  forgetThumbVariants(filename);
  const dir = thumbCacheDir();
  for (const name of index.get(filename) ?? []) {
    try { unlinkSync(join(dir, name)); } catch { /* gone */ }
  }
  index.delete(filename);
}

/** True when the stored field value still names `filename`. */
function references(value: unknown, filename: string): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (value === filename) return true;
  if (typeof value === "string" && value.startsWith("[")) {
    try {
      const arr = JSON.parse(value) as unknown;
      return Array.isArray(arr) && arr.includes(filename);
    } catch { return false; }
  }
  return false;
}

export interface SweepResult { checked: number; deleted: number; errors: number }

export async function sweepOrphanFiles(nowSec = Math.floor(Date.now() / 1000)): Promise<SweepResult> {
  const result: SweepResult = { checked: 0, deleted: 0, errors: 0 };
  if (getSetting("files.orphan_cleanup", "1") !== "1") return result;
  const cols = new Map(
    (await db.all<ColRow>(`SELECT id, name, type, fields, history_enabled FROM vaultbase_collections`))
      .map((c) => [c.id, c]),
  );
  const cutoff = nowSec - GRACE_SECONDS;
  // Field names per collection, parsed once (not per file).
  const fieldNames = new Map<string, Set<string>>();
  const fieldsOf = (col: ColRow) => {
    let names = fieldNames.get(col.id);
    if (!names) { names = new Set(parseFields(col.fields).map((x) => x.name)); fieldNames.set(col.id, names); }
    return names;
  };
  let thumbs: Map<string, string[]> | null = null;
  let after = "";
  for (;;) {
    const rows = await db.all<FileRow>(
      `SELECT id, collection_id, record_id, field_name, filename FROM vaultbase_files
                 WHERE created_at < ? AND id > ? ORDER BY id LIMIT ?`,
      [cutoff, after, BATCH],
    );
    if (rows.length === 0) break;
    after = rows[rows.length - 1]!.id;
    // The records these files belong to: one query per collection and field
    // in this batch, instead of one per file (100,000 files meant 100,000
    // queries an hour, on every server).
    const values = new Map<string, Map<string, unknown> | null>();
    const groups = new Map<string, { col: ColRow; field: string; ids: Set<string> }>();
    for (const f of rows) {
      const col = cols.get(f.collection_id);
      if (!col || col.history_enabled === 1 || col.type === "view" || !fieldsOf(col).has(f.field_name)) continue;
      const key = `${col.id}\u0000${f.field_name}`;
      let g = groups.get(key);
      if (!g) { g = { col, field: f.field_name, ids: new Set() }; groups.set(key, g); }
      g.ids.add(f.record_id);
    }
    for (const [key, g] of groups) {
      const ids = [...g.ids];
      try {
        const found = await db.all<{ id: string; v: unknown }>(
          `SELECT id, ${q(g.field)} AS v FROM ${q(`vb_${g.col.name}`)} WHERE id IN (${ids.map(() => "?").join(", ")})`, ids);
        values.set(key, new Map(found.map((r) => [r.id, r.v])));
      } catch {
        values.set(key, null); // table or column in flux; try again next sweep
      }
    }
    for (const f of rows) {
      result.checked++;
      const col = cols.get(f.collection_id);
      let orphan = false;
      if (!col) {
        orphan = true;
      } else if (col.history_enabled === 1 || col.type === "view") {
        continue;
      } else {
        if (!fieldsOf(col).has(f.field_name)) {
          orphan = true;
        } else {
          const records = values.get(`${col.id}\u0000${f.field_name}`);
          if (!records) continue; // the query failed: next sweep
          orphan = !records.has(f.record_id) || !references(records.get(f.record_id), f.filename);
        }
      }
      if (!orphan) continue;
      try {
        await deleteFile(f.filename);
        deleteThumbs(f.filename, thumbs ??= thumbIndex());
        await db.run(`DELETE FROM vaultbase_files WHERE id = ?`, [f.id]);
        result.deleted++;
      } catch (e) {
        result.errors++;
        console.error(`[files] cleanup of ${f.filename} failed:`, e instanceof Error ? e.message : e);
      }
    }
  }
  return result;
}

let ticker: ReturnType<typeof setInterval> | null = null;

/** Hourly sweep, first run 15 minutes after boot. */
export function startOrphanFileSweeper(): void {
  if (ticker) return;
  const run = () => {
    // Not during maintenance mode, whatever it says about background work:
    // a migration can drop a file's reference for a while.
    if (maintenanceOn()) return;
    void sweepOrphanFiles()
      .then((r) => { if (r.deleted > 0) console.log(`[files] removed ${r.deleted} orphaned file(s)`); })
      .catch((e) => console.error("[files] orphan sweep failed:", e instanceof Error ? e.message : e));
  };
  setTimeout(run, 15 * 60 * 1000).unref?.();
  ticker = setInterval(run, 60 * 60 * 1000);
  ticker.unref?.();
}
