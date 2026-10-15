/**
 * DDL for the fixed tables, generated from the drizzle declarations in
 * schema.ts so the schema is declared once. The dialect turns a column
 * description into its CREATE TABLE / ADD COLUMN text; the golden test
 * (`__tests__/golden/fixed-schema.txt`) pins the resulting structure.
 *
 * `ensureFixedSchema` is the upgrade path: it creates every table that is
 * missing, adds every column that is missing from an existing table, and
 * creates every index, all idempotently. A column with an expression
 * default (the epoch timestamps) cannot be added to an existing table on
 * SQLite; no upgrade path needs that today, and it fails loudly rather
 * than quietly diverging.
 */
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import { SQL } from "drizzle-orm";
import { db } from "./index.ts";
import { EPOCH_NOW } from "./schema.ts";
import { FIXED_INDEXES, FIXED_TABLES } from "./fixed-schema.ts";

export type ColumnType = "text" | "integer" | "real" | "blob";

export interface ColumnSpec {
  name: string;
  type: ColumnType;
  primaryKey: boolean;
  notNull: boolean;
  unique: boolean;
  default?: { kind: "literal"; value: string | number } | { kind: "epochNow" };
}

export interface IndexSpec {
  name: string;
  table: string;
  /** Column expressions as they appear in the index, e.g. `updated_at DESC`. */
  columns: string[];
  unique?: boolean;
  /** Partial-index predicate, without `WHERE`. */
  where?: string;
}

/** The columns of a drizzle table, as the dialect needs them. */
export function columnSpecs(table: SQLiteTable): ColumnSpec[] {
  const cfg = getTableConfig(table);
  return cfg.columns.map((c) => {
    const sqlType = c.getSQLType().toLowerCase();
    const type: ColumnType = sqlType === "integer" ? "integer" : sqlType === "real" ? "real" : "text";
    const spec: ColumnSpec = { name: c.name, type, primaryKey: c.primary, notNull: c.notNull, unique: c.isUnique };
    if (c.default !== undefined) {
      if (c.default === EPOCH_NOW) spec.default = { kind: "epochNow" };
      else if (typeof c.default === "string" || typeof c.default === "number") spec.default = { kind: "literal", value: c.default };
      else if (c.default instanceof SQL) throw new Error(`${cfg.name}.${c.name}: SQL defaults other than EPOCH_NOW are not supported`);
      else throw new Error(`${cfg.name}.${c.name}: unsupported default ${String(c.default)}`);
    }
    return spec;
  });
}

export function tableName(table: SQLiteTable): string {
  return getTableConfig(table).name;
}

/** Create missing tables, add missing columns, create missing indexes. */
export async function ensureFixedSchema(): Promise<void> {
  const d = db.dialect;
  for (const table of FIXED_TABLES) {
    const name = tableName(table);
    const specs = columnSpecs(table);
    await db.exec(d.createTable(name, specs));
    const present = new Set((await db.all<{ name: string }>(d.listColumnsSql(name))).map((r) => r.name));
    for (const spec of specs) {
      if (present.has(spec.name)) continue;
      if (spec.default?.kind === "epochNow") {
        throw new Error(`[migrate] ${name}.${spec.name} is missing and has an expression default; add it by hand`);
      }
      await db.exec(d.addColumn(name, spec));
    }
  }
  for (const ix of FIXED_INDEXES) await db.exec(d.createIndex(ix));
}
