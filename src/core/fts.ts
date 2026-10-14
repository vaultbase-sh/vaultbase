/**
 * Full-text search over a collection's `searchable` fields (SQLite FTS5).
 *
 * Each base/auth collection with at least one searchable field gets an
 * external-content index `vb_<name>_fts` over `vb_<name>`, keyed on the
 * table's rowid, plus three triggers that keep it in sync. Triggers (not
 * app code) so every write path is covered: records API, cascades, auth
 * flows, admin SQL.
 *
 * Rowids are stable across VACUUM / VACUUM INTO (tested on 3.53), so a
 * restored snapshot's index still lines up; `syncFts` rebuilds whenever the
 * index is created or its column set changes.
 */
import type { Database } from "bun:sqlite";
import { flushGroupCommit } from "./group-commit.ts";

/** Field types whose stored value is plain text worth indexing. */
export const SEARCHABLE_TYPES: ReadonlySet<string> = new Set(["text", "editor", "email", "url"]);

interface FieldLike {
  name: string;
  type: string;
  system?: boolean;
  implicit?: boolean;
  options?: { searchable?: boolean; encrypted?: boolean } | undefined;
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

export function ftsTableName(collection: string): string {
  return `vb_${collection}_fts`;
}

function triggerNames(collection: string): [string, string, string] {
  const t = ftsTableName(collection);
  return [`${t}_ai`, `${t}_ad`, `${t}_au`];
}

/** Searchable columns, in field order. */
export function searchableColumns(fields: readonly FieldLike[]): string[] {
  return fields
    .filter((f) => !f.system && !f.implicit && f.options?.searchable && SEARCHABLE_TYPES.has(f.type) && !f.options?.encrypted)
    .map((f) => f.name);
}

/** Field-level errors for `searchable` set where it can't work. */
export function searchableErrors(fields: readonly FieldLike[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    if (!f.options?.searchable) continue;
    if (!SEARCHABLE_TYPES.has(f.type)) {
      errors[f.name] = `'${f.name}': only text, editor, email and url fields can be searchable`;
    } else if (f.options.encrypted) {
      errors[f.name] = `'${f.name}': encrypted fields can't be searchable (only ciphertext is stored)`;
    }
  }
  return errors;
}

/** Columns of the existing index, or null when there is none. */
export function ftsColumns(client: Database, collection: string): string[] | null {
  const exists = client
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(ftsTableName(collection));
  if (!exists) return null;
  const rows = client.prepare(`PRAGMA table_info(${q(ftsTableName(collection))})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

export function hasFts(client: Database, collection: string): boolean {
  return ftsColumns(client, collection) !== null;
}

/** Drop the index and its triggers. Needed before dropping an indexed column. */
export function dropFts(client: Database, collection: string): void {
  for (const t of triggerNames(collection)) client.exec(`DROP TRIGGER IF EXISTS ${q(t)}`);
  client.exec(`DROP TABLE IF EXISTS ${q(ftsTableName(collection))}`);
}

/**
 * Make the index match the collection's searchable fields: drop it when
 * there are none, (re)create and rebuild it when the column set changed,
 * otherwise leave it alone. Idempotent; run at boot and after schema DDL.
 */
export function syncFts(client: Database, collection: string, fields: readonly FieldLike[]): void {
  const cols = searchableColumns(fields);
  const current = ftsColumns(client, collection);
  const [ai, ad, au] = triggerNames(collection);
  const triggersOk = () =>
    (client.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?, ?)`)
      .get(ai, ad, au) as { n: number }).n === 3;

  if (cols.length === 0) {
    if (current) dropFts(client, collection);
    return;
  }
  if (current && current.join("\0") === cols.join("\0") && triggersOk()) return;

  const table = q(`vb_${collection}`);
  const fts = q(ftsTableName(collection));
  const colList = cols.map(q).join(", ");
  const vals = (p: "new" | "old") => cols.map((c) => `${p}.${q(c)}`).join(", ");

  // Commit open record writes first; this schema change runs on its own.
  flushGroupCommit();
  client.transaction(() => {
    dropFts(client, collection);
    client.exec(
      `CREATE VIRTUAL TABLE ${fts} USING fts5(${colList}, content=${table}, content_rowid='rowid', tokenize='unicode61 remove_diacritics 2')`,
    );
    client.exec(
      `CREATE TRIGGER ${q(ai)} AFTER INSERT ON ${table} BEGIN
         INSERT INTO ${fts}(rowid, ${colList}) VALUES (new.rowid, ${vals("new")});
       END`,
    );
    client.exec(
      `CREATE TRIGGER ${q(ad)} AFTER DELETE ON ${table} BEGIN
         INSERT INTO ${fts}(${fts}, rowid, ${colList}) VALUES ('delete', old.rowid, ${vals("old")});
       END`,
    );
    client.exec(
      `CREATE TRIGGER ${q(au)} AFTER UPDATE OF ${colList} ON ${table} BEGIN
         INSERT INTO ${fts}(${fts}, rowid, ${colList}) VALUES ('delete', old.rowid, ${vals("old")});
         INSERT INTO ${fts}(rowid, ${colList}) VALUES (new.rowid, ${vals("new")});
       END`,
    );
    client.exec(`INSERT INTO ${fts}(${fts}) VALUES ('rebuild')`);
  })();
}

/** Longest search string accepted; longer input is truncated. */
export const MAX_SEARCH_LENGTH = 256;
const MAX_TERMS = 16;

/**
 * Turn user input into a safe FTS5 query: every term is quoted (so FTS
 * syntax like `OR`, `NEAR`, `-` or `col:` is matched literally), terms are
 * ANDed, and the last one is a prefix match for search-as-you-type.
 * Returns null when nothing searchable is left.
 */
export function toFtsQuery(input: string): string | null {
  const terms = input
    .slice(0, MAX_SEARCH_LENGTH)
    .split(/\s+/)
    .map((t) => t.replace(/["\u0000]/g, "").trim())
    .filter((t) => t.length > 0)
    .slice(0, MAX_TERMS);
  if (terms.length === 0) return null;
  return terms.map((t, i) => `"${t}"${i === terms.length - 1 ? "*" : ""}`).join(" ");
}
