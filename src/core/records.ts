import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { records, type NewRecord } from "../db/schema.ts";
import { getCollection, parseFields } from "./collections.ts";
import { broadcast } from "../realtime/manager.ts";

export interface ListOptions {
  page?: number;
  perPage?: number;
  filter?: string;
  sort?: string;
  expand?: string;
}

export interface ListResult {
  data: RecordWithMeta[];
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
}

export interface RecordWithMeta {
  id: string;
  collectionId: string;
  collectionName: string;
  created: number;
  updated: number;
  [key: string]: unknown;
}

function toMeta(
  row: { id: string; collection_id: string; data: string; created_at: number; updated_at: number },
  collectionName: string
): RecordWithMeta {
  const data = JSON.parse(row.data) as Record<string, unknown>;
  return {
    id: row.id,
    collectionId: row.collection_id,
    collectionName,
    created: row.created_at,
    updated: row.updated_at,
    ...data,
  };
}

export async function listRecords(
  collectionName: string,
  opts: ListOptions = {}
): Promise<ListResult> {
  const db = getDb();
  const col = await getCollection(collectionName);
  if (!col) throw new Error(`Collection '${collectionName}' not found`);

  const page = opts.page ?? 1;
  const perPage = opts.perPage ?? 30;
  const offset = (page - 1) * perPage;

  const rows = await db
    .select()
    .from(records)
    .where(eq(records.collection_id, col.id))
    .limit(perPage)
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(records)
    .where(eq(records.collection_id, col.id));

  const totalItems = countResult[0]?.count ?? 0;
  const totalPages = Math.ceil(totalItems / perPage);

  return {
    data: rows.map((r) => toMeta(r, col.name)),
    page,
    perPage,
    totalItems,
    totalPages,
  };
}

export async function getRecord(
  collectionName: string,
  id: string
): Promise<RecordWithMeta | null> {
  const db = getDb();
  const col = await getCollection(collectionName);
  if (!col) return null;

  const rows = await db
    .select()
    .from(records)
    .where(and(eq(records.id, id), eq(records.collection_id, col.id)))
    .limit(1);

  const row = rows[0];
  return row ? toMeta(row, col.name) : null;
}

export async function createRecord(
  collectionName: string,
  data: Record<string, unknown>
): Promise<RecordWithMeta> {
  const db = getDb();
  const col = await getCollection(collectionName);
  if (!col) throw new Error(`Collection '${collectionName}' not found`);

  const fields = parseFields(col.fields);
  const now = Math.floor(Date.now() / 1000);
  for (const f of fields) {
    if (f.type === "autodate" && f.onCreate) data[f.name] = now;
  }

  const id = crypto.randomUUID();
  const row: NewRecord = {
    id,
    collection_id: col.id,
    data: JSON.stringify(data),
    created_at: now,
    updated_at: now,
  };
  await db.insert(records).values(row);
  const result = toMeta({ id, collection_id: col.id, data: JSON.stringify(data), created_at: now, updated_at: now }, col.name);
  broadcast(col.name, { type: "create", collection: col.name, record: result });
  return result;
}

export async function updateRecord(
  collectionName: string,
  id: string,
  data: Record<string, unknown>
): Promise<RecordWithMeta> {
  const db = getDb();
  const col = await getCollection(collectionName);
  if (!col) throw new Error(`Collection '${collectionName}' not found`);

  const existing = await getRecord(collectionName, id);
  if (!existing) throw new Error("Record not found");

  const fields = parseFields(col.fields);
  const now = Math.floor(Date.now() / 1000);
  for (const f of fields) {
    if (f.type === "autodate" && f.onUpdate) data[f.name] = now;
  }

  const { id: _id, collectionId: _cid, collectionName: _cn, created: _cr, updated: _up, ...existingData } = existing;
  const merged = { ...existingData, ...data };

  await db
    .update(records)
    .set({ data: JSON.stringify(merged), updated_at: now })
    .where(and(eq(records.id, id), eq(records.collection_id, col.id)));

  const result = toMeta(
    {
      id,
      collection_id: col.id,
      data: JSON.stringify(merged),
      created_at: existing.created as number,
      updated_at: now,
    },
    col.name
  );
  broadcast(col.name, { type: "update", collection: col.name, record: result });
  return result;
}

export async function deleteRecord(
  collectionName: string,
  id: string
): Promise<void> {
  const db = getDb();
  const col = await getCollection(collectionName);
  if (!col) throw new Error(`Collection '${collectionName}' not found`);
  await db
    .delete(records)
    .where(and(eq(records.id, id), eq(records.collection_id, col.id)));
  broadcast(col.name, { type: "delete", collection: col.name, id });
}
