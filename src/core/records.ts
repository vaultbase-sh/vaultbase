import type { Database } from "bun:sqlite";
import { getDb } from "../db/client.ts";
import type { Collection } from "../db/schema.ts";
import {
  getCollection,
  parseFields,
  userTableName,
  type FieldDef,
} from "./collections.ts";
import { parseFilter } from "./filter.ts";
import type { AuthContext } from "./rules.ts";
import { broadcast } from "../realtime/manager.ts";
import { validateRecord } from "./validate.ts";

export interface ListOptions {
  page?: number;
  perPage?: number;
  filter?: string;
  sort?: string;
  expand?: string;
  fields?: string;
  skipTotal?: boolean;
  accessRule?: string;
  auth?: AuthContext | null;
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
  expand?: Record<string, unknown>;
  [key: string]: unknown;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function rawClient(): Database {
  return (getDb() as unknown as { $client: Database }).$client;
}

function quoteIdent(name: string): string {
  return `"${name}"`;
}

function isJsonField(field: FieldDef): boolean {
  return field.type === "json" || (field.type === "select" && field.options?.multiple === true);
}

/** Coerce a JS value to its DB-safe representation based on field type. */
function encodeValue(val: unknown, field: FieldDef): unknown {
  if (val === undefined || val === null) return null;
  if (field.type === "bool") {
    if (typeof val === "boolean") return val ? 1 : 0;
    if (val === 1 || val === 0) return val;
    return val ? 1 : 0;
  }
  if (field.type === "number") {
    if (typeof val === "number") return val;
    const n = Number(val);
    return isNaN(n) ? null : n;
  }
  if (field.type === "autodate" || field.type === "date") {
    if (typeof val === "number") return val;
    if (typeof val === "string") {
      const t = Date.parse(val);
      return isNaN(t) ? null : Math.floor(t / 1000);
    }
    return null;
  }
  if (isJsonField(field)) {
    return typeof val === "string" ? val : JSON.stringify(val);
  }
  return val;
}

/** Decode a DB value back to the JS shape the API returns. */
function decodeValue(val: unknown, field: FieldDef): unknown {
  if (val === null || val === undefined) return null;
  if (field.type === "bool") return val === 1 || val === true || val === "1" || val === "true";
  if (isJsonField(field)) {
    if (typeof val === "string") {
      try { return JSON.parse(val); } catch { return val; }
    }
  }
  return val;
}

function rowToMeta(
  row: Record<string, unknown>,
  col: Collection,
  fields: FieldDef[]
): RecordWithMeta {
  const fieldByName = new Map(fields.map((f) => [f.name, f]));
  const out: RecordWithMeta = {
    id: String(row["id"]),
    collectionId: col.id,
    collectionName: col.name,
    created: Number(row["created_at"] ?? 0),
    updated: Number(row["updated_at"] ?? 0),
  };
  for (const [k, v] of Object.entries(row)) {
    if (k === "id" || k === "created_at" || k === "updated_at") continue;
    const def = fieldByName.get(k);
    out[k] = def ? decodeValue(v, def) : v;
  }
  return out;
}

// ── List ─────────────────────────────────────────────────────────────────────

export async function listRecords(
  collectionName: string,
  opts: ListOptions = {}
): Promise<ListResult> {
  const col = await getCollection(collectionName);
  if (!col) throw new Error(`Collection '${collectionName}' not found`);

  const fields = parseFields(col.fields);
  const tname = userTableName(col.name);
  const tableRef = quoteIdent(tname);
  const client = rawClient();

  const page = opts.page ?? 1;
  const perPage = opts.perPage ?? 30;
  const offset = (page - 1) * perPage;

  // Build WHERE
  type Binding = string | number | bigint | boolean | null | Uint8Array;
  const whereParts: string[] = [];
  const whereParams: Binding[] = [];

  if (opts.filter) {
    const compiled = parseFilter(opts.filter, tname, opts.auth ?? null);
    if (compiled) { whereParts.push(compiled.sql); whereParams.push(...(compiled.params as Binding[])); }
  }
  if (opts.accessRule) {
    const compiled = parseFilter(opts.accessRule, tname, opts.auth ?? null);
    if (compiled) { whereParts.push(compiled.sql); whereParams.push(...(compiled.params as Binding[])); }
  }
  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

  // Build ORDER BY
  const sortSpec = opts.sort ?? "-created_at";
  const orderClauses = sortSpec.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const desc = s.startsWith("-");
    const field = desc ? s.slice(1) : s;
    const colName = field === "created" ? "created_at" : field === "updated" ? "updated_at" : field;
    return `${tableRef}.${quoteIdent(colName)} ${desc ? "DESC" : "ASC"}`;
  });
  const orderSql = orderClauses.length > 0 ? `ORDER BY ${orderClauses.join(", ")}` : "";

  // Execute SELECT
  const rows = client
    .prepare(`SELECT * FROM ${tableRef} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`)
    .all(...whereParams, perPage, offset) as Record<string, unknown>[];

  // Total count (optional)
  let totalItems = -1;
  let totalPages = -1;
  if (!opts.skipTotal) {
    const cnt = client
      .prepare(`SELECT COUNT(*) AS c FROM ${tableRef} ${whereSql}`)
      .get(...whereParams) as { c: number } | undefined;
    totalItems = cnt?.c ?? 0;
    totalPages = Math.ceil(totalItems / perPage);
  }

  let items = rows.map((r) => rowToMeta(r, col, fields));

  // Expand
  if (opts.expand) {
    const expandFields = opts.expand.split(",").map((s) => s.trim()).filter(Boolean);
    await expandRelations(items, expandFields, fields);
  }

  // Field projection
  if (opts.fields) {
    const keep = opts.fields.split(",").map((s) => s.trim()).filter(Boolean);
    items = items.map((it) => projectFields(it, keep));
  }

  return { data: items, page, perPage, totalItems, totalPages };
}

function projectFields(item: RecordWithMeta, keep: string[]): RecordWithMeta {
  const out: Record<string, unknown> = {};
  for (const k of keep) {
    if (k in item) out[k] = item[k as keyof RecordWithMeta];
  }
  if (!("id" in out) && "id" in item) out["id"] = item.id;
  return out as RecordWithMeta;
}

// ── Get one ─────────────────────────────────────────────────────────────────

export async function getRecord(
  collectionName: string,
  id: string
): Promise<RecordWithMeta | null> {
  const col = await getCollection(collectionName);
  if (!col) return null;
  const fields = parseFields(col.fields);
  const tableRef = quoteIdent(userTableName(col.name));
  const client = rawClient();
  const row = client.prepare(`SELECT * FROM ${tableRef} WHERE "id" = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToMeta(row, col, fields) : null;
}

// ── Create ──────────────────────────────────────────────────────────────────

export async function createRecord(
  collectionName: string,
  data: Record<string, unknown> | null | undefined
): Promise<RecordWithMeta> {
  const col = await getCollection(collectionName);
  if (!col) throw new Error(`Collection '${collectionName}' not found`);
  data = data ?? {};

  await validateRecord(col, data, "create");

  const fields = parseFields(col.fields);
  const userFields = fields.filter((f) => !f.system);
  const fieldByName = new Map(userFields.map((f) => [f.name, f]));
  const now = Math.floor(Date.now() / 1000);

  // Apply autodate onCreate
  for (const f of userFields) {
    if (f.type === "autodate" && f.onCreate) (data as Record<string, unknown>)[f.name] = now;
  }

  type Binding = string | number | bigint | boolean | null | Uint8Array;
  const id = crypto.randomUUID();
  const insertCols: string[] = ["id"];
  const insertVals: Binding[] = [id];

  for (const f of userFields) {
    if (f.type === "autodate") continue; // not stored as user column
    if (Object.prototype.hasOwnProperty.call(data, f.name)) {
      insertCols.push(f.name);
      insertVals.push(encodeValue((data as Record<string, unknown>)[f.name], f) as Binding);
    }
  }

  insertCols.push("created_at", "updated_at");
  insertVals.push(now, now);

  const tableRef = quoteIdent(userTableName(col.name));
  const colsSql = insertCols.map(quoteIdent).join(", ");
  const placeholders = insertCols.map(() => "?").join(", ");

  const client = rawClient();
  client.prepare(`INSERT INTO ${tableRef} (${colsSql}) VALUES (${placeholders})`).run(...insertVals);

  const row = client.prepare(`SELECT * FROM ${tableRef} WHERE "id" = ?`).get(id) as Record<string, unknown>;
  const result = rowToMeta(row, col, fields);
  broadcast(col.name, { type: "create", collection: col.name, record: result });
  return result;
}

// ── Update ──────────────────────────────────────────────────────────────────

export async function updateRecord(
  collectionName: string,
  id: string,
  data: Record<string, unknown> | null | undefined
): Promise<RecordWithMeta> {
  const col = await getCollection(collectionName);
  if (!col) throw new Error(`Collection '${collectionName}' not found`);
  data = data ?? {};

  const existing = await getRecord(collectionName, id);
  if (!existing) throw new Error("Record not found");

  await validateRecord(col, data, "update", id);

  const fields = parseFields(col.fields);
  const userFields = fields.filter((f) => !f.system);
  const now = Math.floor(Date.now() / 1000);

  // Apply autodate onUpdate
  for (const f of userFields) {
    if (f.type === "autodate" && f.onUpdate) (data as Record<string, unknown>)[f.name] = now;
  }

  type Binding = string | number | bigint | boolean | null | Uint8Array;
  const setCols: string[] = [];
  const setVals: Binding[] = [];
  for (const f of userFields) {
    if (f.type === "autodate") continue;
    if (Object.prototype.hasOwnProperty.call(data, f.name)) {
      setCols.push(`${quoteIdent(f.name)} = ?`);
      setVals.push(encodeValue((data as Record<string, unknown>)[f.name], f) as Binding);
    }
  }
  setCols.push(`"updated_at" = ?`);
  setVals.push(now);

  const tableRef = quoteIdent(userTableName(col.name));
  const client = rawClient();

  if (setCols.length > 1) {
    client.prepare(`UPDATE ${tableRef} SET ${setCols.join(", ")} WHERE "id" = ?`).run(...setVals, id);
  }

  const row = client.prepare(`SELECT * FROM ${tableRef} WHERE "id" = ?`).get(id) as Record<string, unknown>;
  const result = rowToMeta(row, col, fields);
  broadcast(col.name, { type: "update", collection: col.name, record: result });
  return result;
}

// ── Delete ──────────────────────────────────────────────────────────────────

export async function deleteRecord(
  collectionName: string,
  id: string
): Promise<void> {
  const col = await getCollection(collectionName);
  if (!col) throw new Error(`Collection '${collectionName}' not found`);
  const tableRef = quoteIdent(userTableName(col.name));
  rawClient().prepare(`DELETE FROM ${tableRef} WHERE "id" = ?`).run(id);
  broadcast(col.name, { type: "delete", collection: col.name, id });
}

// ── Relation expand ─────────────────────────────────────────────────────────

async function expandRelations(
  items: RecordWithMeta[],
  expandFields: string[],
  schema: FieldDef[]
): Promise<void> {
  const client = rawClient();

  for (const fieldName of expandFields) {
    const fieldDef = schema.find((f) => f.name === fieldName && f.type === "relation");
    if (!fieldDef?.collection) continue;

    const targetCol = await getCollection(fieldDef.collection);
    if (!targetCol) continue;
    const targetFields = parseFields(targetCol.fields);
    const targetTable = quoteIdent(userTableName(targetCol.name));

    const ids = [
      ...new Set(
        items
          .map((it) => it[fieldName])
          .filter((v): v is string => typeof v === "string" && v.length > 0)
      ),
    ];
    if (ids.length === 0) continue;

    const placeholders = ids.map(() => "?").join(", ");
    const rows = client
      .prepare(`SELECT * FROM ${targetTable} WHERE "id" IN (${placeholders})`)
      .all(...ids) as Record<string, unknown>[];

    const byId = new Map(rows.map((r) => [String(r["id"]), rowToMeta(r, targetCol, targetFields)]));

    for (const item of items) {
      const refId = item[fieldName];
      if (typeof refId === "string" && byId.has(refId)) {
        if (!item.expand) item.expand = {};
        item.expand[fieldName] = byId.get(refId);
      }
    }
  }
}
