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

export const GRACE_SECONDS = 24 * 60 * 60;
const BATCH = 500;

interface FileRow { id: string; collection_id: string; record_id: string; field_name: string; filename: string }
interface ColRow { id: string; name: string; type: string; fields: string; history_enabled: number }

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

function deleteThumbs(filename: string): void {
  const dir = thumbCacheDir();
  forgetThumbVariants(filename);
  if (!existsSync(dir)) return;
  const prefix = `${filename}__`;
  for (const name of readdirSync(dir)) {
    if (name.startsWith(prefix)) {
      try { unlinkSync(join(dir, name)); } catch { /* gone */ }
    }
  }
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
  let after = "";
  for (;;) {
    const rows = await db.all<FileRow>(
      `SELECT id, collection_id, record_id, field_name, filename FROM vaultbase_files
                 WHERE created_at < ? AND id > ? ORDER BY id LIMIT ?`,
      [cutoff, after, BATCH],
    );
    if (rows.length === 0) break;
    after = rows[rows.length - 1]!.id;
    for (const f of rows) {
      result.checked++;
      const col = cols.get(f.collection_id);
      let orphan = false;
      if (!col) {
        orphan = true;
      } else if (col.history_enabled === 1 || col.type === "view") {
        continue;
      } else {
        const hasField = parseFields(col.fields).some((x) => x.name === f.field_name);
        if (!hasField) {
          orphan = true;
        } else {
          let row: Record<string, unknown> | null;
          try {
            row = await db.get<Record<string, unknown>>(`SELECT ${q(f.field_name)} AS v FROM ${q(`vb_${col.name}`)} WHERE id = ?`, [f.record_id]);
          } catch {
            continue; // table or column in flux; try again next sweep
          }
          orphan = !row || !references(row["v"], f.filename);
        }
      }
      if (!orphan) continue;
      try {
        await deleteFile(f.filename);
        deleteThumbs(f.filename);
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
    void sweepOrphanFiles()
      .then((r) => { if (r.deleted > 0) console.log(`[files] removed ${r.deleted} orphaned file(s)`); })
      .catch((e) => console.error("[files] orphan sweep failed:", e instanceof Error ? e.message : e));
  };
  setTimeout(run, 15 * 60 * 1000).unref?.();
  ticker = setInterval(run, 60 * 60 * 1000);
  ticker.unref?.();
}
