import { eq, or } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { collections, type Collection, type NewCollection } from "../db/schema.ts";

export type FieldType =
  | "text" | "number" | "bool" | "file" | "relation"
  | "select" | "autodate" | "email" | "url" | "date" | "json";

export interface FieldOptions {
  // text/email/url: length + pattern + unique
  min?: number;
  max?: number;
  pattern?: string;
  unique?: boolean;
  // select: allowed values
  values?: string[];
  multiple?: boolean;
  // file: size + mime
  maxSize?: number;        // bytes
  mimeTypes?: string[];
}

export interface FieldDef {
  name: string;
  type: FieldType;
  required?: boolean;
  system?: boolean;
  collection?: string;     // for relation
  options?: FieldOptions;
  onCreate?: boolean;      // autodate
  onUpdate?: boolean;      // autodate
}

const cache = new Map<string, Collection>();

export function parseFields(raw: string): FieldDef[] {
  return JSON.parse(raw) as FieldDef[];
}

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
  const created = await db
    .select()
    .from(collections)
    .where(eq(collections.id, id))
    .limit(1);
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
  await db
    .update(collections)
    .set({ ...data, updated_at: now })
    .where(eq(collections.id, id));
  cache.delete(id);
  const updated = await db
    .select()
    .from(collections)
    .where(eq(collections.id, id))
    .limit(1);
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
    cache.delete(col.id);
    cache.delete(col.name);
  }
  await db.delete(collections).where(eq(collections.id, id));
}
