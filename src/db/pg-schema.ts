/**
 * The drizzle pg-core tables, built at load from the sqlite-core
 * declarations in schema.ts so the fixed schema stays declared once. Call
 * sites keep compiling against the sqlite types (`typeof schema`); at
 * runtime, under Postgres, `getDb()` hands them these tables. The query
 * builder API the code uses is the part both dialects share, and the suite
 * run on Postgres is what proves that.
 */
import { sql } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { bigint, doublePrecision, pgTable, text, type PgColumnBuilderBase } from "drizzle-orm/pg-core";
import * as sqliteSchema from "./schema.ts";
import { EPOCH_MS_NOW, EPOCH_NOW } from "./schema.ts";

const PG_EPOCH_NOW = sql`(extract(epoch from now())::bigint)`;
const PG_EPOCH_MS_NOW = sql`(extract(epoch from clock_timestamp()) * 1000)`;

function pgColumn(name: string, c: { getSQLType(): string; primary: boolean; notNull: boolean; isUnique: boolean; default: unknown }): PgColumnBuilderBase {
  const t = c.getSQLType().toLowerCase();
  let b = t === "integer" ? bigint(name, { mode: "number" }) : t === "real" ? doublePrecision(name) : text(name);
  if (c.primary) b = b.primaryKey() as typeof b;
  else if (c.notNull) b = b.notNull() as typeof b;
  if (c.isUnique) b = b.unique() as typeof b;
  if (c.default !== undefined) {
    if (c.default === EPOCH_NOW) b = b.default(PG_EPOCH_NOW) as typeof b;
    else if (c.default === EPOCH_MS_NOW) b = b.default(PG_EPOCH_MS_NOW) as typeof b;
    else b = b.default(c.default as never) as typeof b;
  }
  return b as unknown as PgColumnBuilderBase;
}

/** A pg-core table with the same keys, names, types and defaults as the sqlite one. */
export function pgTableFromSqlite(table: SQLiteTable): ReturnType<typeof pgTable> {
  const name = getTableConfig(table).name;
  const columns: Record<string, PgColumnBuilderBase> = {};
  for (const [key, col] of Object.entries(getTableColumns(table))) {
    columns[key] = pgColumn(col.name, col as unknown as Parameters<typeof pgColumn>[1]);
  }
  return pgTable(name, columns);
}

function isTable(v: unknown): v is SQLiteTable {
  return typeof v === "object" && v !== null && Symbol.for("drizzle:Name") in (v as object);
}

/** Every exported table of schema.ts, as a pg-core table under the same export name. */
export const pgSchema: Record<string, ReturnType<typeof pgTable>> = Object.fromEntries(
  Object.entries(sqliteSchema).filter(([, v]) => isTable(v)).map(([k, v]) => [k, pgTableFromSqlite(v as SQLiteTable)]),
);
