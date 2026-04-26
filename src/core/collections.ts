import type { Database } from "bun:sqlite";
import { eq, or } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { collections, type Collection, type NewCollection } from "../db/schema.ts";

export type FieldType =
  | "text" | "number" | "bool" | "file" | "relation"
  | "select" | "autodate" | "email" | "url" | "date" | "json";

export interface FieldOptions {
  min?: number;
  max?: number;
  pattern?: string;
  unique?: boolean;
  values?: string[];
  multiple?: boolean;
  maxSize?: number;
  mimeTypes?: string[];
}

export interface FieldDef {
  name: string;
  type: FieldType;
  required?: boolean;
  system?: boolean;
  collection?: string;
  options?: FieldOptions;
  onCreate?: boolean;
  onUpdate?: boolean;
}

const cache = new Map<string, Collection>();

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

export async function createCollection(
  data: Omit<NewCollection, "id" | "created_at" | "updated_at">
): Promise<Collection> {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const row: NewCollection = { ...data, id, created_at: now, updated_at: now };
  await db.insert(collections).values(row);

  // Create the per-collection real table
  const fields = parseFields(row.fields ?? "[]");
  createUserTable(row.name, fields);

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

  // Apply DDL diff before metadata update
  if (data.fields !== undefined && data.fields !== before.fields) {
    const oldFields = parseFields(before.fields);
    const newFields = parseFields(data.fields);
    alterUserTable(before.name, oldFields, newFields);
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
    dropUserTable(col.name);
    cache.delete(col.id);
    cache.delete(col.name);
  }
  await db.delete(collections).where(eq(collections.id, id));
}
