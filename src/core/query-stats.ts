/**
 * List-query statistics and index suggestions.
 *
 * Every record list records its SQL shape (the statement with `?` for the
 * bound values) and how long the SELECT and the count took. The admin
 * Monitoring page reads the shapes sorted by total time, each with SQLite's
 * query plan and, where the plan scans the table or sorts in memory, the
 * index that would serve it.
 *
 * Recording costs one Map lookup and a few additions per list. Plans are
 * only explained when a report is asked for, once per shape until the
 * schema changes (an index was created or dropped).
 */
import type { Database } from "bun:sqlite";

export interface ListQuerySample {
  collection: string;
  /** SQLite table (or view) the list reads. */
  table: string;
  /** View collections can't be indexed. */
  view: boolean;
  /** The SELECT as prepared, values bound as `?`. Keys the shape. */
  selectSql: string;
  /** The compiled WHERE clause, used to find the filtered columns. */
  whereSql: string;
  /** Sort columns in order, without the rowid tiebreaker. */
  sortCols: string[];
  /** The caller's filter and sort strings, kept as an example of the shape. */
  filter?: string | undefined;
  sort?: string | undefined;
  /** A full-text search joined the FTS table. */
  search: boolean;
  /** SELECT plus count, microseconds. */
  us: number;
}

interface Shape {
  collection: string;
  table: string;
  view: boolean;
  selectSql: string;
  whereSql: string;
  sortCols: string[];
  filter: string | null;
  sort: string | null;
  search: boolean;
  count: number;
  total_us: number;
  max_us: number;
  first_seen: number;
  last_seen: number;
  /** Cached plan, valid for one schema version. */
  plan: { schema: number; rows: PlanRow[] } | null;
}

/** One row of EXPLAIN QUERY PLAN; `parent` is 0 for the outer query. */
export interface PlanRow { id: number; parent: number; detail: string }

export interface QueryReport {
  /** Stable id for the shape (hash of the SQL). */
  id: string;
  collection: string;
  filter: string | null;
  sort: string | null;
  search: boolean;
  /** The rowid-first form used past the deep-page offset. */
  deep: boolean;
  count: number;
  mean_us: number;
  max_us: number;
  total_us: number;
  /** Unix seconds. */
  first_seen: number;
  last_seen: number;
  /** Rows in the table when the report ran. */
  rows: number;
  plan: string[];
  /** The plan reads the whole table without an index. */
  scan: boolean;
  /** The plan sorts the matched rows in a temporary b-tree. */
  temp_sort: boolean;
  suggestion: { fields: string[]; name: string } | null;
}

const MAX_SHAPES = 256;
const MAX_EXAMPLE = 200;
/** Scans of smaller tables cost less than the index would. */
export const SUGGEST_MIN_ROWS = 1_000;
const ROWS_TTL_MS = 30_000;

const shapes = new Map<string, Shape>();
/** Shapes reported by read worker threads, latest per worker; merged into the report. */
const external = new Map<string, ExportedShape[]>();

/** A shape without its cached plan, as a worker posts it. */
export type ExportedShape = Omit<Shape, "plan">;

export function exportShapes(): ExportedShape[] {
  return [...shapes.values()].map(({ plan: _plan, ...rest }) => rest);
}

/** Replace what one worker last reported. `null` forgets it. */
export function setExternalShapes(id: string, list: ExportedShape[] | null): void {
  if (list) external.set(id, list); else external.delete(id);
}

export function recordListQuery(s: ListQuerySample): void {
  const now = Date.now();
  let e = shapes.get(s.selectSql);
  if (!e) {
    if (shapes.size >= MAX_SHAPES) evictCheapest();
    e = {
      collection: s.collection,
      table: s.table,
      view: s.view,
      selectSql: s.selectSql,
      whereSql: s.whereSql,
      sortCols: s.sortCols,
      filter: s.filter ? s.filter.slice(0, MAX_EXAMPLE) : null,
      sort: s.sort ?? null,
      search: s.search,
      count: 0,
      total_us: 0,
      max_us: 0,
      first_seen: now,
      last_seen: now,
      plan: null,
    };
    shapes.set(s.selectSql, e);
  }
  e.count++;
  e.total_us += s.us;
  if (s.us > e.max_us) e.max_us = s.us;
  e.last_seen = now;
}

function evictCheapest(): void {
  let victim: string | null = null;
  let least = Infinity;
  for (const [k, e] of shapes) {
    if (e.total_us < least) { least = e.total_us; victim = k; }
  }
  if (victim !== null) shapes.delete(victim);
}

export function resetQueryStats(): void {
  shapes.clear();
  external.clear();
  rowCounts.clear();
}

/** This thread's shapes plus the workers', summed by SQL. Plans are cached on the merged copy. */
const mergedPlans = new Map<string, { schema: number; rows: PlanRow[] }>();
function mergedShapes(): Shape[] {
  const out = new Map<string, Shape>();
  const add = (e: ExportedShape, plan: Shape["plan"]) => {
    const m = out.get(e.selectSql);
    if (!m) { out.set(e.selectSql, { ...e, plan }); return; }
    m.count += e.count;
    m.total_us += e.total_us;
    if (e.max_us > m.max_us) m.max_us = e.max_us;
    if (e.first_seen < m.first_seen) m.first_seen = e.first_seen;
    if (e.last_seen > m.last_seen) m.last_seen = e.last_seen;
    if (!m.filter && e.filter) m.filter = e.filter;
  };
  for (const e of shapes.values()) add(e, e.plan);
  for (const list of external.values()) for (const e of list) add(e, mergedPlans.get(e.selectSql) ?? null);
  return [...out.values()];
}

// ── Report ──────────────────────────────────────────────────────────────────

const rowCounts = new Map<string, { at: number; rows: number }>();

function rowCount(client: Database, table: string): number {
  const hit = rowCounts.get(table);
  const now = Date.now();
  if (hit && now - hit.at < ROWS_TTL_MS) return hit.rows;
  let rows = 0;
  try {
    rows = (client.prepare(`SELECT COUNT(*) AS c FROM ${quote(table)}`).get() as { c: number }).c;
  } catch { /* table gone: report 0 */ }
  rowCounts.set(table, { at: now, rows });
  return rows;
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function schemaVersion(client: Database): number {
  try {
    return (client.prepare("PRAGMA schema_version").get() as { schema_version: number }).schema_version;
  } catch { return 0; }
}

function explain(client: Database, e: Shape, schema: number): PlanRow[] {
  if (e.plan && e.plan.schema === schema) return e.plan.rows;
  let rows: PlanRow[] = [];
  try {
    // Unbound parameters are NULL; the plan doesn't depend on them.
    rows = (client.prepare(`EXPLAIN QUERY PLAN ${e.selectSql}`).all() as Array<{ id: number; parent: number; detail: string }>)
      .map((r) => ({ id: r.id, parent: r.parent, detail: r.detail }));
  } catch { /* a view that no longer exists, or a MATCH on a dropped FTS table */ }
  e.plan = { schema, rows };
  return rows;
}

/** Plan rows as text, nested rows indented. */
function planText(rows: PlanRow[]): string[] {
  const depth = (r: PlanRow): number => {
    let d = 0;
    let p = r.parent;
    for (let i = 0; p !== 0 && i < 16; i++) { const up = rows.find((x) => x.id === p); if (!up) break; d++; p = up.parent; }
    return d;
  };
  return rows.map((r) => `${"  ".repeat(depth(r))}${r.detail}`);
}

/**
 * The rows whose work sets the cost. A deep page (rowid-first form) is
 * driven by its subquery; the outer query only re-sorts the page's rows.
 */
function costRows(rows: PlanRow[], deep: boolean): PlanRow[] {
  if (!deep) return rows;
  const inner = rows.filter((r) => r.parent !== 0);
  return inner.length > 0 ? inner : rows;
}

/** Existing indexes on `table`, each as its column list in order. */
function indexColumns(client: Database, table: string): string[][] {
  const out: string[][] = [];
  try {
    const list = client.prepare(`PRAGMA index_list(${quote(table)})`).all() as Array<{ name: string }>;
    for (const ix of list) {
      const cols = client.prepare(`PRAGMA index_info(${quote(ix.name)})`).all() as Array<{ seqno: number; name: string | null }>;
      out.push(cols.sort((a, b) => a.seqno - b.seqno).map((c) => c.name ?? ""));
    }
  } catch { /* not a table */ }
  return out;
}

/**
 * Columns of the host table the WHERE clause constrains, split by whether
 * the constraint is an equality (`=` or `IN`), which an index can seek on.
 */
export function constrainedColumns(whereSql: string, table: string): { eq: string[]; range: string[] } {
  const eq: string[] = [];
  const range: string[] = [];
  const re = new RegExp(`${quote(table).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\."([A-Za-z0-9_]+)"\\s*(=|IN\\s*\\(|>=|<=|>|<|LIKE|GLOB|BETWEEN)`, "g");
  for (const m of whereSql.matchAll(re)) {
    const col = m[1]!;
    const op = m[2]!;
    const list = op === "=" || op.startsWith("IN") ? eq : range;
    if (!list.includes(col)) list.push(col);
  }
  return { eq, range };
}

export interface PlanShape {
  /** The host table is read in full with no index. */
  fullScan: boolean;
  /** The host table is walked through an index (an ordered walk, not a seek). */
  indexScan: boolean;
  /** Matched rows are sorted in a temporary b-tree. */
  temp_sort: boolean;
}

/** What the plan does with the host table. */
export function analyzePlan(details: string[], table: string): PlanShape {
  let fullScan = false;
  let indexScan = false;
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tableRe = new RegExp(`^(SCAN|SEARCH)(?: TABLE)? "?${escaped}"?(?:\\s|$)`);
  for (const d of details) {
    const m = tableRe.exec(d);
    if (m && m[1] === "SCAN") {
      if (/USING (COVERING )?INDEX/.test(d)) indexScan = true;
      else fullScan = true;
    }
  }
  const temp_sort = details.some((d) => /USE TEMP B-TREE FOR ORDER BY/.test(d));
  return { fullScan, indexScan, temp_sort };
}

/**
 * The index that would let SQLite seek instead of scan, or sort from the
 * index instead of a temp b-tree: the equality columns first, then the
 * leading sort column. Null when the plan is fine, the table is small, the
 * list is a full-text search, or such an index already exists.
 */
export function suggestIndex(e: Pick<Shape, "collection" | "table" | "view" | "whereSql" | "sortCols" | "search">, plan: PlanShape, rows: number, existing: string[][]): { fields: string[]; name: string } | null {
  if (e.view || e.search || rows < SUGGEST_MIN_ROWS) return null;
  const { eq, range } = constrainedColumns(e.whereSql, e.table);
  const sortLead = e.sortCols.find((c) => !eq.includes(c)) ?? null;
  let fields: string[] | null = null;
  if ((plan.fullScan || plan.indexScan) && eq.length > 0) {
    // The filter isn't seeking: equality columns first, then the sort.
    fields = sortLead ? [...eq, sortLead] : eq;
  } else if (plan.fullScan) {
    if (sortLead) fields = [sortLead];
    else if (range.length > 0) fields = [range[0]!];
  } else if (plan.temp_sort && sortLead) {
    fields = [...eq, sortLead];
  }
  if (!fields || fields.length === 0) return null;
  // A single-column range filter sorted by the same column is served by that column alone.
  if (fields.length === 1 && range.includes(fields[0]!) && sortLead === fields[0]) fields = [fields[0]!];
  const covered = existing.some((cols) => cols.length >= fields!.length && fields!.every((f, i) => cols[i] === f));
  if (covered) return null;
  return { fields, name: `idx_${e.collection}_${fields.join("_")}` };
}

/** Shapes sorted by total time, with plans and suggestions. */
export function queryStatsReport(client: Database, limit = 50): QueryReport[] {
  const schema = schemaVersion(client);
  const indexCache = new Map<string, string[][]>();
  const out: QueryReport[] = [];
  const sorted = mergedShapes().sort((a, b) => b.total_us - a.total_us).slice(0, limit);
  for (const e of sorted) {
    const planRows = explain(client, e, schema);
    // Keep the plan for shapes that live only on a worker, so it isn't re-explained per report.
    if (!shapes.has(e.selectSql) && e.plan) mergedPlans.set(e.selectSql, e.plan);
    const deep = / IN \(SELECT /.test(e.selectSql);
    const plan = analyzePlan(costRows(planRows, deep).map((r) => r.detail), e.table);
    const rows = e.view ? 0 : rowCount(client, e.table);
    let existing = indexCache.get(e.table);
    if (!existing) { existing = e.view ? [] : indexColumns(client, e.table); indexCache.set(e.table, existing); }
    out.push({
      id: Bun.hash(e.selectSql).toString(36),
      collection: e.collection,
      filter: e.filter,
      sort: e.sort,
      search: e.search,
      deep,
      count: e.count,
      mean_us: Math.round(e.total_us / e.count),
      max_us: Math.round(e.max_us),
      total_us: Math.round(e.total_us),
      first_seen: Math.floor(e.first_seen / 1000),
      last_seen: Math.floor(e.last_seen / 1000),
      rows,
      plan: planText(planRows),
      scan: plan.fullScan,
      temp_sort: plan.temp_sort,
      suggestion: suggestIndex(e, plan, rows, existing),
    });
  }
  return out;
}
