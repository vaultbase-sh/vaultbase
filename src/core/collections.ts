import type { Database } from "bun:sqlite";
import { eq, or } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { collections, type Collection, type NewCollection } from "../db/schema.ts";

export type FieldType =
  | "text" | "number" | "bool" | "file" | "relation"
  | "select" | "autodate" | "email" | "url" | "date" | "json"
  | "password" | "editor" | "geoPoint";

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

/** Reset the in-memory collection cache. Exported for tests + DB-reset hooks. */
export function _resetCollectionCache(): void {
  cache.clear();
}

export function parseFields(raw: string): FieldDef[] {
  return JSON.parse(raw) as FieldDef[];
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

function quoteIdent(name: string): string {
  return `"${name}"`;
}

function colDefSql(field: FieldDef): string {
  const type = colSqlType(field.type);
  const notNull = field.required ? " NOT NULL" : "";
  const unique = field.options?.unique ? " UNIQUE" : "";
  return `${quoteIdent(field.name)} ${type}${notNull}${unique}`;
}

/** Create the per-collection user table. */
export function createUserTable(collectionName: string, fields: FieldDef[]): void {
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
  // Strip a trailing semicolon if any, then reject any remaining ones.
  const body = q.replace(/;\s*$/, "");
  if (body.includes(";")) throw new Error("View query must be a single statement");
  if (!/^select\b/i.test(body)) throw new Error("View query must begin with SELECT");
  // Forbid statements that mutate state, even in CTEs/subqueries.
  const banned = /\b(insert|update|delete|drop|create|alter|attach|detach|pragma|replace|truncate|vacuum|reindex)\b/i;
  if (banned.test(body)) throw new Error("View query may only SELECT");
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

/** Build default text-typed field defs from inferred column names. id/created/updated remain implicit. */
export function fieldsFromViewColumns(columns: string[]): FieldDef[] {
  return columns
    // id/created/updated are surfaced via record meta, not as user fields
    .filter((c) => c !== "id" && c !== "created" && c !== "created_at" && c !== "updated" && c !== "updated_at")
    .map((c) => ({ name: c, type: "text" as const, required: false }));
}

/** Create the SQLite VIEW backing a view collection. */
export function createUserView(collectionName: string, query: string): void {
  validateViewQuery(query);
  const tname = quoteIdent(userTableName(collectionName));
  const body = query.trim().replace(/;\s*$/, "");
  rawClient().exec(`CREATE VIEW IF NOT EXISTS ${tname} AS ${body}`);
}

/** Drop the SQLite VIEW backing a view collection. */
export function dropUserView(collectionName: string): void {
  const tname = quoteIdent(userTableName(collectionName));
  rawClient().exec(`DROP VIEW IF EXISTS ${tname}`);
}

/** Diff old vs new fields and emit ALTER TABLE statements. Throws on type-change attempts. */
export function alterUserTable(
  collectionName: string,
  oldFields: FieldDef[],
  newFields: FieldDef[]
): void {
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
    // If caller didn't pre-populate fields, infer column names from the query.
    fields = incoming.length > 0 ? incoming : fieldsFromViewColumns(inferViewColumns(data.view_query));
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
        const inferred = fieldsFromViewColumns(inferViewColumns(newQuery));
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
