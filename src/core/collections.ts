import { broadcast } from "./thread-bus.ts";
import { eq, or } from "drizzle-orm";
import { gateMode, withExclusiveWrite } from "./write-gate.ts";
import { getDb, onCloseDb } from "../db/client.ts";
import { db, getDriver, type DbDriver } from "../db/index.ts";
import type { ColumnSpec } from "../db/ddl.ts";
import { scanSql } from "./sql-scan.ts";
import { collections, type Collection, type NewCollection } from "../db/schema.ts";
import { dropFts, ftsColumns, searchableErrors, syncFts, SEARCH_COLUMN } from "./fts.ts";
import { parseThumbSpec } from "./image.ts";
import { customFieldType, isKnownFieldType } from "./field-types.ts";

export type BuiltinFieldType =
  | "text" | "number" | "bool" | "file" | "relation"
  | "select" | "autodate" | "email" | "url" | "date" | "json"
  | "password" | "editor" | "geoPoint" | "vector" | "color";

/** A built-in type, or one an extension registered (see field-types.ts). */
export type FieldType = BuiltinFieldType | (string & {});

export interface FieldOptions {
  min?: number;
  max?: number;
  pattern?: string;
  unique?: boolean;
  values?: string[];
  multiple?: boolean;
  maxSize?: number;
  mimeTypes?: string[];
  /** Encrypt at rest (text/json types only). Requires VAULTBASE_ENCRYPTION_KEY. */
  encrypted?: boolean;
  /**
   * Relation-only. Behavior when the referenced target record is deleted:
   *   - "setNull"  (default): clear the foreign key column
   *   - "cascade": delete the referencing record (recursively)
   *   - "restrict": refuse the delete with 409 while references exist
   */
  cascade?: "setNull" | "cascade" | "restrict";
  /**
   * File-only. When true, GET /api/v1/files/:filename requires a `?token=`
   * query param signed by an admin via POST .../token.
   */
  protected?: boolean;
  /**
   * File-only. Per-field download rule, evaluated AND-combined with the parent
   * collection's `view_rule`.
   *   - `null`/undefined → inherit collection.view_rule (default; no change)
   *   - `""`            → admin-only (override collection rule)
   *   - any expression  → evaluated with the same engine as collection rules,
   *                       with extra `@file.*` and `@request.ip` operands.
   */
  viewRule?: string | null;
  /**
   * File-only. When true, even fully-public collections require an
   * authenticated principal to fetch the file. Combines AND with `viewRule`.
   */
  requireAuth?: boolean;
  /**
   * File-only. When true, the issued download token is single-use — the second
   * request bearing the same JWT is rejected (HTTP 410 Gone).
   */
  oneTimeToken?: boolean;
  /**
   * File-only. When true, the download token's JWT carries the requesting
   * client's IP. Subsequent fetches from a different IP are rejected.
   * Incompatible with mobile-NAT users — opt-in.
   */
  bindTokenIp?: boolean;
  /**
   * File-only. When true, every successful download emits a `files.download`
   * row to `vaultbase_audit_log` (filename + collection + record + actor).
   */
  auditDownloads?: boolean;
  /**
   * Vector-only. Number of dimensions in the embedding (1-4096). All values
   * stored under a vector field must be numeric arrays of exactly this length;
   * shorter / longer arrays fail validation.
   */
  dimensions?: number;
  /**
   * Color-only. Also accept an alpha channel (`#rgba` / `#rrggbbaa`); the
   * value is then stored as `#rrggbbaa`. Default: `#rrggbb` only.
   */
  alpha?: boolean;
  /**
   * text / editor / email / url. Include the field in the collection's
   * full-text index, queried with `?search=` on the list endpoint. Not
   * allowed together with `encrypted`.
   */
  searchable?: boolean;
  /**
   * File-only. Thumbnail sizes (`WxH`, `WxH_cover`, `400x0`, ...) non-admin
   * callers may request. Other sizes get the original file. When unset any
   * size is allowed, up to a per-file cap on generated variants.
   */
  thumbs?: string[];
}

export type CascadeMode = NonNullable<FieldOptions["cascade"]>;

export type CollectionType = "base" | "auth" | "singleton";

/**
 * User-defined fields on `auth` collections cannot use these names — they are
 * reserved for the implicit auth schema (stored in `vaultbase_users` and
 * surfaced via the auth endpoints). Implicit-flagged entries with these names
 * are allowed since they represent the schema's own customization slot.
 */
export const AUTH_RESERVED_FIELD_NAMES = [
  "email",
  "password",
  "verified",
  "tokenKey",
  "password_hash",
  "email_verified",
] as const;

/**
 * Implicit fields on auth collections — surfaced in the schema editor so admins
 * can customize their validation, but stored on `vaultbase_users` rather than
 * the per-collection table. Order matches admin display order.
 */
export const AUTH_IMPLICIT_FIELDS: FieldDef[] = [
  { name: "email",    type: "email", required: true, implicit: true, options: { unique: true } },
  { name: "verified", type: "bool",  required: false, implicit: true },
];

/** Names of auth implicit fields, for quick membership checks. */
export const AUTH_IMPLICIT_FIELD_NAMES = new Set<string>(AUTH_IMPLICIT_FIELDS.map((f) => f.name));

export interface FieldDef {
  name: string;
  type: FieldType;
  required?: boolean;
  system?: boolean;
  /** Auth-collection-only: managed by the implicit auth schema (email, verified). Storage lives in vaultbase_users; this entry exists so options can be customized. */
  implicit?: boolean;
  collection?: string;
  options?: FieldOptions;
  onCreate?: boolean;
  onUpdate?: boolean;
  /**
   * The field's previous name, when an update renames it. The column is
   * renamed in place and keeps its data; without it a new name is a drop
   * plus an add. Never stored: stripped before the fields JSON is saved.
   */
  renamedFrom?: string;
}

const cache = new Map<string, Collection>();

/**
 * The column list of a collection's table. It is read on every list
 * request (filterableColumns in records.ts), so the answer is kept per
 * driver and schema token: any DDL moves the token and refreshes it, and a
 * reopened database (tests, restore) never sees the previous connection's
 * columns. `getCollection` fills it when a collection enters the cache
 * ({@link loadTableColumns}); on SQLite a cold read fills it synchronously.
 * Callers only read the array.
 */
const columnsCache = new Map<string, { driver: DbDriver; token: number; cols: string[] }>();

function columnsSql(collectionName: string): string {
  return db.dialect.listColumnsSql(userTableName(collectionName));
}

function rememberColumns(collectionName: string, driver: DbDriver, token: number, rows: Array<{ name: string }>): string[] {
  const cols = rows.map((r) => r.name).filter((n) => n !== SEARCH_COLUMN);
  columnsCache.set(collectionName, { driver, token, cols });
  return cols;
}

export function tableColumns(collectionName: string): string[] {
  const driver = getDriver();
  const token = db.schemaToken();
  const hit = columnsCache.get(collectionName);
  if (hit && hit.driver === driver && hit.token === token) return hit.cols;
  return rememberColumns(collectionName, driver, token, db.sync.all<{ name: string }>(columnsSql(collectionName)));
}

/** Fill the column cache for a collection without blocking: the warm path for every driver. */
export async function loadTableColumns(collectionName: string, token = db.schemaToken()): Promise<string[]> {
  const driver = getDriver();
  const hit = columnsCache.get(collectionName);
  if (hit && hit.driver === driver && hit.token === token) return hit.cols;
  return rememberColumns(collectionName, driver, token, await db.all<{ name: string }>(columnsSql(collectionName)));
}

/** Forget cached columns; closeDb calls it, tests may too. */
export function invalidateUserTableColumnCache(collectionName?: string): void {
  if (collectionName === undefined) columnsCache.clear();
  else columnsCache.delete(collectionName);
}
onCloseDb(() => invalidateUserTableColumnCache());

/**
 * Synchronous accessor used by hot-path consumers (rule SQL compiler) that
 * cannot await. Returns `null` if the collection isn't already cached;
 * callers fall through to whatever conservative behavior they prefer in the
 * cold-cache case. Async `getCollection` warms this cache on every read.
 */
export function getCollectionCached(nameOrId: string): Collection | null {
  return cache.get(nameOrId) ?? null;
}

/**
 * Lazy-imported drop of the records-layer prepared-statement cache so a
 * schema change doesn't keep returning rows from a stale plan. Lazy because
 * `core/collections.ts` is loaded before `core/records.ts`.
 */
async function clearPreparedStatementsOnSchemaChange(): Promise<void> {
  try {
    const mod = await import("./records.ts");
    mod.invalidatePreparedStatements?.();
  } catch { /* records module not loaded yet — nothing to clear */ }
}

/** Reset the in-memory collection cache. Exported for tests + DB-reset hooks. */
/**
 * Bumped on every schema change made in this process; lets derived caches
 * (e.g. the incoming-relation map in records.ts) know to rebuild.
 */
let schemaVersion = 0;
export function getSchemaVersion(): number {
  return schemaVersion;
}

export function _resetCollectionCache(): void {
  schemaVersion++;
  cache.clear();
  broadcast({ type: "bus", kind: "collections" });
  sensitiveCache = null;
  // Schema mutated — drop cached prepared statements (their SQL embeds table
  // / column names that may have changed).
  void clearPreparedStatementsOnSchemaChange();
}
onCloseDb(_resetCollectionCache);

/**
 * Parse a collection's `fields` column. Defensive: every records-API request
 * passes through this — a single corrupted DB row would otherwise 500 every
 * subsequent call to that collection. Returns `[]` on parse failure and logs
 * once so operators can find + repair the bad row.
 */
export function parseFields(raw: string): FieldDef[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as FieldDef[]) : [];
  } catch (e) {
    console.error(`[parseFields] malformed JSON in collection.fields — treating as empty: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * `parseFields` for read paths: the same `fields` JSON gives the same array
 * back, parsed once. Every list and get parsed it three times over. The
 * result is frozen (array, fields and their options), so a caller that
 * modifies it throws instead of corrupting the shared copy; writers keep
 * using `parseFields`.
 */
const FIELDS_CACHE_MAX = 256;
const fieldsCache = new Map<string, FieldDef[]>();

export function cachedFields(raw: string): FieldDef[] {
  const hit = fieldsCache.get(raw);
  if (hit) return hit;
  const fields = parseFields(raw);
  for (const f of fields) {
    if (f.options && typeof f.options === "object") Object.freeze(f.options);
    Object.freeze(f);
  }
  Object.freeze(fields);
  if (fieldsCache.size >= FIELDS_CACHE_MAX) {
    const oldest = fieldsCache.keys().next().value;
    if (oldest !== undefined) fieldsCache.delete(oldest);
  }
  fieldsCache.set(raw, fields);
  return fields;
}

// ── Table naming ────────────────────────────────────────────────────────────
/** User collections live in tables named `vb_<name>` to avoid colliding with internal `vaultbase_*` tables. */
/**
 * Columns on an auth collection that must never be exposed in a response or
 * referenced from a filter expression.
 *
 * Output-stripping alone is not enough: a filter like
 * `password_hash > "$argon2id$...M"` never returns the column, but the row
 * count tells the caller whether the comparison held, so the hash can be
 * binary-searched one character at a time. The same applies to TOTP secrets.
 */
export const AUTH_PRIVATE_COLUMNS: ReadonlySet<string> = new Set([
  "password_hash",
  "totp_secret",
  "password_reset_at",
]);

/**
 * Every column on `col` that is off-limits to both output and filters: the
 * auth secrets above, plus any user-declared `password` field on any
 * collection type.
 */
const PRIVATE_CACHE_MAX = 256;
const privateCache = new Map<string, ReadonlySet<string>>();

export function privateFieldNames(col: Pick<Collection, "type" | "fields">): ReadonlySet<string> {
  // Views depend on sensitiveSchema(), which is cached per schema token.
  const cacheKey = col.type === "view" ? null : `${col.type}\u0000${col.fields}`;
  if (cacheKey !== null) {
    const hit = privateCache.get(cacheKey);
    if (hit) return hit;
  }
  const out = new Set<string>();
  // Views too: a view over an auth table (`SELECT * FROM vb_users`) carries
  // the same columns under the same names, and `SELECT *` over a collection
  // with a password field carries that field.
  if (col.type === "auth" || col.type === "view") for (const c of AUTH_PRIVATE_COLUMNS) out.add(c);
  if (col.type === "view") for (const f of sensitiveSchema().passwordFields) out.add(f);
  try {
    for (const f of cachedFields(col.fields)) {
      if (f.type === "password") out.add(f.name);
    }
  } catch {
    // Unparseable schema — the auth secrets above still apply.
  }
  if (cacheKey !== null) {
    if (privateCache.size >= PRIVATE_CACHE_MAX) {
      const oldest = privateCache.keys().next().value;
      if (oldest !== undefined) privateCache.delete(oldest);
    }
    privateCache.set(cacheKey, out);
  }
  return out;
}

export function userTableName(collectionName: string): string {
  return `vb_${collectionName}`;
}

/** Map a field type to its SQLite storage type. */
export function colSqlType(type: FieldType): string {
  switch (type) {
    case "number":   return "REAL";
    case "bool":     return "INTEGER";
    case "date":
    case "autodate": return "INTEGER";
    default:         return customFieldType(type)?.sqlType ?? "TEXT";
  }
}

/** SQLite identifier quoting that escapes embedded `"` (DDL-safe). */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Identifier shape allowed for collection / field / table names. */
const SQL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export function assertSqlIdent(name: string, kind: string): void {
  if (!SQL_IDENT_RE.test(name)) {
    throw new Error(`invalid ${kind} name '${name}' — must match ${SQL_IDENT_RE}`);
  }
}

/** The column a field is stored in, for the dialect's DDL. */
function fieldColumn(field: FieldDef): ColumnSpec {
  return {
    name: quoteIdent(field.name),
    type: colSqlType(field.type).toLowerCase() as ColumnSpec["type"],
    primaryKey: false,
    notNull: !!field.required,
    unique: !!field.options?.unique,
  };
}

/** Create the per-collection user table. */
export async function createUserTable(collectionName: string, fields: FieldDef[]): Promise<void> {
  assertSqlIdent(collectionName, "collection");
  for (const f of fields) if (!f.system) assertSqlIdent(f.name, "field");
  assertFieldOptions(fields, []);
  const tname = quoteIdent(userTableName(collectionName));
  const cols: ColumnSpec[] = [
    { name: `"id"`, type: "text", primaryKey: true, notNull: true, unique: false },
    ...fields.filter((f) => !f.system).map(fieldColumn),
    { name: `"created_at"`, type: "integer", primaryKey: false, notNull: true, unique: false, default: { kind: "epochNow" } },
    { name: `"updated_at"`, type: "integer", primaryKey: false, notNull: true, unique: false, default: { kind: "epochNow" } },
  ];
  await db.exec(db.dialect.createTable(tname, cols));
  await ensureTimestampIndexes(collectionName);
  await syncFts(collectionName, fields);
}

/**
 * `previous` is the schema being replaced: a field that already had its type
 * keeps it even if that type is no longer registered (its extension was
 * removed), so the rest of the collection can still be edited.
 */
/**
 * Names records already carry: the system columns and the meta keys the API
 * adds. A field by one of these names collided with a column (`created_at`:
 * the table couldn't be made) or replaced a value in every record (`created`).
 */
const RESERVED_FIELD_NAMES = new Set(["id", "created", "updated", "created_at", "updated_at", "collectionId", "collectionName", "expand"]);

function assertFieldOptions(fields: FieldDef[], previous: FieldDef[]): void {
  const errors = searchableErrors(fields);
  for (const f of fields) {
    if (!f.system && RESERVED_FIELD_NAMES.has(f.name)) errors[f.name] = `'${f.name}' is reserved: every record already has it`;
  }
  const before = new Map(previous.map((f) => [f.name, f.type]));
  for (const f of fields) {
    if (f.system || isKnownFieldType(f.type) || before.get(f.name) === f.type) continue;
    errors[f.name] = `'${f.name}': unknown field type '${String(f.type)}'`;
  }
  for (const f of fields) {
    const thumbs = f.options?.thumbs;
    if (thumbs === undefined) continue;
    if (f.type !== "file" || !Array.isArray(thumbs)) {
      errors[f.name] = `'${f.name}': thumbs is a list of sizes on file fields`;
      continue;
    }
    const bad = thumbs.filter((t) => typeof t !== "string" || !parseThumbSpec(t));
    if (bad.length > 0) errors[f.name] = `'${f.name}': invalid thumb size ${bad.map((b) => JSON.stringify(b)).join(", ")} (use WxH, WxH_cover, 400x0)`;
  }
  if (Object.keys(errors).length > 0) throw new CollectionValidationError(errors);
}

/**
 * created_at / updated_at indexes for a record table. The default list sort
 * is -created_at; without them every page is a full scan + temp B-tree.
 * Idempotent; also run at boot for tables created before this existed.
 */
export async function ensureTimestampIndexes(collectionName: string): Promise<void> {
  const table = userTableName(collectionName);
  for (const col of ["created_at", "updated_at"]) {
    await db.exec(db.dialect.createIndex({ name: quoteIdent(`idx_${table}_${col}`), table: quoteIdent(table), columns: [quoteIdent(col), ...db.dialect.indexTail] }));
  }
}

/** Drop the per-collection user table. */
export async function dropUserTable(collectionName: string): Promise<void> {
  assertSqlIdent(collectionName, "collection");
  const tname = quoteIdent(userTableName(collectionName));
  await dropFts(collectionName);
  await db.exec(`DROP TABLE IF EXISTS ${tname}`);
}

/**
 * Auth-only columns added to every auth collection's `vb_<name>` table —
 * uniform across collections, managed by the auth flow. Defined once here so
 * the schema migration + collection-creation paths emit identical DDL.
 *
 * v0.11 promotes auth users to per-collection real tables (was a shared
 * `vaultbase_users` keyed by collection_id). These columns are the auth
 * surface that flows into every `vb_<auth-col>`.
 */
const flag = (name: string): ColumnSpec => ({ name, type: "integer", primaryKey: false, notNull: true, unique: false, default: { kind: "literal", value: 0 } });
const str = (name: string): ColumnSpec => ({ name, type: "text", primaryKey: false, notNull: false, unique: false });
export const AUTH_SYSTEM_COLUMNS: ReadonlyArray<ColumnSpec> = [
  str("email"),
  str("password_hash"),
  flag("email_verified"),
  str("totp_secret"),
  flag("totp_enabled"),
  flag("is_anonymous"),
  flag("password_reset_at"),
];

/**
 * Idempotent: ensure every auth column exists on `vb_<name>`. ALTER TABLE
 * ADD COLUMN throws if the column already exists; we swallow that.
 *
 * Called from createCollection (for fresh auth collections) and from the
 * boot migration (for upgraded installs). Symmetric on both paths.
 */
export async function ensureAuthColumns(collectionName: string): Promise<void> {
  assertSqlIdent(collectionName, "collection");
  const tname = quoteIdent(userTableName(collectionName));
  for (const c of AUTH_SYSTEM_COLUMNS) {
    try {
      await db.exec(db.dialect.addColumn(tname, { ...c, name: quoteIdent(c.name) }));
    } catch { /* column exists — idempotent */ }
  }
  // Unique email index — anonymous users get a synthetic uniqe email so the
  // unconditional UNIQUE works without a partial-index workaround.
  try {
    await db.exec(db.dialect.createIndex({ name: `"idx_${userTableName(collectionName)}_email"`, table: tname, columns: ["email"], unique: true }));
  } catch { /* may already exist or fail on duplicates pre-migration */ }
}

// ── View collections ────────────────────────────────────────────────────────

/**
 * Validate that a view query is a single SELECT — no semicolons, no DML/DDL
 * verbs, no PRAGMA. Admin-supplied so this is a guard against silly mistakes
 * and obvious abuse, not a sandbox: a sufficiently determined admin can still
 * read sensitive tables in their SELECT and that's their responsibility.
 */
const VIEW_BANNED_WORDS = new Set([
  "INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", "ATTACH", "DETACH", "PRAGMA",
  "REPLACE", "TRUNCATE", "VACUUM", "REINDEX", "LOAD_EXTENSION", "WITH", "RECURSIVE",
]);

export function validateViewQuery(query: string): void {
  const q = query.trim();
  if (!q) throw new Error("View query is empty");
  // One scanner pass that knows strings, quoted identifiers and comments.
  // Stripping comments with a regex first let a `'--'` inside a string hide
  // the rest of the line from every check below.
  const { words, identifiers, statements } = scanSql(q);
  if (statements !== 1) throw new Error("View query must be a single statement");
  if (words[0] !== "SELECT") throw new Error("View query must begin with SELECT");
  if (words.some((w) => VIEW_BANNED_WORDS.has(w))) throw new Error("View query may only SELECT");
  // The table-valued `pragma_*()` functions and the `sqlite_*` metadata
  // tables disclose the schema and the DB's absolute file path to anyone who
  // can read the resulting view. No legitimate view references them.
  const names = [...words, ...identifiers];
  if (names.some((w) => w.startsWith("PRAGMA_") || w.startsWith("SQLITE_"))) {
    throw new Error("View query may not reference SQLite metadata");
  }
  // Auth secrets and password-type fields can't be selected by name (or
  // renamed with AS). `SELECT *` keeps their names, and those are stripped
  // from view rows and filters.
  const sensitive = sensitiveSchema();
  if (names.some((w) => AUTH_PRIVATE_COLUMNS.has(w.toLowerCase()) || sensitive.passwordFields.has(w.toLowerCase()))) {
    throw new Error("View query may not read password hashes, TOTP secrets, password_reset_at or password fields");
  }
  // A compound SELECT takes its column names from its first part, so
  // `SELECT 1 AS a, … UNION SELECT * FROM vb_users` renames the secrets by
  // position, past the name check above.
  if (words.some((w) => w === "UNION" || w === "INTERSECT" || w === "EXCEPT") &&
      [...words, ...identifiers].some((w) => sensitive.tables.has(w.toLowerCase()))) {
    throw new Error("View query may not combine (UNION / INTERSECT / EXCEPT) results from tables with private columns");
  }
}

/**
 * Names the view check treats as private: every password-type field of any
 * collection, and the tables that hold private columns — auth collections,
 * collections with a password field, and (transitively) views that read
 * from either, so `UNION` through an intermediate view is caught too. Read
 * straight from the collections table so the check stays synchronous;
 * cached for a moment because row output consults it.
 */
type SensitiveSchema = { passwordFields: Set<string>; tables: Set<string> };
type CollectionShapeRow = { name: string; type: string; fields: string; view_query: string | null };
const SENSITIVE_SQL = "SELECT name, type, fields, view_query FROM vaultbase_collections";
let sensitiveCache: { driver: DbDriver; token: number; value: SensitiveSchema } | null = null;

function sensitiveFresh(token = db.schemaToken()): SensitiveSchema | null {
  if (!sensitiveCache) return null;
  if (sensitiveCache.driver !== getDriver() || sensitiveCache.token !== token) return null;
  return sensitiveCache.value;
}

/**
 * The map the request path reads synchronously (view rows, private fields
 * of views). Schema changes in this process and on the bus drop it; a
 * schema change by another connection moves the token. `getCollection`
 * fills it ({@link loadSensitiveSchema}); on SQLite a cold read fills it
 * synchronously.
 */
export function sensitiveSchema(): SensitiveSchema {
  const fresh = sensitiveFresh();
  if (fresh) return fresh;
  let rows: CollectionShapeRow[] = [];
  try {
    rows = db.sync.all<CollectionShapeRow>(SENSITIVE_SQL);
  } catch { /* no collections table yet */ }
  return rememberSensitive(rows);
}

/** Fill the sensitive-schema map without blocking: the warm path for every driver. */
export async function loadSensitiveSchema(token = db.schemaToken()): Promise<SensitiveSchema> {
  const fresh = sensitiveFresh(token);
  if (fresh) return fresh;
  let rows: CollectionShapeRow[] = [];
  try {
    rows = await db.all<CollectionShapeRow>(SENSITIVE_SQL);
  } catch { /* no collections table yet */ }
  return rememberSensitive(rows);
}

function rememberSensitive(rows: CollectionShapeRow[]): SensitiveSchema {
  const driver = getDriver();
  const token = db.schemaToken();
  const passwordFields = new Set<string>();
  const tables = new Set<string>();
  for (const r of rows) {
    let hasPassword = false;
    try {
      for (const f of parseFields(r.fields)) {
        if (f.type === "password") { passwordFields.add(f.name.toLowerCase()); hasPassword = true; }
      }
    } catch { /* unparseable: treat by type only */ }
    if (r.type === "auth" || hasPassword) tables.add(userTableName(r.name).toLowerCase());
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const r of rows) {
      const t = userTableName(r.name).toLowerCase();
      if (r.type !== "view" || !r.view_query || tables.has(t)) continue;
      const { words, identifiers } = scanSql(r.view_query);
      if ([...words, ...identifiers].some((w) => tables.has(w.toLowerCase()))) { tables.add(t); changed = true; }
    }
  }
  const value = { passwordFields, tables };
  sensitiveCache = { driver, token, value };
  return value;
}

/** Drop the cached sensitive-schema answer (schema changed). */
export function invalidateSensitiveSchema(): void {
  sensitiveCache = null;
}

/**
 * A view row column name as SQLite reports it: a name repeated in the
 * select list (a join over two auth rows) comes back as `name:1`, `name:2`.
 */
export function baseColumnName(name: string): string {
  return name.replace(/:\d+$/, "");
}

/** Run the query with LIMIT 0 to extract column names without fetching rows. */
export async function inferViewColumns(query: string): Promise<string[]> {
  const body = query.trim().replace(/;\s*$/, "");
  const wrapped = `SELECT * FROM (${body}) LIMIT 0`;
  return await db.describe(wrapped);
}

/**
 * Run the view query with a LIMIT clause and return the resulting rows.
 * Wrapping in a subquery preserves whatever ORDER BY / LIMIT the admin wrote
 * (their own clamps stack with ours). Rows are returned as plain objects keyed
 * by column name — useful for the admin UI's "preview rows" button.
 */
export async function previewViewRows(query: string, limit = 5): Promise<{ columns: string[]; rows: Array<Record<string, unknown>> }> {
  validateViewQuery(query);
  const body = query.trim().replace(/;\s*$/, "");
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const wrapped = `SELECT * FROM (${body}) LIMIT ${safeLimit}`;
  const columns = await db.describe(wrapped);
  const rows = await db.all<Record<string, unknown>>(wrapped);
  return { columns, rows };
}

/** Build default text-typed field defs from inferred column names. id/created/updated remain implicit. */
export function fieldsFromViewColumns(columns: string[]): FieldDef[] {
  return columns
    // id/created/updated are surfaced via record meta, not as user fields
    .filter((c) => c !== "id" && c !== "created" && c !== "created_at" && c !== "updated" && c !== "updated_at")
    .map((c) => ({ name: c, type: "text" as const, required: false }));
}

const VIEW_META_COLUMNS = new Set(["id", "created", "created_at", "updated", "updated_at"]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const URL_RE = /^https?:\/\//;
const BOOL_NAME_RE = /^(is_|has_)|(_enabled)$/;

/**
 * Decide a FieldType from a single sample value + the column name. Names matter
 * for the bool/date hints (a 0/1 column called `count` shouldn't become bool;
 * a 10-digit unix epoch in `published_at` should become date).
 */
function classifyValue(value: unknown, columnName: string): FieldType {
  if (value === null || value === undefined) return "text";

  if (typeof value === "boolean") return "bool";

  if (typeof value === "number" && !isNaN(value)) {
    // 0/1 with a bool-ish column name → bool. Otherwise number.
    if ((value === 0 || value === 1) && BOOL_NAME_RE.test(columnName)) return "bool";
    // 10-digit unix epoch in *_at column → date.
    if (
      Number.isInteger(value) &&
      value >= 1_000_000_000 &&
      value <= 9_999_999_999 &&
      columnName.endsWith("_at")
    ) {
      return "date";
    }
    return "number";
  }

  if (typeof value === "string") {
    const s = value.trim();
    if (ISO_DATE_RE.test(s)) return "date";
    // Numeric string that's a 10-digit unix epoch in *_at column → date.
    if (/^\d{10}$/.test(s) && columnName.endsWith("_at")) {
      const n = Number(s);
      if (n >= 1_000_000_000 && n <= 9_999_999_999) return "date";
    }
    if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
      return "json";
    }
    if (EMAIL_RE.test(s)) return "email";
    if (URL_RE.test(s)) return "url";
    return "text";
  }

  // Plain JS object/array (e.g. JSON column already deserialized) → json.
  if (typeof value === "object") return "json";

  return "text";
}

/**
 * Build properly-typed field defs by sniffing the first non-null sample row of
 * a view query. SQLite views don't carry typed metadata for arbitrary
 * expressions, so we run `SELECT * FROM (<body>) LIMIT 1` and classify each
 * column's first observed value. Columns with no sample (or all-null) fall
 * back to "text".
 */
export async function inferViewFields(query: string): Promise<FieldDef[]> {
  await loadSensitiveSchema();
  validateViewQuery(query);
  const columns = await inferViewColumns(query);
  const userColumns = columns.filter((c) => !VIEW_META_COLUMNS.has(c));
  if (userColumns.length === 0) return [];

  // One sample row is enough — algorithm spec uses the first non-null per column.
  let sample: Record<string, unknown> | undefined;
  try {
    const { rows } = await previewViewRows(query, 1);
    sample = rows[0];
  } catch {
    // If the query fails at execution time, fall back to text-typed fields.
    return userColumns.map((c) => ({ name: c, type: "text" as const, required: false }));
  }

  return userColumns.map((c) => {
    const v = sample ? sample[c] : null;
    const type = v === null || v === undefined ? "text" : classifyValue(v, c);
    return { name: c, type, required: false };
  });
}

/** Create the SQLite VIEW backing a view collection. */
export async function createUserView(collectionName: string, query: string): Promise<void> {
  assertSqlIdent(collectionName, "collection");
  validateViewQuery(query);
  const tname = quoteIdent(userTableName(collectionName));
  const body = query.trim().replace(/;\s*$/, "");
  await db.exec(db.dialect.createView(tname, body));
}

/** Drop the SQLite VIEW backing a view collection. */
export async function dropUserView(collectionName: string): Promise<void> {
  assertSqlIdent(collectionName, "collection");
  const tname = quoteIdent(userTableName(collectionName));
  await db.exec(`DROP VIEW IF EXISTS ${tname}`);
}

/** Diff old vs new fields and emit ALTER TABLE statements. Throws on type-change attempts. */
export async function alterUserTable(
  collectionName: string,
  oldFields: FieldDef[],
  newFields: FieldDef[]
): Promise<void> {
  assertSqlIdent(collectionName, "collection");
  for (const f of newFields) if (!f.system) assertSqlIdent(f.name, "field");
  assertFieldOptions(newFields, oldFields);
  const tname = quoteIdent(userTableName(collectionName));
  await schemaChange(async () => {

  const oldByName = new Map(oldFields.filter((f) => !f.system).map((f) => [f.name, f]));
  const newByName = new Map(newFields.filter((f) => !f.system).map((f) => [f.name, f]));

  const table = userTableName(collectionName);
  // Unique constraints added after table creation live in a named index
  // (SQLite can't ADD COLUMN ... UNIQUE). Columns created as UNIQUE with the
  // table use SQLite's inline constraint instead, which can't be dropped.
  const uniqueIndex = (field: string) => quoteIdent(`uq_${table}_${field}`);
  const hasUniqueIndex = async (field: string) =>
    !!(await db.get(db.dialect.indexExistsSql(), [`uq_${table}_${field}`]));
  const addUniqueIndex = async (field: string) => {
    try {
      await db.exec(db.dialect.createIndex({ name: uniqueIndex(field), table: tname, columns: [quoteIdent(field)], unique: true }));
    } catch (e) {
      if (db.dialect.isUniqueViolation(e)) {
        throw new CollectionValidationError({
          [field]: `Can't make '${field}' unique: existing records have duplicate values`,
        });
      }
      throw e;
    }
  };

  // Renames: a new name with `renamedFrom` naming an old field that is not
  // in the new list. The column is renamed in place and keeps its data;
  // from here on the old entry counts as the new name.
  const renamed = new Map<string, string>(); // old → new
  for (const [newName, f] of newByName) {
    const from = f.renamedFrom;
    if (!from || from === newName || !oldByName.has(from) || newByName.has(from)) continue;
    if (oldByName.get(from)!.type !== f.type) {
      throw new Error(`Cannot rename '${from}' to '${newName}' and change its type at the same time`);
    }
    renamed.set(from, newName);
  }

  // The search index triggers reference their columns, which blocks DROP
  // COLUMN and keep a renamed column's old name; drop the index first and
  // let syncFts below recreate it.
  const indexed = (await ftsColumns(collectionName)) ?? [];
  if (indexed.some((c) => !newByName.has(c))) await dropFts(collectionName);

  for (const [from, to] of renamed) {
    const hadUnique = await hasUniqueIndex(from);
    if (hadUnique) await db.exec(`DROP INDEX ${uniqueIndex(from)}`);
    await db.exec(`ALTER TABLE ${tname} RENAME COLUMN ${quoteIdent(from)} TO ${quoteIdent(to)}`);
    if (hadUnique) await addUniqueIndex(to);
    oldByName.set(to, { ...oldByName.get(from)!, name: to });
    oldByName.delete(from);
  }

  // Drop fields removed in new
  for (const oldName of oldByName.keys()) {
    if (!newByName.has(oldName)) {
      // SQLite refuses to drop an indexed column.
      if (await hasUniqueIndex(oldName)) await db.exec(`DROP INDEX ${uniqueIndex(oldName)}`);
      await db.exec(`ALTER TABLE ${tname} DROP COLUMN ${quoteIdent(oldName)}`);
    }
  }

  // Add fields new in new
  for (const [newName, newField] of newByName) {
    if (!oldByName.has(newName)) {

      // SQLite ADD COLUMN can't enforce NOT NULL without DEFAULT or empty
      // table, and rejects UNIQUE outright. Strip both: required is enforced
      // at app level, unique by an index.
      await db.exec(db.dialect.addColumn(tname, { ...fieldColumn(newField), notNull: false, unique: false }));
      if (newField.options?.unique) await addUniqueIndex(newName);
    }
  }

  // unique toggled on an existing field
  for (const [name, newField] of newByName) {
    const oldField = oldByName.get(name);
    if (!oldField || oldField.type !== newField.type) continue;
    const was = !!oldField.options?.unique;
    const now = !!newField.options?.unique;
    if (now && !was && !(await hasUniqueIndex(name))) await addUniqueIndex(name);
    if (!now && was) {
      if (await hasUniqueIndex(name)) {
        await db.exec(`DROP INDEX ${uniqueIndex(name)}`);
      } else {
        throw new CollectionValidationError({
          [name]: `'${name}' was created as unique; drop and re-add the field to remove the constraint`,
        });
      }
    }
  }

  // Block type changes on existing fields
  for (const [name, newField] of newByName) {
    const oldField = oldByName.get(name);
    if (!oldField) continue;
    if (oldField.type !== newField.type) {
      throw new CollectionValidationError({
        [name]: `Cannot change type of field '${name}' from '${oldField.type}' to '${newField.type}'. Drop the field and re-add it with the new type.`,
      });
    }
  }

  await syncFts(collectionName, newFields);
  });
}

/**
 * A schema change that awaits between its statements runs in one
 * transaction with the write gate held, so no record write can join it
 * and be lost with its rollback. Inside an already gated call (a batch, a
 * hook) the transaction alone is enough: the caller holds the gate.
 */
async function schemaChange<T>(fn: () => Promise<T>): Promise<T> {
  if (gateMode() !== null) return db.transaction(fn, { immediate: false });
  return withExclusiveWrite(async (tx) => {
    try {
      const out = await db.transaction(fn, { immediate: false });
      tx.commit();
      return out;
    } catch (e) {
      tx.rollback();
      throw e;
    }
  });
}

// ── CRUD ────────────────────────────────────────────────────────────────────
/**
 * The caches the request path reads synchronously, filled for `name` if
 * they are cold or stale (a schema change moved the token). Cheap when
 * they are fresh: a map lookup and the schema token.
 */
async function warmDerived(name: string): Promise<void> {
  const token = db.schemaToken();
  try { await loadTableColumns(name, token); } catch { /* table missing mid-migration; tableColumns falls back */ }
  await loadSensitiveSchema(token);
}

export async function getCollection(nameOrId: string): Promise<Collection | null> {
  const hit = cache.get(nameOrId);
  if (hit) {
    await warmDerived(hit.name);
    return hit;
  }
  const db = getDb();
  const row = await db
    .select()
    .from(collections)
    .where(or(eq(collections.id, nameOrId), eq(collections.name, nameOrId)))
    .limit(1);
  const found = row[0] ?? null;
  if (found) {
    cache.set(found.id, found);
    cache.set(found.name, found);
    await warmDerived(found.name);
  }
  return found;
}

export async function listCollections(): Promise<Collection[]> {
  const db = getDb();
  return db.select().from(collections);
}

/** No collection by that id or name. HTTP 404. */
export class CollectionNotFoundError extends Error {
  constructor(idOrName: string) {
    super(`Collection '${idOrName}' not found`);
  }
}

export class CollectionValidationError extends Error {
  details: Record<string, string>;
  constructor(details: Record<string, string>) {
    super("Collection validation failed");
    this.details = details;
  }
}

function assertValidFieldsForType(type: string, fields: FieldDef[]): void {
  if (type !== "auth") return;
  const reserved = new Set<string>(AUTH_RESERVED_FIELD_NAMES);
  const errors: Record<string, string> = {};
  for (const f of fields) {
    if (f.system || f.implicit) continue;
    if (reserved.has(f.name)) {
      errors[f.name] = `'${f.name}' is reserved on auth collections (managed by the implicit auth schema)`;
    }
  }
  if (Object.keys(errors).length > 0) throw new CollectionValidationError(errors);
}

/** Inject any missing implicit fields at the front; preserve existing implicit entries (their custom options). */
function ensureImplicitFields(type: string, fields: FieldDef[]): FieldDef[] {
  if (type !== "auth") return fields;
  const present = new Set(fields.filter((f) => f.implicit).map((f) => f.name));
  const missing = AUTH_IMPLICIT_FIELDS.filter((f) => !present.has(f.name));
  if (missing.length === 0) return fields;
  return [...missing, ...fields];
}

export async function createCollection(
  data: Omit<NewCollection, "id" | "created_at" | "updated_at">
): Promise<Collection> {
  const db = getDb();
  const type = data.type ?? "base";

  let fields: FieldDef[];
  if (type === "view") {
    if (!data.view_query) throw new Error("View collections require a view_query");
    await loadSensitiveSchema();
    validateViewQuery(data.view_query);
    const incoming = parseFields(data.fields ?? "[]");
    // If caller didn't pre-populate fields, infer column names + types from the query.
    fields = incoming.length > 0 ? incoming : await inferViewFields(data.view_query);
  } else {
    const incoming = parseFields(data.fields ?? "[]");
    assertValidFieldsForType(type, incoming);
    fields = ensureImplicitFields(type, incoming);
  }

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const row: NewCollection = {
    ...data,
    id,
    // Rules default to admin-only. `null` means public and `""` means
    // admin-only (see evaluateRule in core/rules.ts), so an omitted rule used
    // to store NULL and silently publish the collection — an auth collection
    // created from the admin UI exposed every user's email, and let anyone
    // PATCH or DELETE them. A caller that genuinely wants a public rule has to
    // pass `null` explicitly.
    list_rule:   data.list_rule   === undefined ? "" : data.list_rule,
    view_rule:   data.view_rule   === undefined ? "" : data.view_rule,
    create_rule: data.create_rule === undefined ? "" : data.create_rule,
    update_rule: data.update_rule === undefined ? "" : data.update_rule,
    delete_rule: data.delete_rule === undefined ? "" : data.delete_rule,
    fields: JSON.stringify(fields),
    created_at: now,
    updated_at: now,
  };
  // Check what the table step checks before writing the row, so a schema it
  // would refuse leaves nothing behind.
  if (type !== "view") assertFieldOptions(fields.filter((f) => !f.implicit), []);
  await db.insert(collections).values(row);

  try {
    if (type === "view") {
      await createUserView(row.name, data.view_query!);
    } else if (type === "singleton") {
      // A singleton holds exactly one record, made with the collection, its
      // fields empty: reads never miss and an update always has a target.
      // So no NOT NULL in the table: `required` is enforced on writes.
      await createUserTable(row.name, fields.filter((f) => !f.implicit).map((f) => ({ ...f, required: false })));
      await ensureSingletonRecord(row.name);
    } else {
      // Per-collection real table excludes implicit fields — those live on vaultbase_users.
      await createUserTable(row.name, fields.filter((f) => !f.implicit));
      if (type === "auth") {
        // v0.11+: auth columns (email/password_hash/...) live on `vb_<name>`
        // alongside the per-collection custom fields. Existing v0.10 installs
        // get the same shape via the boot migration in db/migrate.ts.
        await ensureAuthColumns(row.name);
      }
    }
  } catch (e) {
    // The table (or view) couldn't be made: don't leave a collection that
    // answers 500 to every request.
    await db.delete(collections).where(eq(collections.id, id)).catch(() => {});
    if (type !== "view") await dropUserTable(row.name).catch(() => {});
    throw e;
  }

  const created = await db.select().from(collections).where(eq(collections.id, id)).limit(1);
  const result = created[0];
  if (!result) throw new Error("Failed to create collection");
  schemaVersion++;
  cache.set(result.id, result);
  cache.set(result.name, result);
  return result;
}

/**
 * The id of a singleton collection's one record, creating it if it's missing
 * (a row removed with raw SQL, or a table made before the record was). The
 * record has its fields empty until someone saves it.
 */
export async function ensureSingletonRecord(name: string): Promise<string> {
  assertSqlIdent(name, "collection");
  const table = quoteIdent(userTableName(name));
  const row = await db.get<{ id: string }>(`SELECT "id" FROM ${table} ORDER BY "created_at" LIMIT 1`);
  if (row) return row.id;
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await db.run(`INSERT INTO ${table} ("id", "created_at", "updated_at") VALUES (?, ?, ?)`, [id, now, now], { table: userTableName(name) });
  return id;
}

/**
 * Move a collection's storage and everything that points at it by name to
 * `newName`: the table (or view), the auth email index, relation fields in
 * other collections, hooks and record history. Free-text references (rules,
 * webhook event patterns, API token scopes) are left for the operator.
 */
async function renameCollectionStorage(
  before: Collection,
  newName: string,
  type: string,
  viewQuery: string | null | undefined,
): Promise<void> {
  assertSqlIdent(newName, "collection");
  const orm = getDb();
  const clash = await orm.select({ id: collections.id }).from(collections)
    .where(eq(collections.name, newName)).limit(1);
  if (clash.length > 0) throw new Error(`A collection named '${newName}' already exists`);

  const oldName = before.name;
  const all = await orm.select().from(collections);
  const relationUpdates: Array<{ id: string; name: string; fields: string }> = [];
  for (const c of all) {
    let fields: FieldDef[];
    try { fields = parseFields(c.fields); } catch { continue; }
    let changed = false;
    for (const f of fields) {
      if (f.type === "relation" && f.collection === oldName) { f.collection = newName; changed = true; }
    }
    if (changed) relationUpdates.push({ id: c.id, name: c.name, fields: JSON.stringify(fields) });
  }

  const oldTable = userTableName(oldName);
  const newTable = userTableName(newName);
  await schemaChange(async () => {
    if (type === "view") {
      if (!viewQuery) throw new Error("View collections require a view_query");
      await dropUserView(oldName);
      await createUserView(newName, viewQuery);
    } else {
      // The search index is named after the collection; rebuilt below.
      await dropFts(oldName);
      await db.exec(`ALTER TABLE ${quoteIdent(oldTable)} RENAME TO ${quoteIdent(newTable)}`);
      // Our indexes are named after the table (idx_<table>_*, uq_<table>_*).
      // SQLite moves them with the table but keeps their names; recreate each
      // under the new name from its stored definition.
      const indexes = await db.all<{ name: string; sql: string }>(db.dialect.listIndexesSql(), [newTable]);
      for (const { name, sql } of indexes) {
        if (!name.includes(oldTable)) continue;
        for (const stmt of db.dialect.renameIndex(name, name.replace(oldTable, newTable), sql)) await db.exec(stmt);
      }
    }
    for (const u of relationUpdates) await db.run(`UPDATE vaultbase_collections SET fields = ? WHERE id = ?`, [u.fields, u.id]);
    await db.run(`UPDATE vaultbase_hooks SET collection_name = ? WHERE collection_name = ?`, [newName, oldName]);
    await db.run(`UPDATE vaultbase_record_history SET collection = ? WHERE collection = ?`, [newName, oldName]);
  });
  if (type !== "view") await syncFts(newName, parseFields(before.fields).filter((f) => !f.implicit));

  for (const u of relationUpdates) { cache.delete(u.id); cache.delete(u.name); }
  broadcast({ type: "bus", kind: "collections" });
  await clearPreparedStatementsOnSchemaChange();
  const { invalidateHookCache } = await import("./hooks.ts");
  invalidateHookCache();
  await renameInHookFiles(newName);
}

/**
 * Hook files name their collection in the file; the rename above changed
 * only their rows. Write the new name into each file too, or the next sync
 * would put the old one back.
 */
async function renameInHookFiles(newName: string): Promise<void> {
  const { codeFilesDir, updateCodeFile } = await import("./code-files.ts");
  if (!codeFilesDir()) return;
  const rows = await db.all<Record<string, unknown> & { id: string; file_path: string | null }>(`SELECT * FROM vaultbase_hooks WHERE origin = 'file' AND collection_name = ?`, [newName]);
  for (const row of rows) {
    try {
      await updateCodeFile("hook", row, { collection_name: newName }, undefined);
    } catch (e) {
      console.warn(`[hooks] renamed collection '${newName}': update ${row.file_path} by hand (${e instanceof Error ? e.message : String(e)})`);
    }
  }
}

export async function updateCollection(
  id: string,
  data: Partial<Omit<NewCollection, "id" | "created_at">>
): Promise<Collection> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // Get existing collection for diff
  // By id, or by name as GET /collections/:id accepts.
  const existing = await db.select().from(collections).where(or(eq(collections.id, id), eq(collections.name, id))).limit(1);
  if (existing.length === 0) throw new CollectionNotFoundError(id);
  const before = existing[0]!;
  id = before.id;

  const effectiveType = data.type ?? before.type;
  if (data.type !== undefined && data.type !== before.type && (data.type === "singleton" || before.type === "singleton")) {
    throw new Error("A collection can't be turned into a singleton or out of one: create a new collection and move the data");
  }

  // Rename first so every later step (view rebuild, field DDL) targets the
  // new table.
  let currentName = before.name;
  if (data.name !== undefined && data.name !== before.name) {
    await renameCollectionStorage(before, data.name, effectiveType, data.view_query ?? before.view_query);
    currentName = data.name;
  }

  // View collections: drop & recreate the SQLite VIEW if the query changed,
  // then re-derive fields when the caller didn't provide them. Skip the
  // table-altering path entirely — views have no real columns.
  if (effectiveType === "view") {
    const newQuery = data.view_query !== undefined ? data.view_query : before.view_query;
    if (!newQuery) throw new Error("View collections require a view_query");
    const queryChanged = data.view_query !== undefined && data.view_query !== before.view_query;
    if (queryChanged) {
      await loadSensitiveSchema();
      validateViewQuery(newQuery);
      await dropUserView(currentName);
      await createUserView(currentName, newQuery);
      // Re-infer fields if the caller didn't supply explicit field defs.
      if (data.fields === undefined) {
        const inferred = await inferViewFields(newQuery);
        data = { ...data, fields: JSON.stringify(inferred) };
      }
    }
  } else if (data.fields !== undefined && data.fields !== before.fields) {
    // Apply DDL diff before metadata update for base/auth collections.
    const oldFields = parseFields(before.fields);
    const incoming = parseFields(data.fields);
    assertValidFieldsForType(effectiveType, incoming);
    // Preserve implicit fields from the old schema if the client omitted them.
    const present = new Set(incoming.filter((f) => f.implicit).map((f) => f.name));
    const carryOver = oldFields.filter((f) => f.implicit && !present.has(f.name));
    const newFields = ensureImplicitFields(effectiveType, [...carryOver, ...incoming]);
    // Real table only sees non-implicit fields.
    await alterUserTable(
      currentName,
      oldFields.filter((f) => !f.implicit),
      newFields.filter((f) => !f.implicit)
    );
    // `renamedFrom` is an instruction for the DDL above, not part of the schema.
    data = { ...data, fields: JSON.stringify(newFields.map(({ renamedFrom: _r, ...f }) => f)) };
  }

  await db.update(collections).set({ ...data, updated_at: now }).where(eq(collections.id, id));
  cache.delete(id);
  cache.delete(before.name);
  broadcast({ type: "bus", kind: "collections" });

  const updated = await db.select().from(collections).where(eq(collections.id, id)).limit(1);
  const result = updated[0];
  if (!result) throw new Error("Collection not found");
  schemaVersion++;
  cache.set(result.id, result);
  cache.set(result.name, result);
  return result;
}

/**
 * Delete a collection by id or name. The row is deleted by the id found:
 * given a name, it used to drop the table and keep the row, leaving a
 * collection with no data that answered 500.
 */
export async function deleteCollection(idOrName: string): Promise<void> {
  const db = getDb();
  const col = await getCollection(idOrName);
  if (!col) throw new CollectionNotFoundError(idOrName);
  schemaVersion++;
  if (col.type === "view") await dropUserView(col.name);
  else await dropUserTable(col.name);
  cache.delete(col.id);
  cache.delete(col.name);
  broadcast({ type: "bus", kind: "collections" });
  await db.delete(collections).where(eq(collections.id, col.id));
}
