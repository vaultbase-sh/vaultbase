import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { parseFilter } from "./filter.ts";
import { validateRecord } from "./validate.ts";
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

  // Build ORDER BY from ?sort=-field1,field2 (prefix - = desc)
  const orderBy = (opts.sort ?? "-created_at")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const descending = s.startsWith("-");
      const field = descending ? s.slice(1) : s;
      // Map user-facing field names to DB columns
      const col = field === "created" ? "created_at"
                : field === "updated" ? "updated_at"
                : field === "id"      ? "id"
                : null; // user data fields live in JSON blob — sort by JSON_EXTRACT
      if (col === "created_at") return descending ? desc(records.created_at) : asc(records.created_at);
      if (col === "updated_at") return descending ? desc(records.updated_at) : asc(records.updated_at);
      if (col === "id")         return descending ? desc(records.id) : asc(records.id);
      // JSON field: ORDER BY JSON_EXTRACT(data, '$.field')
      const expr = sql`JSON_EXTRACT(${records.data}, ${`$.${field}`})`;
      return descending ? desc(expr) : asc(expr);
    });

  const filterClause = opts.filter ? parseFilter(opts.filter) : undefined;
  const where = filterClause
    ? and(eq(records.collection_id, col.id), filterClause)
    : eq(records.collection_id, col.id);

  const rows = await db
    .select()
    .from(records)
    .where(where)
    .orderBy(...orderBy)
    .limit(perPage)
    .offset(offset);

  const countResult = await db
    .select({ count: sql<number>`count(*)` })
    .from(records)
    .where(where);

  const totalItems = countResult[0]?.count ?? 0;
  const totalPages = Math.ceil(totalItems / perPage);

  const items = rows.map((r) => toMeta(r, col.name));

  // Expand relation fields
  if (opts.expand) {
    const expandFields = opts.expand.split(",").map((s) => s.trim()).filter(Boolean);
    const schema = parseFields(col.fields);
    await expandRelations(items, expandFields, schema);
  }

  return { data: items, page, perPage, totalItems, totalPages };
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

  // Validate against schema (throws ValidationError on failure)
  await validateRecord(col, data, "create");

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

  // Validate against schema (throws ValidationError on failure)
  await validateRecord(col, data, "update", id);

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

// ── Relation expand ──────────────────────────────────────────────────────────

async function expandRelations(
  items: RecordWithMeta[],
  expandFields: string[],
  schema: ReturnType<typeof parseFields>
): Promise<void> {
  const db = getDb();

  for (const fieldName of expandFields) {
    const fieldDef = schema.find((f) => f.name === fieldName && f.type === "relation");
    if (!fieldDef) continue;

    const targetCollName = fieldDef.collection;
    if (!targetCollName) continue;

    const targetCol = await getCollection(targetCollName);
    if (!targetCol) continue;

    // Collect all referenced IDs across items
    const ids = [...new Set(
      items
        .map((item) => item[fieldName])
        .filter((v): v is string => typeof v === "string" && v.length > 0)
    )];
    if (ids.length === 0) continue;

    const related = await db
      .select()
      .from(records)
      .where(and(eq(records.collection_id, targetCol.id), inArray(records.id, ids)));

    const byId = new Map(related.map((r) => [r.id, toMeta(r, targetCol.name)]));

    // Attach expanded record to each item
    for (const item of items) {
      const refId = item[fieldName];
      if (typeof refId === "string" && byId.has(refId)) {
        if (!item.expand) (item as RecordWithMeta & { expand: Record<string, unknown> }).expand = {};
        (item as RecordWithMeta & { expand: Record<string, unknown> }).expand[fieldName] = byId.get(refId);
      }
    }
  }
}
