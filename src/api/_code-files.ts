/**
 * Shared by the hooks / routes / jobs / workers admin APIs: in files mode
 * their writes go to files in the hooks folder (see core/code-files.ts);
 * otherwise to their table, through the row helpers below.
 */
import { eq } from "drizzle-orm";
import {
  CodeFileConflictError, CodeFileError, codeFileVersion, codeFilesDir, createCodeFile, deleteCodeFile, updateCodeFile,
  type CodeKind,
} from "../core/code-files.ts";
import { databaseCodeError, inlineCompileError } from "../core/code-loader.ts";
import { getDb } from "../db/client.ts";
import type { hooks, jobs, routes, workers } from "../db/schema.ts";

type Set = { status?: number | string };
type Row = Record<string, unknown> & { id: string; file_path: string | null; origin?: string };

/** Add `file_version` to file-backed rows: the If-Match value for saving them. */
export function withVersion<R extends Record<string, unknown>>(row: R): R & { file_version?: string } {
  return row["origin"] === "file" ? { ...row, file_version: codeFileVersion(String(row["code"] ?? "")) } : row;
}

async function run(set: Set, fn: () => Promise<unknown>): Promise<{ data: unknown } | { error: string; code: number }> {
  try {
    return { data: await fn() };
  } catch (e) {
    if (e instanceof CodeFileConflictError) { set.status = 409; return { error: e.message, code: 409 }; }
    if (e instanceof CodeFileError) { set.status = 422; return { error: e.message, code: 422 }; }
    throw e;
  }
}

/** In files mode, create a file instead of a row. Returns null when files mode is off. */
export function createInFiles(set: Set, kind: CodeKind, columns: Record<string, unknown>, code: string) {
  if (!codeFilesDir()) return null;
  return run(set, async () => withVersion(await createCodeFile(kind, columns, code)));
}

/**
 * Update a file-backed row through its file. Returns null for rows that
 * aren't file-backed. `ifMatch` is the request's If-Match header.
 */
export function updateInFiles(set: Set, kind: CodeKind, row: Row, columns: Record<string, unknown>, code: string | undefined, ifMatch: string | null) {
  if (row.origin !== "file") return null;
  if (!codeFilesDir()) {
    set.status = 409;
    return Promise.resolve({ error: `This lives in ${row.file_path}, but the hooks folder isn't set up on this server`, code: 409 });
  }
  const expect = ifMatch ? ifMatch.replace(/^W\//, "").replace(/"/g, "") : null;
  return run(set, async () => withVersion(await updateCodeFile(kind, row, columns, code, expect)));
}

/** Delete a file-backed row's file. Returns null for rows that aren't file-backed. */
export function deleteInFiles(set: Set, row: Row) {
  if (row.origin !== "file") return null;
  if (!codeFilesDir()) {
    set.status = 409;
    return Promise.resolve({ error: `This lives in ${row.file_path}, but the hooks folder isn't set up on this server`, code: 409 });
  }
  return run(set, async () => { await deleteCodeFile(row); return null; });
}

type CodeTable = typeof hooks | typeof routes | typeof jobs | typeof workers;
type Refusal = { error: string; code: number };

/**
 * The 422 for code that doesn't compile, or can't run from the database;
 * null when it's fine. Enabling an entry checks its stored code (`stored`):
 * it may predate the check.
 */
export function codeRefusal(set: Set, code: string | undefined, stored?: string): Refusal | null {
  const bad = code !== undefined ? inlineCompileError(code) : null;
  if (bad) { set.status = 422; return { error: `Code does not compile: ${bad}`, code: 422 }; }
  const unsupported = databaseCodeError(code ?? stored ?? "");
  if (unsupported) { set.status = 422; return { error: unsupported, code: 422 }; }
  return null;
}

// The tables differ in their columns but share `id`; drizzle's builders
// don't take a union of tables, so the helpers go through one of them.
const asTable = (table: CodeTable) => table as typeof hooks;

export async function listCodeRows<T extends CodeTable>(table: T): Promise<{ data: Array<T["$inferSelect"] & { file_version?: string }> }> {
  const rows = await getDb().select().from(asTable(table));
  return { data: rows.map(withVersion) as Array<T["$inferSelect"] & { file_version?: string }> };
}

export async function findCodeRow<T extends CodeTable>(table: T, id: string): Promise<T["$inferSelect"] | undefined> {
  const t = asTable(table);
  return (await getDb().select().from(t).where(eq(t.id, id)).limit(1))[0] as T["$inferSelect"] | undefined;
}

/** Insert a row, drop the cache, and answer with the row as stored. */
export async function insertCodeRow<T extends CodeTable>(table: T, values: T["$inferInsert"], invalidate: () => void): Promise<{ data: T["$inferSelect"] | undefined }> {
  await getDb().insert(asTable(table)).values(values as typeof hooks.$inferInsert);
  invalidate();
  return { data: await findCodeRow(table, values.id) };
}

/** Update a row, drop the cache, and answer with the row as stored (404 when it's gone). */
export async function updateCodeRow<T extends CodeTable>(
  set: Set, table: T, id: string, update: Record<string, unknown>, invalidate: () => void, noun: string,
): Promise<{ data: T["$inferSelect"] } | Refusal> {
  const t = asTable(table);
  await getDb().update(t).set(update).where(eq(t.id, id));
  invalidate();
  const row = await findCodeRow(table, id);
  if (!row) { set.status = 404; return { error: `${noun} not found`, code: 404 }; }
  return { data: row };
}

/** Delete a row, through its file when it has one. */
export async function deleteCodeRow(set: Set, table: CodeTable, id: string, invalidate: () => void): Promise<unknown> {
  const current = await findCodeRow(table, id);
  const inFiles = current && deleteInFiles(set, current as Row);
  if (inFiles) return await inFiles;
  const t = asTable(table);
  await getDb().delete(t).where(eq(t.id, id));
  invalidate();
  return { data: null };
}
