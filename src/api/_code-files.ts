/**
 * Shared by the hooks / routes / jobs / workers admin APIs: in files mode
 * their writes go to files in the hooks folder (see core/code-files.ts).
 */
import {
  CodeFileConflictError, CodeFileError, codeFileVersion, codeFilesDir, createCodeFile, deleteCodeFile, updateCodeFile,
  type CodeKind,
} from "../core/code-files.ts";

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
