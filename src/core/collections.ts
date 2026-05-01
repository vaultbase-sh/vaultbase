import type { Database } from "bun:sqlite";
import { eq, or } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { collections, type Collection, type NewCollection } from "../db/schema.ts";

export type FieldType =
  | "text" | "number" | "bool" | "file" | "relation"
  | "select" | "autodate" | "email" | "url" | "date" | "json"
  | "password" | "editor" | "geoPoint" | "vector";

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
   * File-only. When true, GET /api/files/:filename requires a `?token=`
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
}

export type CascadeMode = NonNullable<FieldOptions["cascade"]>;

export type CollectionType = "base" | "auth";

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
}

const cache = new Map<string, Collection>();

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
export function _resetCollectionCache(): void {
  cache.clear();
  // Schema mutated — drop cached prepared statements (their SQL embeds table
  // / column names that may have changed).
  void clearPreparedStatementsOnSchemaChange();
}

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

// ── Table naming ────────────────────────────────────────────────────────────
/** User collections live in tables named `vb_<name>` to avoid colliding with internal `vaultbase_*` tables. */
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
    default:         return "TEXT";
  }
}

function rawClient(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
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

function colDefSql(field: FieldDef): string {
  const type = colSqlType(field.type);
  const notNull = field.required ? " NOT NULL" : "";
  const unique = field.options?.unique ? " UNIQUE" : "";
  return `${quoteIdent(field.name)} ${type}${notNull}${unique}`;
}

/** Create the per-collection user table. */
export function createUserTable(collectionName: string, fields: FieldDef[]): void {
  assertSqlIdent(collectionName, "collection");
  for (const f of fields) if (!f.system) assertSqlIdent(f.name, "field");
  const tname = quoteIdent(userTableName(collectionName));
  const userColDefs = fields
    .filter((f) => !f.system && f.type !== "autodate")
    .map(colDefSql);
  const cols = [
    `"id" TEXT PRIMARY KEY`,
    ...userColDefs,
    `"created_at" INTEGER NOT NULL DEFAULT (unixepoch())`,
    `"updated_at" INTEGER NOT NULL DEFAULT (unixepoch())`,
  ];
  rawClient().exec(`CREATE TABLE IF NOT EXISTS ${tname} (\n  ${cols.join(",\n  ")}\n)`);
}

/** Drop the per-collection user table. */
export function dropUserTable(collectionName: string): void {
  assertSqlIdent(collectionName, "collection");
  const tname = quoteIdent(userTableName(collectionName));
  rawClient().exec(`DROP TABLE IF EXISTS ${tname}`);
}

// ── View collections ────────────────────────────────────────────────────────

/**
 * Validate that a view query is a single SELECT — no semicolons, no DML/DDL
 * verbs, no PRAGMA. Admin-supplied so this is a guard against silly mistakes
 * and obvious abuse, not a sandbox: a sufficiently determined admin can still
 * read sensitive tables in their SELECT and that's their responsibility.
 */
export function validateViewQuery(query: string): void {
  const q = query.trim();
  if (!q) throw new Error("View query is empty");
  const body = q.replace(/;\s*$/, "");
  if (body.includes(";")) throw new Error("View query must be a single statement");
  // Strip /* ... */ and -- ... line comments before keyword scanning so
  // attackers can't hide banned tokens inside comments.
  const stripped = body
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
  if (!/^select\b/i.test(stripped.trim())) throw new Error("View query must begin with SELECT");
  const banned = /\b(insert|update|delete|drop|create|alter|attach|detach|pragma|replace|truncate|vacuum|reindex|load_extension|with|recursive)\b/i;
  if (banned.test(stripped)) throw new Error("View query may only SELECT");
}

/** Run the query with LIMIT 0 to extract column names without fetching rows. */
export function inferViewColumns(query: string): string[] {
  const body = query.trim().replace(/;\s*$/, "");
  const wrapped = `SELECT * FROM (${body}) LIMIT 0`;
  const stmt = rawClient().prepare(wrapped);
  // bun:sqlite exposes columnNames on a prepared statement
  const names = (stmt as unknown as { columnNames?: string[] }).columnNames ?? [];
  if (names.length === 0) {
    // Fallback: execute once and read keys off the first (empty) result, which
    // requires an actual run; we use values() to avoid materializing rows.
    stmt.values();
    const fallback = (stmt as unknown as { columnNames?: string[] }).columnNames ?? [];
    return fallback;
  }
  return names;
}

/**
 * Run the view query with a LIMIT clause and return the resulting rows.
 * Wrapping in a subquery preserves whatever ORDER BY / LIMIT the admin wrote
 * (their own clamps stack with ours). Rows are returned as plain objects keyed
 * by column name — useful for the admin UI's "preview rows" button.
 */
export function previewViewRows(query: string, limit = 5): { columns: string[]; rows: Array<Record<string, unknown>> } {
  validateViewQuery(query);
  const body = query.trim().replace(/;\s*$/, "");
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const wrapped = `SELECT * FROM (${body}) LIMIT ${safeLimit}`;
  const stmt = rawClient().prepare(wrapped);
  const rows = stmt.all() as Array<Record<string, unknown>>;
  const columns = (stmt as unknown as { columnNames?: string[] }).columnNames ?? Object.keys(rows[0] ?? {});
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
export function inferViewFields(query: string): FieldDef[] {
  validateViewQuery(query);
  const columns = inferViewColumns(query);
  const userColumns = columns.filter((c) => !VIEW_META_COLUMNS.has(c));
  if (userColumns.length === 0) return [];

  // One sample row is enough — algorithm spec uses the first non-null per column.
  let sample: Record<string, unknown> | undefined;
  try {
    const { rows } = previewViewRows(query, 1);
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
export function createUserView(collectionName: string, query: string): void {
  assertSqlIdent(collectionName, "collection");
  validateViewQuery(query);
  const tname = quoteIdent(userTableName(collectionName));
  const body = query.trim().replace(/;\s*$/, "");
  rawClient().exec(`CREATE VIEW IF NOT EXISTS ${tname} AS ${body}`);
}

/** Drop the SQLite VIEW backing a view collection. */
export function dropUserView(collectionName: string): void {
  assertSqlIdent(collectionName, "collection");
  const tname = quoteIdent(userTableName(collectionName));
  rawClient().exec(`DROP VIEW IF EXISTS ${tname}`);
}

/** Diff old vs new fields and emit ALTER TABLE statements. Throws on type-change attempts. */
export function alterUserTable(
  collectionName: string,
  oldFields: FieldDef[],
  newFields: FieldDef[]
): void {
  assertSqlIdent(collectionName, "collection");
  for (const f of newFields) if (!f.system) assertSqlIdent(f.name, "field");
  const tname = quoteIdent(userTableName(collectionName));
  const client = rawClient();

  const oldByName = new Map(oldFields.filter((f) => !f.system && f.type !== "autodate").map((f) => [f.name, f]));
  const newByName = new Map(newFields.filter((f) => !f.system && f.type !== "autodate").map((f) => [f.name, f]));

  // Drop fields removed in new
  for (const oldName of oldByName.keys()) {
    if (!newByName.has(oldName)) {
      client.exec(`ALTER TABLE ${tname} DROP COLUMN ${quoteIdent(oldName)}`);
    }
  }

  // Add fields new in new
  for (const [newName, newField] of newByName) {
    if (!oldByName.has(newName)) {
      const def = colDefSql(newField);
      // SQLite ADD COLUMN can't enforce NOT NULL without DEFAULT or empty table.
      // Strip NOT NULL on add — app-level validation handles required-on-create.
      const safeDef = def.replace(/ NOT NULL/, "");
      client.exec(`ALTER TABLE ${tname} ADD COLUMN ${safeDef}`);
    }
  }

  // Block type changes on existing fields
  for (const [name, newField] of newByName) {
    const oldField = oldByName.get(name);
    if (!oldField) continue;
    if (oldField.type !== newField.type) {
      throw new Error(
        `Cannot change type of field '${name}' from '${oldField.type}' to '${newField.type}'. Drop the field and re-add it with the new type.`
      );
    }
  }
}

// ── CRUD ────────────────────────────────────────────────────────────────────
export async function getCollection(nameOrId: string): Promise<Collection | null> {
  if (cache.has(nameOrId)) return cache.get(nameOrId)!;
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
  }
  return found;
}

export async function listCollections(): Promise<Collection[]> {
  const db = getDb();
  return db.select().from(collections);
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
    validateViewQuery(data.view_query);
    const incoming = parseFields(data.fields ?? "[]");
    // If caller didn't pre-populate fields, infer column names + types from the query.
    fields = incoming.length > 0 ? incoming : inferViewFields(data.view_query);
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
    // View collections default to admin-only access; SQL has unrestricted
    // reach so opening the API by default would be a footgun.
    list_rule: type === "view" && data.list_rule === undefined ? "" : data.list_rule,
    view_rule: type === "view" && data.view_rule === undefined ? "" : data.view_rule,
    fields: JSON.stringify(fields),
    created_at: now,
    updated_at: now,
  };
  await db.insert(collections).values(row);

  if (type === "view") {
    createUserView(row.name, data.view_query!);
  } else {
    // Per-collection real table excludes implicit fields — those live on vaultbase_users.
    createUserTable(row.name, fields.filter((f) => !f.implicit));
  }

  const created = await db.select().from(collections).where(eq(collections.id, id)).limit(1);
  const result = created[0];
  if (!result) throw new Error("Failed to create collection");
  cache.set(result.id, result);
  cache.set(result.name, result);
  return result;
}

export async function updateCollection(
  id: string,
  data: Partial<Omit<NewCollection, "id" | "created_at">>
): Promise<Collection> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  // Get existing collection for diff
  const existing = await db.select().from(collections).where(eq(collections.id, id)).limit(1);
  if (existing.length === 0) throw new Error("Collection not found");
  const before = existing[0]!;

  const effectiveType = data.type ?? before.type;

  // View collections: drop & recreate the SQLite VIEW if the query changed,
  // then re-derive fields when the caller didn't provide them. Skip the
  // table-altering path entirely — views have no real columns.
  if (effectiveType === "view") {
    const newQuery = data.view_query !== undefined ? data.view_query : before.view_query;
    if (!newQuery) throw new Error("View collections require a view_query");
    const queryChanged = data.view_query !== undefined && data.view_query !== before.view_query;
    if (queryChanged) {
      validateViewQuery(newQuery);
      dropUserView(before.name);
      createUserView(before.name, newQuery);
      // Re-infer fields if the caller didn't supply explicit field defs.
      if (data.fields === undefined) {
        const inferred = inferViewFields(newQuery);
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
    alterUserTable(
      before.name,
      oldFields.filter((f) => !f.implicit),
      newFields.filter((f) => !f.implicit)
    );
    data = { ...data, fields: JSON.stringify(newFields) };
  }

  await db.update(collections).set({ ...data, updated_at: now }).where(eq(collections.id, id));
  cache.delete(id);
  cache.delete(before.name);

  const updated = await db.select().from(collections).where(eq(collections.id, id)).limit(1);
  const result = updated[0];
  if (!result) throw new Error("Collection not found");
  cache.set(result.id, result);
  cache.set(result.name, result);
  return result;
}

export async function deleteCollection(id: string): Promise<void> {
  const db = getDb();
  const col = await getCollection(id);
  if (col) {
    if (col.type === "view") dropUserView(col.name);
    else dropUserTable(col.name);
    cache.delete(col.id);
    cache.delete(col.name);
  }
  await db.delete(collections).where(eq(collections.id, id));
}
