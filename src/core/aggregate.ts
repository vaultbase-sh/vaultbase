/**
 * Aggregations over a collection: `GET /api/v1/:collection/_aggregate`.
 *
 *   ?agg=count,sum(amount),avg(amount),min(created),max(score),count(email)
 *   &groupBy=status,created:month
 *   &filter=...&search=...&sort=-count&limit=50
 *
 * Rows are scoped exactly like a list (filter, search, list rule) via
 * `compileListWhere`, so a caller only ever aggregates records they could
 * list. Every field name is checked against the schema before it reaches
 * SQL; implicit auth columns, passwords and encrypted fields are refused.
 */
import { db } from "../db/index.ts";
import type { Collection } from "../db/schema.ts";
import { privateFieldNames, parseFields, userTableName, type FieldDef } from "./collections.ts";
import { compileListWhere, FilterError, type ListOptions } from "./records.ts";

export type AggFn = "count" | "sum" | "avg" | "min" | "max";
export type Bucket = "hour" | "day" | "week" | "month" | "year";

export const MAX_AGGS = 10;
export const MAX_GROUP_BY = 3;
export const DEFAULT_GROUP_LIMIT = 100;
export const MAX_GROUP_LIMIT = 1000;

const BUCKET_FMT: Record<Bucket, string> = {
  hour: "%Y-%m-%dT%H:00",
  day: "%Y-%m-%d",
  week: "%Y-W%W",
  month: "%Y-%m",
  year: "%Y",
};

const NUMERIC = new Set(["number"]);
const TIME = new Set(["date", "autodate"]);
/** Types whose stored value is a scalar worth grouping or comparing. */
const SCALAR = new Set(["text", "number", "bool", "select", "relation", "email", "url", "date", "autodate", "editor", "color"]);

export interface AggregateOptions extends Pick<ListOptions, "filter" | "search" | "accessRule" | "auth" | "request"> {
  agg?: string;
  groupBy?: string;
  sort?: string;
  limit?: number;
}

export interface AggregateResult {
  data: Array<Record<string, unknown>>;
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

interface Column { sql: string; type: string | null }

/** Map a public field name to its column, refusing anything not plainly readable. */
function resolveColumn(col: Collection, fields: FieldDef[], name: string): Column {
  if (name === "id") return { sql: q("id"), type: "text" };
  if (name === "created" || name === "created_at") return { sql: q("created_at"), type: "autodate" };
  if (name === "updated" || name === "updated_at") return { sql: q("updated_at"), type: "autodate" };
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) throw new FilterError(`unknown field '${name}'`);
  // Private columns (auth secrets, password fields — in a view too) are
  // unknown here, as they are to filters: grouping returns their values.
  if (privateFieldNames(col).has(name)) throw new FilterError(`unknown field '${name}'`);
  const f = fields.find((x) => x.name === name);
  // View fields are inferred and untyped; anything the view exposes is fair game.
  if (col.type === "view") {
    if (!f) throw new FilterError(`unknown field '${name}'`);
    return { sql: q(name), type: null };
  }
  if (!f || f.system || f.implicit) throw new FilterError(`unknown field '${name}'`);
  if (f.options?.encrypted) throw new FilterError(`'${name}' is encrypted and can't be aggregated`);
  if (!SCALAR.has(f.type) || f.options?.multiple) throw new FilterError(`'${name}' (${f.type}) can't be aggregated`);
  return { sql: q(name), type: f.type };
}

interface AggSpec { fn: AggFn; field: string | null; alias: string; sql: string }

function parseAggs(col: Collection, fields: FieldDef[], raw: string | undefined): AggSpec[] {
  const parts = (raw ?? "count").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) parts.push("count");
  if (parts.length > MAX_AGGS) throw new FilterError(`at most ${MAX_AGGS} aggregates`);
  const out: AggSpec[] = [];
  for (const p of parts) {
    const m = /^(count|sum|avg|min|max)(?:\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\))?$/.exec(p);
    if (!m) throw new FilterError(`invalid aggregate '${p}' (use count, count(f), sum(f), avg(f), min(f), max(f))`);
    const fn = m[1] as AggFn;
    const field = m[2] ?? null;
    if (!field) {
      if (fn !== "count") throw new FilterError(`${fn} needs a field, e.g. ${fn}(amount)`);
      out.push({ fn, field, alias: "count", sql: "COUNT(*)" });
      continue;
    }
    const c = resolveColumn(col, fields, field);
    if ((fn === "sum" || fn === "avg") && c.type !== null && !NUMERIC.has(c.type)) {
      throw new FilterError(`${fn}(${field}): '${field}' is not a number field`);
    }
    out.push({ fn, field, alias: `${fn}_${field}`, sql: `${fn.toUpperCase()}(${c.sql})` });
  }
  const seen = new Set<string>();
  for (const a of out) {
    if (seen.has(a.alias)) throw new FilterError(`duplicate aggregate '${a.alias}'`);
    seen.add(a.alias);
  }
  return out;
}

interface GroupSpec { alias: string; sql: string }

function parseGroupBy(col: Collection, fields: FieldDef[], raw: string | undefined): GroupSpec[] {
  const parts = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length > MAX_GROUP_BY) throw new FilterError(`at most ${MAX_GROUP_BY} groupBy fields`);
  const out: GroupSpec[] = [];
  for (const p of parts) {
    const [name, bucket] = p.split(":") as [string, string | undefined];
    const c = resolveColumn(col, fields, name);
    const alias = name === "created_at" ? "created" : name === "updated_at" ? "updated" : name;
    if (out.some((g) => g.alias === alias)) throw new FilterError(`duplicate groupBy '${alias}'`);
    if (bucket === undefined) {
      out.push({ alias, sql: c.sql });
      continue;
    }
    if (!(bucket in BUCKET_FMT)) throw new FilterError(`invalid bucket '${bucket}' (use hour, day, week, month, year)`);
    if (c.type !== null && !TIME.has(c.type)) throw new FilterError(`'${name}:${bucket}': '${name}' is not a date field`);
    out.push({ alias, sql: `strftime('${BUCKET_FMT[bucket as Bucket]}', ${c.sql}, 'unixepoch')` });
  }
  return out;
}

function parseSort(raw: string | undefined, aliases: Set<string>, groups: GroupSpec[], aggs: AggSpec[]): string {
  const clauses: string[] = [];
  for (const s of (raw ?? "").split(",").map((x) => x.trim()).filter(Boolean)) {
    const desc = s.startsWith("-");
    const key = desc ? s.slice(1) : s;
    if (!aliases.has(key)) throw new FilterError(`can't sort by '${key}': not a groupBy field or aggregate`);
    clauses.push(`${q(key)} ${desc ? "DESC" : "ASC"}`);
  }
  if (clauses.length === 0) {
    // Time buckets read naturally oldest-first; other groups biggest-first.
    if (groups.length > 0) {
      const first = aggs[0]!;
      clauses.push(groups[0]!.sql.startsWith("strftime(") ? `${q(groups[0]!.alias)} ASC` : `${q(first.alias)} DESC`);
    }
  }
  return clauses.length > 0 ? `ORDER BY ${clauses.join(", ")}` : "";
}

export async function aggregateRecords(col: Collection, opts: AggregateOptions): Promise<AggregateResult> {
  const fields = parseFields(col.fields);
  const aggs = parseAggs(col, fields, opts.agg);
  const groups = parseGroupBy(col, fields, opts.groupBy);
  for (const g of groups) {
    if (aggs.some((a) => a.alias === g.alias)) throw new FilterError(`'${g.alias}' is both a groupBy field and an aggregate`);
  }
  const aliases = new Set([...groups.map((g) => g.alias), ...aggs.map((a) => a.alias)]);
  const orderSql = parseSort(opts.sort, aliases, groups, aggs);

  const limitRaw = opts.limit ?? DEFAULT_GROUP_LIMIT;
  const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_GROUP_LIMIT) : DEFAULT_GROUP_LIMIT;

  const where = await compileListWhere(col, opts);
  const select = [
    ...groups.map((g) => `${g.sql} AS ${q(g.alias)}`),
    ...aggs.map((a) => `${a.sql} AS ${q(a.alias)}`),
  ].join(", ");
  const groupSql = groups.length > 0 ? `GROUP BY ${groups.map((_, i) => i + 1).join(", ")}` : "";
  const sql = `SELECT ${select} FROM ${q(userTableName(col.name))} ${where.whereSql} ${groupSql} ${orderSql} LIMIT ?`;

  let rows: Array<Record<string, unknown>>;
  try {
    rows = await db.all<Record<string, unknown>>(sql, [...where.whereParams, limit]);
  } catch (e) {
    if (opts.search && e instanceof Error && /fts5/i.test(e.message)) throw new FilterError(`invalid search: ${e.message}`);
    throw e;
  }
  // Booleans are stored as 0/1; hand them back as booleans in group keys.
  const boolGroups = groups.filter((g) => fields.find((f) => f.name === g.alias)?.type === "bool");
  if (boolGroups.length > 0) {
    for (const r of rows) for (const g of boolGroups) if (r[g.alias] !== null) r[g.alias] = r[g.alias] === 1;
  }
  return { data: rows };
}
