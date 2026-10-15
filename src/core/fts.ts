/**
 * Full-text search over a collection's `searchable` fields.
 *
 * SQLite (FTS5): each base/auth collection with at least one searchable
 * field gets an external-content index `vb_<name>_fts` over `vb_<name>`,
 * keyed on the table's rowid, plus three triggers that keep it in sync.
 * Triggers (not app code) so every write path is covered: records API,
 * cascades, auth flows, admin SQL. Rowids are stable across VACUUM /
 * VACUUM INTO, so a restored snapshot's index still lines up.
 *
 * Postgres (tsvector): the table gets a generated column `vb_search`
 * (`to_tsvector('simple', …)` over the searchable columns, accents folded
 * by `vb_search_text`) and a GIN index on it. Generated, so every write path
 * is covered the same way. The indexed column list is kept as the column's
 * comment so a change of searchable fields is noticed.
 *
 * Either way `syncFts` makes the index match the fields; it rebuilds when
 * the column set changes and is idempotent, run at boot and after DDL.
 */
import { db } from "../db/index.ts";
import { flushGroupCommit } from "./group-commit.ts";

/** Field types whose stored value is plain text worth indexing. */
export const SEARCHABLE_TYPES: ReadonlySet<string> = new Set(["text", "editor", "email", "url"]);

/** The generated search column on Postgres; never a field, never emitted. */
export const SEARCH_COLUMN = "vb_search";

interface FieldLike {
  name: string;
  type: string;
  system?: boolean;
  implicit?: boolean;
  options?: { searchable?: boolean; encrypted?: boolean } | undefined;
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

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
    if (f.name === SEARCH_COLUMN) errors[f.name] = `'${f.name}' is reserved for the search index`;
    if (!f.options?.searchable) continue;
    if (!SEARCHABLE_TYPES.has(f.type)) {
      errors[f.name] = `'${f.name}': only text, editor, email and url fields can be searchable`;
    } else if (f.options.encrypted) {
      errors[f.name] = `'${f.name}': encrypted fields can't be searchable (only ciphertext is stored)`;
    }
  }
  return errors;
}

function kind(): "fts5" | "tsvector" | "none" {
  return db.capabilities.fts;
}

/** Columns of the existing index, or null when there is none. */
export async function ftsColumns(collection: string): Promise<string[] | null> {
  if (kind() === "fts5") {
    const exists = db.sync.get(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [ftsTableName(collection)]);
    if (!exists) return null;
    return db.sync.all<{ name: string }>(`PRAGMA table_info(${q(ftsTableName(collection))})`).map((r) => r.name);
  }
  if (kind() === "tsvector") {
    const row = await db.get<{ cols: string | null }>(
      `SELECT col_description(c.oid, a.attnum) AS cols
         FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE c.relnamespace = current_schema()::regnamespace AND c.relname = ? AND a.attname = ? AND NOT a.attisdropped`,
      [`vb_${collection}`, SEARCH_COLUMN],
    );
    if (!row) return null;
    return row.cols ? row.cols.split(",") : [];
  }
  return null;
}

export async function hasFts(collection: string): Promise<boolean> {
  return (await ftsColumns(collection)) !== null;
}

/** Drop the index (and its triggers). Needed before dropping an indexed column. */
export async function dropFts(collection: string): Promise<void> {
  if (kind() === "fts5") {
    for (const t of triggerNames(collection)) db.sync.exec(`DROP TRIGGER IF EXISTS ${q(t)}`);
    db.sync.exec(`DROP TABLE IF EXISTS ${q(ftsTableName(collection))}`);
  } else if (kind() === "tsvector") {
    await db.exec(`ALTER TABLE IF EXISTS ${q(`vb_${collection}`)} DROP COLUMN IF EXISTS ${SEARCH_COLUMN}`);
  }
}

/**
 * Make the index match the collection's searchable fields: drop it when
 * there are none, (re)create and rebuild it when the column set changed,
 * otherwise leave it alone.
 */
export async function syncFts(collection: string, fields: readonly FieldLike[]): Promise<void> {
  if (kind() === "none") return;
  const cols = searchableColumns(fields);
  const current = await ftsColumns(collection);
  if (cols.length === 0) {
    if (current) await dropFts(collection);
    return;
  }
  if (kind() === "tsvector") return syncTsvector(collection, cols, current);

  const [ai, ad, au] = triggerNames(collection);
  const triggersOk = () =>
    (db.sync.get(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?, ?)`, [ai, ad, au]) as { n: number }).n === 3;
  if (current && current.join("\0") === cols.join("\0") && triggersOk()) return;

  const table = q(`vb_${collection}`);
  const fts = q(ftsTableName(collection));
  const colList = cols.map(q).join(", ");
  const vals = (p: "new" | "old") => cols.map((c) => `${p}.${q(c)}`).join(", ");

  // Commit open record writes first; this schema change runs on its own,
  // synchronously, so no other write can join it.
  flushGroupCommit();
  db.sync.transaction(() => {
    for (const t of triggerNames(collection)) db.sync.exec(`DROP TRIGGER IF EXISTS ${q(t)}`);
    db.sync.exec(`DROP TABLE IF EXISTS ${fts}`);
    db.sync.exec(
      `CREATE VIRTUAL TABLE ${fts} USING fts5(${colList}, content=${table}, content_rowid='rowid', tokenize='unicode61 remove_diacritics 2')`,
    );
    db.sync.exec(
      `CREATE TRIGGER ${q(ai)} AFTER INSERT ON ${table} BEGIN
         INSERT INTO ${fts}(rowid, ${colList}) VALUES (new.rowid, ${vals("new")});
       END`,
    );
    db.sync.exec(
      `CREATE TRIGGER ${q(ad)} AFTER DELETE ON ${table} BEGIN
         INSERT INTO ${fts}(${fts}, rowid, ${colList}) VALUES ('delete', old.rowid, ${vals("old")});
       END`,
    );
    db.sync.exec(
      `CREATE TRIGGER ${q(au)} AFTER UPDATE OF ${colList} ON ${table} BEGIN
         INSERT INTO ${fts}(${fts}, rowid, ${colList}) VALUES ('delete', old.rowid, ${vals("old")});
         INSERT INTO ${fts}(rowid, ${colList}) VALUES (new.rowid, ${vals("new")});
       END`,
    );
    db.sync.exec(`INSERT INTO ${fts}(${fts}) VALUES ('rebuild')`);
  }, { immediate: false });
}

async function syncTsvector(collection: string, cols: string[], current: string[] | null): Promise<void> {
  if (current && current.join(",") === cols.join(",")) return;
  const table = q(`vb_${collection}`);
  const doc = cols.map((c) => `coalesce(${q(c)}, '')`).join(` || ' ' || `);
  await db.transaction(async () => {
    await db.exec(`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${SEARCH_COLUMN}`);
    await db.exec(
      `ALTER TABLE ${table} ADD COLUMN ${SEARCH_COLUMN} tsvector GENERATED ALWAYS AS (to_tsvector('simple', vb_search_text(${doc}))) STORED`,
    );
    await db.exec(`CREATE INDEX ${q(`idx_vb_${collection}_search`)} ON ${table} USING GIN (${SEARCH_COLUMN})`);
    await db.exec(`COMMENT ON COLUMN ${table}.${SEARCH_COLUMN} IS ${lit(cols.join(","))}`);
  });
}

/**
 * `vb_search_text(text)`: the text the Postgres index and queries see —
 * lowercased by the `simple` configuration, accents folded when the
 * `unaccent` extension is available (it is on every major provider). Run
 * once per schema at boot; IMMUTABLE so a generated column may use it.
 */
export async function ensureSearchFunction(): Promise<void> {
  if (kind() !== "tsvector") return;
  try { await db.exec(`CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA public`); } catch { /* not allowed here: no folding */ }
  const ext = await db.get<{ s: string }>(
    `SELECT n.nspname AS s FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'unaccent'`,
  );
  const body = ext
    ? `SELECT ${q(ext.s)}.unaccent(${lit(`${ext.s}.unaccent`)}::regdictionary, $1)`
    : `SELECT $1`;
  await db.exec(
    `CREATE OR REPLACE FUNCTION vb_search_text(text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ ${body} $$`,
  );
}

/** Longest search string accepted; longer input is truncated. */
export const MAX_SEARCH_LENGTH = 256;
const MAX_TERMS = 16;

function terms(input: string): string[] {
  return input
    .slice(0, MAX_SEARCH_LENGTH)
    .split(/\s+/)
    .map((t) => t.replace(/["\u0000]/g, "").trim())
    .filter((t) => t.length > 0)
    .slice(0, MAX_TERMS);
}

/**
 * Turn user input into a safe FTS5 query: every term is quoted (so FTS
 * syntax like `OR`, `NEAR`, `-` or `col:` is matched literally), terms are
 * ANDed, and the last one is a prefix match for search-as-you-type.
 * Returns null when nothing searchable is left.
 */
export function toFtsQuery(input: string): string | null {
  const t = terms(input);
  if (t.length === 0) return null;
  return t.map((x, i) => `"${x}"${i === t.length - 1 ? "*" : ""}`).join(" ");
}

/**
 * The same query for Postgres `to_tsquery`: words only (letters and
 * digits, any script), quoted, ANDed, the last a prefix. Punctuation splits
 * words the way FTS5's tokenizer does, so `-plain` searches `plain`.
 */
export function toTsQuery(input: string): string | null {
  const words = terms(input).flatMap((t) => t.split(/[^\p{L}\p{N}]+/u)).filter(Boolean);
  if (words.length === 0) return null;
  return words.map((w, i) => `'${w}'${i === words.length - 1 ? ":*" : ""}`).join(" & ");
}

/** The search query for the open driver, or null when the input has no words. */
export function searchQuery(input: string): string | null {
  return kind() === "tsvector" ? toTsQuery(input) : toFtsQuery(input);
}

/** A WHERE predicate over `tableRef` that matches the query bound to one `?`. */
export function searchPredicate(collection: string, tableRef: string): string {
  if (kind() === "tsvector") return `${tableRef}.${SEARCH_COLUMN} @@ to_tsquery('simple', vb_search_text(?))`;
  const fts = q(ftsTableName(collection));
  return `${tableRef}.rowid IN (SELECT rowid FROM ${fts} WHERE ${fts} MATCH ?)`;
}

/**
 * A ranked page: the rows of `tableRef` matching the query (first `?`),
 * filtered by `whereSql`, best first, then `LIMIT ? OFFSET ?`.
 */
export function rankedSelect(collection: string, tableRef: string, whereSql: string): string {
  if (kind() === "tsvector") {
    const where = whereSql ? `${whereSql} AND` : "WHERE";
    return `SELECT ${tableRef}.* FROM ${tableRef}, to_tsquery('simple', vb_search_text(?)) AS vb_q
         ${where} ${tableRef}.${SEARCH_COLUMN} @@ vb_q
         ORDER BY ts_rank(${tableRef}.${SEARCH_COLUMN}, vb_q) DESC, ${tableRef}."id" LIMIT ? OFFSET ?`;
  }
  const fts = q(ftsTableName(collection));
  return `SELECT ${tableRef}.* FROM ${tableRef}
         JOIN (SELECT rowid AS vb_fts_rowid, rank AS vb_fts_rank FROM ${fts} WHERE ${fts} MATCH ?) AS vb_fts
           ON vb_fts.vb_fts_rowid = ${tableRef}.rowid
         ${whereSql} ORDER BY vb_fts.vb_fts_rank LIMIT ? OFFSET ?`;
}

/** Whether `e` is the search engine refusing a query (a 400, not a 500). */
export function isSearchSyntaxError(e: unknown): boolean {
  return e instanceof Error && /fts5|tsquery/i.test(e.message);
}
