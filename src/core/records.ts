import { AsyncLocalStorage } from "node:async_hooks";
import { getDb, onCloseDb } from "../db/client.ts";
import type { Collection } from "../db/schema.ts";
import type { RequestContextLike } from "./filter.ts";
import {
  getCollection,
  getCollectionCached,
  getSchemaVersion,
  listCollections,
  parseFields,
  cachedFields,
  userTableName,
  type CascadeMode,
  type FieldDef, AUTH_PRIVATE_COLUMNS, baseColumnName, privateFieldNames, sensitiveSchema } from "./collections.ts";
import { parseFilter, type CollectionLookup } from "./filter.ts";
import { tableColumns } from "./users-table.ts";
import { fieldTypesVersion } from "./field-types.ts";
import { maybeRecordHistory } from "./record-history.ts";
import { hasFts, isSearchSyntaxError, rankedSelect, searchPredicate, searchQuery, SEARCH_COLUMN } from "./fts.ts";
import { recordListQuery } from "./query-stats.ts";
import { discardTableReports, flushTableReports, tableVersion, takeReportedChanges } from "./table-writes.ts";
import { db, driverOpen, getDriver, type DbDriver } from "../db/index.ts";
import { isReadWorker } from "./thread-bus.ts";

/**
 * Build a lookup the rule SQL compiler uses for joined-collection view_rule
 * inheritance + back-relation ref-field validation. Synchronous interface
 * (the compiler runs in a hot path), so we hit the in-process collection
 * cache. Cold-cache → returns null and the compiler conservatively denies
 * for non-admin callers.
 */
/** Test hook: statements held right now. */
export function _preparedStatementCount(): number {
  return driverOpen() ? db.preparedStatementCount() : 0;
}

/** Drop the cache when collection schema changes. */
export function invalidatePreparedStatements(): void {
  COUNT_CACHE.clear();
  if (driverOpen()) db.invalidateStatements();
}
onCloseDb(invalidatePreparedStatements);

/**
 * List totals cache. `COUNT(*)` under a filter walks every matching index
 * entry (a third of a 100k-row table costs ~0.5 ms, eight times the page
 * itself), and read-heavy apps ask the same totals over and over.
 *
 * An entry is only valid while its table is unchanged. `data_version` moves
 * on commits from any other connection (cluster workers, the CLI) and
 * `schema_version` on DDL: either empties the whole cache. `total_changes()`
 * moves on this connection's writes: when the rows it added up are exactly
 * the rows the write paths reported (table-writes.ts), only the reported
 * tables' entries are stale and the rest stay; a write nobody reported (raw
 * SQL from a hook or the SQL page) empties everything, as before.
 *
 * Inside a transaction (a shared commit holds one open for most of a busy
 * turn) the cache answers but is not filled: the sync above still runs, so
 * a write the transaction made is already reflected (reported, or everything
 * emptied), and a total counted mid-transaction is not kept, since a
 * rollback would leave it wrong with `total_changes()` already advanced.
 */
const COUNT_CACHE = new Map<string, { c: number; tv: number }>();
const COUNT_CACHE_MAX = 512;
let countCacheSeen: { t: number; d: number; s: number } | null = null;
/** The driver the cache was filled through; a reopened database gets a new one. */
let versionProbe: DbDriver | null = null;
const countCacheStats = { hits: 0, misses: 0 };

/** Test hook: how often the totals cache answered. */
export function _countCacheStats(): { hits: number; misses: number } {
  return { ...countCacheStats };
}

/**
 * Bring the cache up to date with the database: empty it when another
 * connection committed, the schema changed, or this connection wrote rows
 * nobody reported; otherwise the per-table versions decide.
 */
async function syncCountCache(): Promise<void> {
  const driver = getDriver();
  if (versionProbe !== driver) {
    // A reopened database (restore) starts its counters over, so its
    // versions can repeat the old connection's.
    COUNT_CACHE.clear();
    countCacheSeen = null;
    takeReportedChanges();
    versionProbe = driver;
  }
  // Without SQLite's counters the reported writes are the whole story: a
  // write nobody reported (raw SQL) is not seen, which the per-table
  // versions and the schema token bound to "stale until the next write".
  const v = db.capabilities.foreignCommitProbe
    ? (await db.get<{ t: number; d: number; s: number }>(
        `SELECT total_changes() AS t, (SELECT data_version FROM pragma_data_version) AS d, (SELECT schema_version FROM pragma_schema_version) AS s`,
      ))!
    : { t: 0, d: 0, s: db.schemaToken() };
  const reported = takeReportedChanges();
  const seen = countCacheSeen;
  // Another connection committed. On the main thread that is always
  // unknown work (a cluster worker, the CLI). On a read worker it is
  // usually the main thread, which reports the tables it wrote over the
  // bus; a move with nothing reported is someone else, so empty everything.
  const foreignCommit = !!seen && seen.d !== v.d && (!isReadWorker() || reported === 0);
  if (!seen || foreignCommit || seen.s !== v.s || (v.t !== seen.t && v.t - seen.t !== reported)) {
    COUNT_CACHE.clear();
  }
  countCacheSeen = v;
}

function countKey(sql: string, params: unknown[]): string {
  let key = sql;
  for (const p of params) {
    const s = String(p);
    key += `\u0000${typeof p}${s.length}:${s}`;
  }
  return key;
}

async function cachedCount(sql: string, params: unknown[], table: string): Promise<number> {
  const count = async () => (await db.get<{ c: number }>(sql, params))?.c ?? 0;
  const inTransaction = db.inTransaction;
  await syncCountCache();
  const tv = tableVersion(table);
  const key = countKey(sql, params);
  const hit = COUNT_CACHE.get(key);
  if (hit !== undefined && hit.tv === tv) { countCacheStats.hits++; return hit.c; }
  countCacheStats.misses++;
  const c = await count();
  if (inTransaction) return c;
  if (hit === undefined && COUNT_CACHE.size >= COUNT_CACHE_MAX) {
    const oldest = COUNT_CACHE.keys().next().value;
    if (oldest !== undefined) COUNT_CACHE.delete(oldest);
  }
  COUNT_CACHE.set(key, { c, tv });
  return c;
}

/**
 * Offset past which a list fetches the page's rowids first (index only) and
 * then just those rows, instead of reading every skipped row in full. Below
 * it the extra lookup costs more than it saves.
 */
const ROWID_FIRST_OFFSET = 3000;

/**
 * Name that reaches the table's rowid. A user field may take `rowid` (or
 * the other aliases); null when all three are taken.
 */
function rowidAlias(fields: FieldDef[]): string | null {
  const tie = db.dialect.tieBreak;
  if (tie !== "rowid") return tie; // a real column (the primary key)
  const taken = new Set(fields.map((f) => f.name.toLowerCase()));
  return ["rowid", "_rowid_", "oid"].find((a) => !taken.has(a)) ?? null;
}

/**
 * Columns a caller may reference in a filter: whatever the table physically
 * has, minus the private ones.
 *
 * Taken from the table rather than the declared schema on purpose. The two
 * disagree — an auth collection's implicit `verified` field has no column (the
 * column is `email_verified`), while `email_verified`, `totp_enabled` and
 * `is_anonymous` are real columns that never appear in `fields`. Asking the
 * table is the only answer that is right for every collection type.
 */
function filterableColumns(col: Collection): ReadonlySet<string> {
  const priv = privateFieldNames(col);
  const out = new Set<string>();
  try {
    for (const name of tableColumns(col.name)) {
      if (!priv.has(name)) out.add(name);
    }
  } catch {
    // Table missing (mid-migration, or a view whose query is broken). Fall
    // back to the declared schema so a transient error can't open the gate.
    try {
      for (const f of parseFields(col.fields)) if (!priv.has(f.name)) out.add(f.name);
    } catch { /* unparseable — leave empty, which denies */ }
    out.add("id"); out.add("created_at"); out.add("updated_at");
  }
  return out;
}

function makeCollectionLookup(): CollectionLookup {
  return (name: string) => {
    const col = getCollectionCached(name);
    if (!col) return null;
    let fieldNames: Set<string>;
    try {
      const parsed = cachedFields(col.fields);
      fieldNames = new Set(parsed.map((f) => f.name));
    } catch {
      fieldNames = new Set();
    }
    const priv = privateFieldNames(col);
    const cols = filterableColumns(col);
    return {
      viewRule: col.view_rule,
      listRule: col.list_rule,
      hasField: (n) => fieldNames.has(n) || n === "id" || n === "created_at" || n === "updated_at",
      isPrivateField: (n) => priv.has(n),
      isFilterable: (n) => cols.has(n),
    };
  };
}
export const DEFAULT_PER_PAGE = 30;
/** Largest page size a client-facing endpoint may request. */
export const MAX_PER_PAGE = 500;
/** The most records a list request may skip with `page` (its SQL OFFSET). */
export const MAX_LIST_OFFSET = 100_000;

function positiveInt(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;
}

/**
 * Parse client-supplied page / perPage query values: invalid → defaults,
 * perPage capped at MAX_PER_PAGE.
 */
export function clientPaging(page: string | null | undefined, perPage: string | null | undefined): { page: number; perPage: number } {
  return {
    page: positiveInt(page ? parseInt(page, 10) : undefined, 1),
    perPage: Math.min(positiveInt(perPage ? parseInt(perPage, 10) : undefined, DEFAULT_PER_PAGE), MAX_PER_PAGE),
  };
}

/**
 * Load every collection a filter / rule joins to (`@collection.X`,
 * `X_via_field`) into the cache that makeCollectionLookup reads.
 */
async function warmReferencedCollections(exprs: (string | undefined)[]): Promise<void> {
  const names = new Set<string>();
  for (const expr of exprs) {
    if (!expr) continue;
    for (const m of expr.matchAll(/@collection\.([A-Za-z0-9_]+)/g)) names.add(m[1]!);
    for (const m of expr.matchAll(/\b([A-Za-z0-9_]+?)_via_/g)) names.add(m[1]!);
  }
  for (const name of names) await getCollection(name);
}
import type { AuthContext } from "./rules.ts";
import { emit } from "./events.ts";
import { customFieldType } from "./field-types.ts";
import "./event-listeners.ts";
import { afterCommit, gateMode, withExclusiveWrite, withHeldEffects, withSharedWrite } from "./write-gate.ts";
import { dbScopedTtlCache } from "./ttl-cache.ts";
import { invalidateRecordVectors } from "./vector-cache.ts";
import { validateRecord, type CanSeeRecord } from "./validate.ts";
import { getActiveHookRequest, makeHookHelpers, runBeforeHook } from "./hooks.ts";
import { encryptValue, decryptValue, isEncrypted } from "./encryption.ts";

const ENCRYPTABLE_TYPES = new Set(["text", "email", "url", "json"]);

async function encodeForStorage(val: unknown, field: FieldDef): Promise<unknown> {
  // Password: bcrypt-hash via Bun. Empty/null leaves column null.
  if (field.type === "password") {
    if (val === null || val === undefined || val === "") return null;
    if (typeof val !== "string") return null;
    // Skip if already a hash (idempotent re-save). Bun emits $argon2 by default.
    if (val.startsWith("$argon2") || val.startsWith("$2a$") || val.startsWith("$2b$")) return val;
    return await Bun.password.hash(val);
  }
  const encoded = encodeValue(val, field);
  if (
    field.options?.encrypted
    && ENCRYPTABLE_TYPES.has(field.type)
    && typeof encoded === "string"
    && encoded.length > 0
  ) {
    return await encryptValue(encoded);
  }
  return encoded;
}


/**
 * Auth-system columns on `vb_<auth-col>` that must never appear in API
 * responses. Stripped on every row projection regardless of caller.
 * Mirrors the contract enforced by /admin/users/:col in v0.10.
 */

function viewPrivate(name: string): boolean {
  return AUTH_PRIVATE_COLUMNS.has(name) || sensitiveSchema().passwordFields.has(name.toLowerCase());
}

function buildRecord(
  row: Record<string, unknown>,
  col: Collection,
  fieldByName: Map<string, FieldDef>,
): RecordWithMeta {
  const out: RecordWithMeta = {
    id: String(row["id"]),
    collectionId: col.id,
    collectionName: col.name,
    created: Number(row["created_at"] ?? 0),
    updated: Number(row["updated_at"] ?? 0),
  };
  for (const k in row) {
    const v = row[k];
    if (k === "id" || k === "created_at" || k === "updated_at" || k === SEARCH_COLUMN) continue;
    // Auth-system columns are private — never emit on the wire. In a view,
    // also password fields, and duplicates SQLite renames to `name:1`.
    if (col.type === "auth" && AUTH_PRIVATE_COLUMNS.has(k)) continue;
    if (col.type === "view" && viewPrivate(baseColumnName(k))) continue;
    const def = fieldByName.get(k);
    // Never expose password hashes via the API
    if (def?.type === "password") continue;
    out[k] = def ? decodeValue(v, def) : v;
  }
  return out;
}

/** Per field-list lookups, built once for a cached field array. */
const fieldIndex = new WeakMap<FieldDef[], { byName: Map<string, FieldDef>; encrypted: string[] }>();

function indexFields(fields: FieldDef[]): { byName: Map<string, FieldDef>; encrypted: string[] } {
  let idx = fieldIndex.get(fields);
  if (!idx) {
    idx = {
      byName: new Map(fields.map((f) => [f.name, f])),
      encrypted: fields.filter((f) => f.options?.encrypted).map((f) => f.name),
    };
    fieldIndex.set(fields, idx);
  }
  return idx;
}

/**
 * Stored rows → API records. The field map is built once per field list, and
 * the conversion is synchronous unless the collection has encrypted fields,
 * in which case only those values are decrypted (async) before decoding.
 */
async function rowsToMeta(
  rows: Array<Record<string, unknown>>,
  col: Collection,
  fields: FieldDef[],
): Promise<RecordWithMeta[]> {
  const { byName: fieldByName, encrypted } = indexFields(fields);
  if (encrypted.length === 0) return rows.map((r) => buildRecord(r, col, fieldByName));
  return Promise.all(rows.map(async (r) => {
    const plain: Record<string, unknown> = { ...r };
    for (const name of encrypted) {
      const v = r[name];
      if (typeof v === "string" && isEncrypted(v)) plain[name] = await decryptValue(v);
    }
    return buildRecord(plain, col, fieldByName);
  }));
}

async function rowToMetaAsync(
  row: Record<string, unknown>,
  col: Collection,
  fields: FieldDef[]
): Promise<RecordWithMeta> {
  return (await rowsToMeta([row], col, fields))[0]!;
}

export interface ListOptions {
  page?: number;
  perPage?: number;
  filter?: string;
  sort?: string;
  expand?: string;
  fields?: string;
  skipTotal?: boolean;
  /** Full-text query over the collection's `searchable` fields. */
  search?: string;
  accessRule?: string;
  auth?: AuthContext | null;
  /**
   * The request, as rules see it (`@request.headers.*`, `@request.query.*`).
   * Without it those operands compiled to NULL in the SQL access filter.
   */
  request?: RequestContextLike | null;
  /**
   * Internal callers that walk a whole table page by page (the admin CSV
   * export) aren't held to MAX_LIST_OFFSET. Never set from client input.
   */
  allowDeepPaging?: boolean;
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

/**
 * SQLite identifier quoting — doubles up embedded `"` per spec. Mirrors
 * `core/collections.ts::quoteIdent`. All identifier inputs at this layer
 * already pass `assertSqlIdent` upstream (no quote chars possible), but the
 * defense-in-depth match prevents future bypasses if a path skips that
 * upstream check.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function isJsonField(field: FieldDef): boolean {
  return field.type === "json"
    || field.type === "geoPoint"
    || field.type === "vector"
    || (field.type === "select" && field.options?.multiple === true)
    || (field.type === "file"   && field.options?.multiple === true)
    || customFieldType(field.type)?.json === true;
}

/** Coerce a JS value to its DB-safe representation based on field type. */
function encodeValue(val: unknown, field: FieldDef): unknown {
  if (val === undefined || val === null) return null;
  const custom = customFieldType(field.type);
  if (custom?.encode) return custom.encode(val, field);
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

/**
 * The decoder for a field, chosen once per field object (null = the stored
 * value is the API value). Field objects from `cachedFields` are stable, so
 * this replaces a registry lookup and a type switch per value. Dropped when
 * a field type is registered or removed.
 */
let decoders = new WeakMap<FieldDef, ((v: unknown) => unknown) | null>();
let decodersVersion = fieldTypesVersion();

function decoderFor(field: FieldDef): ((v: unknown) => unknown) | null {
  const version = fieldTypesVersion();
  if (version !== decodersVersion) { decoders = new WeakMap(); decodersVersion = version; }
  const hit = decoders.get(field);
  if (hit !== undefined) return hit;
  const custom = customFieldType(field.type);
  let d: ((v: unknown) => unknown) | null;
  if (custom?.decode) { const decode = custom.decode; d = (v) => decode(v, field); }
  else if (field.type === "bool") d = (v) => v === 1 || v === true || v === "1" || v === "true";
  else if (isJsonField(field)) d = (v) => { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return v; } };
  else d = null;
  decoders.set(field, d);
  return d;
}

/** Decode a DB value back to the JS shape the API returns. */
function decodeValue(val: unknown, field: FieldDef): unknown {
  if (val === null || val === undefined) return null;
  const d = decoderFor(field);
  return d ? d(val) : val;
}

// ── List ─────────────────────────────────────────────────────────────────────

type Binding = string | number | bigint | boolean | null | Uint8Array;

/**
 * WHERE clause for a list query: the caller's filter AND the collection's
 * access rule, both compiled fail-closed. Shared with vector search so it
 * scopes candidates exactly like a list does.
 */
export async function compileListWhere(
  col: Collection,
  opts: Pick<ListOptions, "filter" | "accessRule" | "auth" | "search" | "request">,
): Promise<{ whereSql: string; whereParams: Binding[] }> {
  const tname = userTableName(col.name);
  const whereParts: string[] = [];
  const whereParams: Binding[] = [];

  // Lookup callback so the SQL compiler can inherit joined-collection rules
  // and validate back-relation ref fields.
  const lookup = makeCollectionLookup();
  const hostPrivate = privateFieldNames(col);
  const hostCols = filterableColumns(col);
  const filterOpts = {
    auth: opts.auth ?? null,
    request: opts.request ?? null,
    lookup,
    hostIdField: "id",
    hostPrivateField: (n: string) => hostPrivate.has(n),
    hostFilterable: (n: string) => hostCols.has(n),
  } as const;
  // The compiler resolves joined collections synchronously from the cache;
  // load them first so valid rules don't fail on a cold cache.
  await warmReferencedCollections([opts.filter, opts.accessRule]);

  if (opts.filter) {
    let compiled;
    try {
      // A caller's own filter gets one @collection join and one
      // cross-collection operand in all; rules (written by admins) get the
      // defaults. See ParseFilterOpts.maxJoins / maxCrossRefs.
      compiled = parseFilter(opts.filter, tname, opts.auth?.type === "admin" ? filterOpts : { ...filterOpts, maxJoins: 1, maxCrossRefs: 1, clientFilter: true });
    } catch (e) {
      throw new FilterError(e instanceof Error ? e.message : String(e));
    }
    // The parser returns null on a syntax error; only a blank filter is "no filter".
    if (!compiled) {
      if (opts.filter.trim() !== "") throw new FilterError("could not parse expression");
    } else {
      whereParts.push(compiled.sql);
      whereParams.push(...(compiled.params as Binding[]));
    }
  }
  if (opts.accessRule) {
    // Fail closed: an access rule that can't be compiled must never be
    // skipped, or the query runs without it and returns every row.
    let compiled;
    try {
      compiled = parseFilter(opts.accessRule, tname, filterOpts);
    } catch (e) {
      throw new AccessRuleError(col.name, e instanceof Error ? e.message : String(e));
    }
    if (!compiled) throw new AccessRuleError(col.name, "rule compiled to nothing");
    whereParts.push(compiled.sql);
    whereParams.push(...(compiled.params as Binding[]));
  }
  const match = await searchMatch(col, opts.search);
  if (match) {
    whereParts.push(searchPredicate(col.name, quoteIdent(tname)));
    whereParams.push(match.query);
  }
  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
  return { whereSql, whereParams };
}

/**
 * Resolve `?search=` to a query for the collection's index (fts.ts).
 * Null when the input is blank; FilterError when the collection has no
 * searchable fields or the database has no search.
 */
async function searchMatch(col: Collection, search: string | undefined): Promise<{ query: string } | null> {
  if (search === undefined) return null;
  if (db.capabilities.fts === "none") throw new FilterError("full-text search is not available on this database");
  const query = searchQuery(search);
  if (!query) return null;
  if (col.type === "view" || !(await hasFts(col.name))) {
    throw new FilterError(`collection '${col.name}' has no searchable fields`);
  }
  return { query };
}

export async function listRecords(
  collectionName: string,
  opts: ListOptions = {}
): Promise<ListResult> {
  const col = await getCollection(collectionName);
  if (!col) throw new Error(`Collection '${collectionName}' not found`);

  const fields = cachedFields(col.fields);
  const tname = userTableName(col.name);
  const tableRef = quoteIdent(tname);

  // Guard against values that would reach SQL as-is: LIMIT -1 means "no
  // limit" in SQLite, 0 gives Infinity pages, NaN fails the bind.
  const page = positiveInt(opts.page, 1);
  const perPage = positiveInt(opts.perPage, DEFAULT_PER_PAGE);
  const offset = (page - 1) * perPage;
  // SQLite walks every skipped row to reach an OFFSET, so a huge page number
  // makes one cheap request scan the whole table (and past 2^53 the value
  // isn't even an exact integer). Deeper reads narrow with a filter instead.
  if (offset > MAX_LIST_OFFSET && !opts.allowDeepPaging) {
    throw new FilterError(`page is too deep: at most ${MAX_LIST_OFFSET} records can be skipped; narrow the query with a filter`);
  }

  const { whereSql, whereParams } = await compileListWhere(col, opts);
  // A search with no explicit sort orders by relevance (bm25): the SELECT
  // joins the match set itself, so it skips the search clause in WHERE.
  const match = opts.sort === undefined ? await searchMatch(col, opts.search) : null;
  const rankedWhere = match ? await compileListWhere(col, { ...(opts.filter !== undefined ? { filter: opts.filter } : {}), ...(opts.accessRule !== undefined ? { accessRule: opts.accessRule } : {}), auth: opts.auth ?? null, request: opts.request ?? null }) : null;

  // Build ORDER BY. View collections don't necessarily expose created_at /
  // updated_at, so skip the default sort there — caller can opt in by passing
  // a `sort` they know is valid for their query.
  //
  // Whitelist sort columns against the actual collection schema to refuse any
  // attacker-supplied identifier from reaching the SQL string. Without this
  // gate, a value like `sort=name";<sql>;--` would land inside the prepared
  // statement string. SQLite's prepare_v2 only compiles the first statement
  // (so multi-statement injection is blocked today), but error-based oracles
  // and any future API change to multi-statement exec would turn this into
  // RCE — fail fast instead of relying on the prepare contract.
  const sortableCols = new Set<string>([
    "id", "created_at", "updated_at",
    ...fields.filter((f) => !f.system).map((f) => f.name),
  ]);
  const sortPrivate = privateFieldNames(col);
  const sortSpec = opts.sort ?? (col.type === "view" ? "" : "-created_at");
  const orderClauses: string[] = [];
  const sortCols: string[] = [];
  for (const s of sortSpec.split(",").map((x) => x.trim()).filter(Boolean)) {
    const desc = s.startsWith("-");
    const field = desc ? s.slice(1) : s;
    const colName = field === "created" ? "created_at"
      : field === "updated" ? "updated_at" : field;
    // View collections accept any column name (the schema is inferred from
    // the SELECT and may not be fully reflected in `fields`); base + auth
    // collections strictly whitelist.
    if (col.type !== "view" && !sortableCols.has(colName)) continue;
    // Never order by a private column: the row order alone leaks it one
    // comparison at a time (a password field, or auth secrets in a view).
    if (sortPrivate.has(colName)) continue;
    // Defense-in-depth even after whitelist: reject any value that doesn't
    // match a SQL identifier regex. Whitelist covers it for non-view, this
    // is the view-collection-fallback safety net.
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(colName)) continue;
    orderClauses.push(`${tableRef}.${quoteIdent(colName)} ${desc ? "DESC" : "ASC"}`);
    sortCols.push(colName);
  }
  // Break ties on the rowid so rows sharing a sort value (created_at has
  // one-second resolution) keep one order across pages. Indexes carry the
  // rowid, so an index that serves the sort still serves it.
  const rowid = col.type === "view" ? null : rowidAlias(fields);
  if (rowid && orderClauses.length > 0) {
    orderClauses.push(`${tableRef}.${rowid} ${orderClauses[orderClauses.length - 1]!.endsWith("DESC") ? "DESC" : "ASC"}`);
  }
  const orderSql = orderClauses.length > 0 ? `ORDER BY ${orderClauses.join(", ")}` : "";

  const selectSql = match && rankedWhere
    ? rankedSelect(col.name, tableRef, rankedWhere.whereSql)
    : rowid && orderSql && offset >= ROWID_FIRST_OFFSET
      ? `SELECT * FROM ${tableRef} WHERE ${rowid} IN (SELECT ${rowid} FROM ${tableRef} ${whereSql} ${orderSql} LIMIT ? OFFSET ?) ${orderSql}`
      : `SELECT * FROM ${tableRef} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`;
  const selectParams = match && rankedWhere
    ? [match.query, ...rankedWhere.whereParams, perPage, offset]
    : [...whereParams, perPage, offset];

  let rows: Record<string, unknown>[];
  let totalItems = -1;
  let totalPages = -1;
  const queryStart = performance.now();
  try {
    // Execute SELECT — prepared statement cached by SQL string shape.
    rows = await db.all<Record<string, unknown>>(selectSql, selectParams);
    if (!opts.skipTotal) {
      const countSql = `SELECT COUNT(*) AS c FROM ${tableRef} ${whereSql}`;
      // A view's SELECT, or strftime('now', …) in a filter, can change its
      // answer without any write, so those are always counted fresh.
      totalItems = col.type === "view" || /strftime\(/i.test(whereSql)
        ? (await db.get<{ c: number }>(countSql, whereParams))?.c ?? 0
        : await cachedCount(countSql, whereParams, tname);
      totalPages = Math.ceil(totalItems / perPage);
    }
  } catch (e) {
    // The query builders quote every term, but report anything the search
    // engine still rejects as a bad request rather than a 500.
    if (opts.search && isSearchSyntaxError(e)) throw new FilterError(`invalid search: ${(e as Error).message}`);
    // `field.key` reads inside a JSON value. On any other field (a relation,
    // a text) the database can't parse the column as JSON.
    if (opts.filter && isJsonPathError(e)) {
      throw new FilterError("a field used as JSON isn't JSON. A dotted path (field.key) reads inside a json field, and the ?= family of operators needs a json or multi-value field. Filters don't follow relations: compare the relation's id (author = \"…\"), or use @collection.<name>.<field>");
    }
    throw e;
  }
  recordListQuery({
    collection: col.name,
    table: tname,
    view: col.type === "view",
    selectSql,
    whereSql: match && rankedWhere ? rankedWhere.whereSql : whereSql,
    sortCols,
    filter: opts.filter,
    sort: opts.sort,
    search: !!match,
    us: (performance.now() - queryStart) * 1000,
  });

  const items = await shapeRecords(col, await rowsToMeta(rows, col, fields), opts);

  return { data: items, page, perPage, totalItems, totalPages };
}

export interface ShapeOptions {
  /** Comma-separated relation paths to expand, nested with `.`. */
  expand?: string | undefined;
  /** Comma-separated fields to return; `id` always is. */
  fields?: string | undefined;
  /** Who's asking: related records are expanded under their view rule. */
  auth?: AuthContext | null | undefined;
  request?: RequestContextLike | null | undefined;
}

/**
 * `expand` then `fields`, as list and get-one both apply them. Expanded
 * relations respect the related collection's view rule. A projection keeps
 * `expand` when expanding was asked for.
 */
export async function shapeRecords(col: Collection, items: RecordWithMeta[], opts: ShapeOptions): Promise<RecordWithMeta[]> {
  const expandPaths = (opts.expand ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (expandPaths.length) {
    await expandRelations(items, expandPaths, cachedFields(col.fields), opts.auth ?? null, opts.request ?? null);
  }
  const keep = (opts.fields ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (keep.length) {
    if (expandPaths.length && !keep.includes("expand")) keep.push("expand");
    return items.map((it) => projectFields(it, keep));
  }
  return items;
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
  const fields = cachedFields(col.fields);
  const tableRef = quoteIdent(userTableName(col.name));
  const row = await db.get<Record<string, unknown>>(`SELECT * FROM ${tableRef} WHERE "id" = ?`, [id]);
  return row ? await rowToMetaAsync(row, col, fields) : null;
}

// ── Create ──────────────────────────────────────────────────────────────────

async function createRecordImpl(
  collectionName: string,
  data: Record<string, unknown> | null | undefined,
  auth: AuthContext | null = null,
  guard: WriteGuard = {},
): Promise<RecordWithMeta> {
  const col = await getCollection(collectionName);
  if (!col) throw new Error(`Collection '${collectionName}' not found`);
  if (col.type === "view") throw new ReadOnlyCollectionError(col.name);
  if (col.type === "singleton") throw new SingletonRecordError(col.name, "create");
  if (col.type === "auth") {
    // Auth collections require credential hashing + verification-email
    // semantics + uniqueness checks that records.ts createRecord doesn't
    // run. Route callers to the auth signup flow instead.
    throw new ReadOnlyCollectionError(
      col.name,
      `'${col.name}' is an auth collection. Create users via POST /api/v1/auth/${col.name}/register ` +
      `(or /anonymous) — direct record-create bypasses password hashing + email verification.`,
    );
  }
  data = data ?? {};

  // beforeCreate hook (can mutate data, throw to abort)
  const helpers = makeHookHelpers();
  await runBeforeHook(col, "beforeCreate", { record: data, existing: null, auth, helpers });

  await validateRecord(col, data, "create", undefined, guard.relationsAs ? canSeeAs(guard.relationsAs.auth, guard.relationsAs.request ?? null) : undefined);

  const fields = parseFields(col.fields);
  const userFields = fields.filter((f) => !f.system && !f.implicit);
  const fieldByName = new Map(userFields.map((f) => [f.name, f]));
  const now = Math.floor(Date.now() / 1000);

  // autodate is server-managed: whatever the client sent is dropped, and
  // the field is set now only when it opts in to onCreate.
  for (const f of userFields) {
    if (f.type !== "autodate") continue;
    delete (data as Record<string, unknown>)[f.name];
    if (f.onCreate) (data as Record<string, unknown>)[f.name] = now;
  }

  type Binding = string | number | bigint | boolean | null | Uint8Array;
  const id = crypto.randomUUID();
  const insertCols: string[] = ["id"];
  const insertVals: Binding[] = [id];

  for (const f of userFields) {
    if (Object.prototype.hasOwnProperty.call(data, f.name)) {
      insertCols.push(f.name);
      insertVals.push(await encodeForStorage((data as Record<string, unknown>)[f.name], f) as Binding);
    }
  }

  insertCols.push("created_at", "updated_at");
  insertVals.push(now, now);

  const tableRef = quoteIdent(userTableName(col.name));
  const colsSql = insertCols.map(quoteIdent).join(", ");
  const placeholders = insertCols.map(() => "?").join(", ");

  // Cached statements: compiling these two on every write was ~a fifth of
  // a create's CPU. (Not INSERT … RETURNING: it misses changes made by
  // AFTER triggers an admin may have added through the SQL page.)
  await db.run(`INSERT INTO ${tableRef} (${colsSql}) VALUES (${placeholders})`, insertVals, { table: userTableName(col.name) });

  const row = (await db.get<Record<string, unknown>>(`SELECT * FROM ${tableRef} WHERE "id" = ?`, [id]))!;
  const result = await rowToMetaAsync(row, col, fields);
  await maybeRecordHistory(col, id, {
    op: "create",
    snapshot: result as unknown as Record<string, unknown>,
    auth,
  });
  // Inside a batch these run only after COMMIT (see write-gate.ts).
  afterCommit(() => {
    emit("record.created", { collection: col, record: result as unknown as Record<string, unknown>, auth, source: "api" });
  });
  return result;
}

// ── Update ──────────────────────────────────────────────────────────────────

async function updateRecordImpl(
  collectionName: string,
  id: string,
  data: Record<string, unknown> | null | undefined,
  auth: AuthContext | null = null,
  guard: WriteGuard = {},
): Promise<RecordWithMeta> {
  const col = await getCollection(collectionName);
  if (!col) throw new Error(`Collection '${collectionName}' not found`);
  if (col.type === "view") throw new ReadOnlyCollectionError(col.name);
  data = data ?? {};
  if (col.type === "auth") {
    // Strip auth-system columns from the incoming patch — those go through
    // the dedicated auth flows (`/totp/...`, `/verify-email`, …) that
    // handle hashing + email-verification + recovery-code lifecycle.
    // Allowing them here would let callers set raw `password_hash` (or
    // `email_verified`) bypassing the contract.
    const stripped: Record<string, unknown> = { ...(data as Record<string, unknown>) };
    for (const k of ["password", "password_hash", "totp_secret", "totp_enabled",
                     "email_verified", "is_anonymous", "password_reset_at"]) {
      delete stripped[k];
    }
    data = stripped;
  }

  const tableRef = quoteIdent(userTableName(col.name));
  const writeKey = `${col.name}:${id}`;
  // Held from the version read to the write (see recordLocks).
  const unlock = await lockRecord(writeKey);
  try {
  const existing = await getRecord(collectionName, id);
  if (!existing) throw new Error("Record not found");
  if (guard.ifUnchanged && JSON.stringify(existing) !== JSON.stringify(guard.ifUnchanged)) {
    throw new PreconditionFailedError();
  }

  // beforeUpdate hook
  const helpers = makeHookHelpers();
  await runBeforeHook(col, "beforeUpdate", {
    record: data,
    existing: existing as unknown as Record<string, unknown>,
    auth,
    helpers,
  });

  await validateRecord(col, data, "update", id, guard.relationsAs ? canSeeAs(guard.relationsAs.auth, guard.relationsAs.request ?? null) : undefined, existing as unknown as Record<string, unknown>);

  const fields = parseFields(col.fields);
  const userFields = fields.filter((f) => !f.system && !f.implicit);
  const now = Math.floor(Date.now() / 1000);

  // autodate is server-managed: the client's value is dropped, and the
  // field moves only when it opts in to onUpdate.
  for (const f of userFields) {
    if (f.type !== "autodate") continue;
    delete (data as Record<string, unknown>)[f.name];
    if (f.onUpdate) (data as Record<string, unknown>)[f.name] = now;
  }

  type Binding = string | number | bigint | boolean | null | Uint8Array;
  const setCols: string[] = [];
  const setVals: Binding[] = [];
  for (const f of userFields) {
    if (Object.prototype.hasOwnProperty.call(data, f.name)) {
      setCols.push(`${quoteIdent(f.name)} = ?`);
      setVals.push(await encodeForStorage((data as Record<string, unknown>)[f.name], f) as Binding);
    }
  }
  setCols.push(`"updated_at" = ?`);
  setVals.push(now);


  if (setCols.length > 1) {
    await db.run(`UPDATE ${tableRef} SET ${setCols.join(", ")} WHERE "id" = ?`, [...setVals, id], { table: userTableName(col.name) });
  }
  // updated_at has 1 s resolution; drop the cached vector so a same-second
  // re-search sees the new value.
  invalidateRecordVectors(col.id, id);

  const row = (await db.get<Record<string, unknown>>(`SELECT * FROM ${tableRef} WHERE "id" = ?`, [id]))!;
  const result = await rowToMetaAsync(row, col, fields);
  await maybeRecordHistory(col, id, {
    op: "update",
    snapshot: result as unknown as Record<string, unknown>,
    auth,
  });
  afterCommit(() => {
    emit("record.updated", {
      collection: col,
      record: result as unknown as Record<string, unknown>,
      existing: existing as unknown as Record<string, unknown>,
      auth, source: "api",
    });
  });
  return result;
  } finally {
    unlock();
  }
}

// ── Delete ──────────────────────────────────────────────────────────────────

/**
 * The record changed between the caller's precondition check (an HTTP
 * `If-Match`) and the write. The caller answers 412.
 */
export class PreconditionFailedError extends Error {
  constructor() { super("Precondition Failed: record was modified"); }
}

/**
 * A guarded write (`ifUnchanged`, an HTTP If-Match) on Postgres runs in a
 * transaction that first takes the record's row lock. The per-record lock
 * (recordLocks) only covers this process: several servers on one database
 * could each pass their check and both write, losing one update. Holding
 * the row lock from the check to the write makes another server's write
 * wait, then fail its own check. The request's own hooks run on the same
 * pinned connection, so they can still write the record. Side effects wait
 * for COMMIT. On SQLite one process owns the file and recordLocks suffices.
 */
async function withRowLockForGuard<T>(collectionName: string, id: string, guard: WriteGuard, fn: () => Promise<T>): Promise<T> {
  if (db.name === "sqlite" || !guard.ifUnchanged) return fn();
  const col = await getCollection(collectionName);
  if (!col || col.type === "view") return fn();
  const tableRef = quoteIdent(userTableName(col.name));
  // This process's lock first, then the row's: in the other order a write of
  // this process already holding the record lock would wait on our row lock
  // while we wait on its record lock. `fn` takes the record lock again,
  // which passes (re-entrant for the same request).
  const unlock = await lockRecord(`${col.name}:${id}`);
  try {
    return await withHeldEffects(() => db.transaction(async () => {
      await db.get(`SELECT 1 FROM ${tableRef} WHERE "id" = ? FOR UPDATE`, [id]);
      return fn();
    }, { immediate: false }));
  } finally {
    unlock();
  }
}

/**
 * Write preconditions. `ifUnchanged` is the record (as `getRecord` returned
 * it) the caller checked its precondition against; the write goes ahead only
 * if the record is still exactly that.
 */
export interface WriteGuard {
  ifUnchanged?: Record<string, unknown>;
  /**
   * Validate relation fields as this caller: a relation may only point at a
   * record the caller can view. Set by the API for non-admin callers.
   */
  relationsAs?: { auth: AuthContext | null; request?: RequestContextLike | null };
  /**
   * The caller's rules for rows a delete reaches through cascades: `change`
   * is null for a cascaded delete, or the fields a `setNull` cascade writes.
   * Returning false aborts the whole delete (it runs in a transaction).
   * Unset for admins and internal callers.
   */
  cascadeAllowed?: (col: Collection, record: Record<string, unknown>, change: Record<string, unknown> | null) => boolean;
}

/** Relation check for `auth`: the target record must pass its collection's view rule. */
export function canSeeAs(auth: AuthContext | null, request: RequestContextLike | null = null): CanSeeRecord {
  return async (target, id) => {
    if (auth?.type === "admin" || target.view_rule === null) return true;
    if (target.view_rule === "") return false;
    const { whereSql, whereParams } = await compileListWhere(target, { accessRule: target.view_rule, auth, request });
    const tableRef = quoteIdent(userTableName(target.name));
    const row = await db.get(
      `SELECT 1 FROM ${tableRef} WHERE ${tableRef}."id" = ?${whereSql ? ` AND (${whereSql.replace(/^\s*WHERE\s+/i, "")})` : ""} LIMIT 1`,
      [id, ...whereParams],
    );
    return !!row;
  };
}

/** A cascade would delete or change a row the caller's rules don't allow. */
export class CascadeForbiddenError extends Error {
  constructor(readonly collection: string) {
    super(`Forbidden: deleting this record would change records in '${collection}' you can't modify`);
  }
}

/**
 * Per-record write locks. Every update and delete of a record holds its
 * lock from reading the record to writing it, so an If-Match check can't be
 * overtaken by a write already in flight, and two writes to one record never
 * interleave. The holder's own request — its hooks touching the same record —
 * passes straight through (re-entrant by request). Waiting is bounded: hooks
 * in two requests that write each other's records would otherwise wait on
 * each other forever, so after LOCK_WAIT_MS one of them fails with
 * RecordBusyError instead.
 */
const recordLocks = new Map<string, { owner: unknown; released: Promise<void> }>();

/**
 * Who a write belongs to, for lock re-entrancy: the HTTP request, or — for
 * internal writers with no request (jobs, queues, MCP) — one owner per
 * top-level call, inherited by the hooks and nested writes it causes.
 * Sharing one owner among all internal writers let them overtake each
 * other's locks.
 */
const writeOwner = new AsyncLocalStorage<unknown>();

function withWriteOwner<T>(fn: () => Promise<T>): Promise<T> {
  if (writeOwner.getStore() !== undefined) return fn();
  return writeOwner.run(getActiveHookRequest() ?? Symbol("internal write"), fn);
}

function currentWriteOwner(): unknown {
  return writeOwner.getStore() ?? getActiveHookRequest() ?? Symbol("unowned write");
}
let LOCK_WAIT_MS = 10_000;

/** Test hook: shorten the lock wait. */
export function _setRecordLockWaitForTests(ms: number): void {
  LOCK_WAIT_MS = ms;
}

/** A record stayed locked by another request for longer than LOCK_WAIT_MS. */
export class RecordBusyError extends Error {
  constructor() { super("Record is busy (another write holds it); try again"); }
}

async function waitForRecordLock(key: string): Promise<void> {
  const self = currentWriteOwner();
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (let held = recordLocks.get(key); held && held.owner !== self; held = recordLocks.get(key)) {
    const left = deadline - Date.now();
    if (left <= 0) throw new RecordBusyError();
    await Promise.race([held.released, Bun.sleep(left)]);
  }
}

async function lockRecord(key: string): Promise<() => void> {
  const self = currentWriteOwner();
  // Wait inline: the loop's final check and the set below must run with no
  // await between them (awaiting a helper costs a tick even when the lock is
  // free), or two requests can both find it free and both take it.
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (let held = recordLocks.get(key); held && held.owner !== self; held = recordLocks.get(key)) {
    const left = deadline - Date.now();
    if (left <= 0) throw new RecordBusyError();
    await Promise.race([held.released, Bun.sleep(left)]);
  }
  // Re-entrant: the outer write of this request releases it.
  if (recordLocks.get(key)?.owner === self) return () => {};
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  const lock = { owner: self, released };
  recordLocks.set(key, lock);
  return () => { if (recordLocks.get(key) === lock) recordLocks.delete(key); release(); };
}

export class RestrictError extends Error {
  details: Record<string, string>;
  constructor(details: Record<string, string>) {
    super("Cannot delete: record is referenced by other records");
    this.details = details;
  }
}

/**
 * A write the collection's type doesn't allow: any write to a view, or a
 * direct create on an auth collection (users sign up instead). HTTP 405.
 */
export class ReadOnlyCollectionError extends Error {
  constructor(collectionName: string, message?: string) {
    super(message ?? `Collection '${collectionName}' is read-only (view collection)`);
  }
}

/**
 * A singleton collection holds exactly one record, made with the collection:
 * it can be read and updated, never created or deleted. Maps to HTTP 405.
 */
export class SingletonRecordError extends Error {
  constructor(collectionName: string, op: "create" | "delete") {
    super(`Collection '${collectionName}' is a singleton: its one record can't be ${op === "create" ? "created" : "deleted"}. Read it with GET and change it with PATCH on /api/v1/${collectionName}`);
  }
}

/** A user-supplied `filter` that does not compile. Maps to HTTP 400. */
/** The database refusing to read a non-JSON column as JSON (SQLite, then Postgres). */
function isJsonPathError(e: unknown): boolean {
  return e instanceof Error && /malformed JSON|invalid input syntax for type json/i.test(e.message);
}

export class FilterError extends Error {
  constructor(reason: string) {
    super(`Invalid filter: ${reason}`);
  }
}

/**
 * A collection access rule that cannot be compiled. Fails closed (HTTP 403):
 * dropping the rule would hand non-admins every row.
 */
export class AccessRuleError extends Error {
  constructor(collectionName: string, reason: string) {
    super(`Access rule for '${collectionName}' could not be evaluated: ${reason}`);
  }
}

interface IncomingRef {
  collection: { id: string; name: string; view_rule: string | null };
  fieldName: string;
  cascade: CascadeMode;
}

/** Find every (collection, field) pair that has a relation pointing at `targetCollectionName`. */
// target collection name → relations pointing at it. Rebuilding this meant
// loading and JSON-parsing every collection several times per delete.
const relationMap = dbScopedTtlCache(1000, async () => {
  const byTarget = new Map<string, IncomingRef[]>();
  for (const c of await listCollections()) {
    for (const f of parseFields(c.fields)) {
      if (f.type !== "relation" || !f.collection) continue;
      const list = byTarget.get(f.collection) ?? [];
      list.push({
        collection: { id: c.id, name: c.name, view_rule: c.view_rule },
        fieldName: f.name,
        cascade: f.options?.cascade ?? "setNull",
      });
      byTarget.set(f.collection, list);
    }
  }
  return byTarget;
});
let relationMapVersion = -1;

async function findIncomingRefs(targetCollectionName: string): Promise<IncomingRef[]> {
  const version = getSchemaVersion();
  if (version !== relationMapVersion) {
    relationMap.invalidate();
    relationMapVersion = version;
  }
  return (await relationMap.get()).get(targetCollectionName) ?? [];
}

/** Throw RestrictError if any `restrict` relation still references `id`. */
async function checkRestrict(targetColName: string, id: string): Promise<void> {
  const refs = await findIncomingRefs(targetColName);
  for (const ref of refs) {
    if (ref.cascade !== "restrict") continue;
    const refTable = quoteIdent(userTableName(ref.collection.name));
    const row = await db.get(`SELECT "id" FROM ${refTable} WHERE ${quoteIdent(ref.fieldName)} = ? LIMIT 1`, [id]);
    if (row) {
      throw new RestrictError({
        [ref.collection.name]: `${ref.collection.name}.${ref.fieldName} still references this record`,
      });
    }
  }
}

/**
 * Apply setNull / cascade behavior to all incoming references before deleting `id`.
 * `visited` prevents infinite loops on circular cascades.
 */
async function applyCascades(
  targetColName: string,
  id: string,
  auth: AuthContext | null,
  visited: Set<string>,
  guard: WriteGuard = {},
): Promise<void> {
  const key = `${targetColName}:${id}`;
  if (visited.has(key)) return;
  visited.add(key);

  const refs = await findIncomingRefs(targetColName);
  if (refs.length === 0) return;

  for (const ref of refs) {
    const refTable = quoteIdent(userTableName(ref.collection.name));
    const fieldQ = quoteIdent(ref.fieldName);
    // The full definition (rules included) is only needed to check rules.
    const refCol = guard.cascadeAllowed ? await getCollection(ref.collection.name) : null;

    if (ref.cascade === "setNull") {
      const affected = await db.all<{ id: string }>(`SELECT "id" FROM ${refTable} WHERE ${fieldQ} = ?`, [id]);
      if (affected.length === 0) continue;
      if (guard.cascadeAllowed) {
        for (const r of affected) {
          const rec = await getRecord(ref.collection.name, r.id);
          if (rec && refCol && !guard.cascadeAllowed(refCol, rec as unknown as Record<string, unknown>, { [ref.fieldName]: null })) {
            throw new CascadeForbiddenError(ref.collection.name);
          }
        }
      }
      const now = Math.floor(Date.now() / 1000);
      for (const r of affected) await waitForRecordLock(`${ref.collection.name}:${r.id}`);
      const fullRef = refCol ?? await getCollection(ref.collection.name);
      await db.run(`UPDATE ${refTable} SET ${fieldQ} = NULL, "updated_at" = ? WHERE ${fieldQ} = ?`, [now, id], { table: userTableName(ref.collection.name) });
      // Realtime gets the full records; hooks and webhooks skip cascades (see
      // event-listeners.ts).
      for (const r of affected) {
        const rec = await getRecord(ref.collection.name, r.id);
        if (rec && fullRef) afterCommit(() => emit("record.updated", {
          collection: fullRef, record: rec as unknown as Record<string, unknown>, existing: null, auth, source: "cascade",
        }));
      }
      continue;
    }

    if (ref.cascade === "cascade") {
      const affected = await db.all<{ id: string }>(`SELECT "id" FROM ${refTable} WHERE ${fieldQ} = ?`, [id]);
      for (const r of affected) {
        if (guard.cascadeAllowed) {
          const rec = await getRecord(ref.collection.name, r.id);
          if (rec && refCol && !guard.cascadeAllowed(refCol, rec as unknown as Record<string, unknown>, null)) {
            throw new CascadeForbiddenError(ref.collection.name);
          }
        }
        await deleteRecordInternal(ref.collection.name, r.id, auth, visited, { ...(guard.cascadeAllowed ? { cascadeAllowed: guard.cascadeAllowed } : {}) });
      }
    }
  }
}

async function deleteRecordImpl(
  collectionName: string,
  id: string,
  auth: AuthContext | null = null,
  guard: WriteGuard = {},
): Promise<void> {
  return deleteRecordInternal(collectionName, id, auth, new Set<string>(), guard);
}

async function deleteRecordInternal(
  collectionName: string,
  id: string,
  auth: AuthContext | null,
  visited: Set<string>,
  guard: WriteGuard = {},
): Promise<void> {
  const col = await getCollection(collectionName);
  if (!col) throw new Error(`Collection '${collectionName}' not found`);
  if (col.type === "view") throw new ReadOnlyCollectionError(col.name);
  if (col.type === "singleton") throw new SingletonRecordError(col.name, "delete");

  const tableRef = quoteIdent(userTableName(col.name));
  const writeKey = `${col.name}:${id}`;
  // Held from the version read to the write (see recordLocks).
  const unlock = await lockRecord(writeKey);
  try {
  const existing = await getRecord(collectionName, id);
  if (!existing) {
    if (guard.ifUnchanged) throw new PreconditionFailedError();
    return;
  }
  if (guard.ifUnchanged && JSON.stringify(existing) !== JSON.stringify(guard.ifUnchanged)) {
    throw new PreconditionFailedError();
  }

  // Order matters: restrict refs (no side effects) → beforeDelete hook (may
  // abort) → cascades → delete. Cascading before the hook left children
  // deleted when the hook refused.
  await checkRestrict(col.name, id);

  const helpers = makeHookHelpers();
  await runBeforeHook(col, "beforeDelete", {
    record: {},
    existing: existing as unknown as Record<string, unknown>,
    auth, helpers,
  });

  await applyCascades(col.name, id, auth, visited, guard);

  await db.run(`DELETE FROM ${tableRef} WHERE "id" = ?`, [id], { table: userTableName(col.name) });
  invalidateRecordVectors(col.id, id);
  await maybeRecordHistory(col, id, {
    op: "delete",
    snapshot: existing as unknown as Record<string, unknown>,
    auth,
  });
  // Pass the just-deleted record snapshot so per-subscriber view_rule eval still has fields.
  afterCommit(() => {
    emit("record.deleted", { collection: col, id, existing: existing as unknown as Record<string, unknown>, auth, source: "api" });
  });
  } finally {
    unlock();
  }
}

// ── Relation expand ─────────────────────────────────────────────────────────

/**
 * Parse expand paths into a head→remaining-paths map.
 * Example: ["author", "author.profile", "comments.user.team"]
 *   → { "author": ["profile"], "comments": ["user.team"] }
 */
function parseExpandTree(paths: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const p of paths) {
    const idx = p.indexOf(".");
    const head = idx === -1 ? p : p.slice(0, idx);
    const rest = idx === -1 ? null : p.slice(idx + 1);
    if (!map.has(head)) map.set(head, []);
    if (rest) map.get(head)!.push(rest);
  }
  return map;
}

async function expandRelations(
  items: RecordWithMeta[],
  expandPaths: string[],
  schema: FieldDef[],
  auth: AuthContext | null,
  request: RequestContextLike | null = null,
): Promise<void> {
  if (items.length === 0 || expandPaths.length === 0) return;
  const tree = parseExpandTree(expandPaths);

  for (const [fieldName, restPaths] of tree) {
    const fieldDef = schema.find((f) => f.name === fieldName && f.type === "relation");
    if (!fieldDef?.collection) continue;

    const targetCol = await getCollection(fieldDef.collection);
    if (!targetCol) continue;
    const targetFields = parseFields(targetCol.fields);
    const targetTable = quoteIdent(userTableName(targetCol.name));

    // Enforce the target's view_rule. Without it, expand was a read-rule
    // bypass: anyone who could read a record with a relation got every
    // related row, including records the view rule would have hidden.
    // `null` = public, `""` = admin-only, anything else = an expression
    // compiled against the target table — the same three-way semantics the
    // SQL compiler already applies to `@collection.*` joins.
    const view = targetCol.view_rule;
    let ruleSql = "";
    const ruleParams: Binding[] = [];
    if (view === "") {
      if (auth?.type !== "admin") continue; // admin-only; nothing to expand
    } else if (view !== null && auth?.type !== "admin") {
      const compiled = parseFilter(view, userTableName(targetCol.name), {
        auth,
        request,
        lookup: makeCollectionLookup(),
        hostPrivateField: (n) => privateFieldNames(targetCol).has(n),
      });
      if (!compiled) continue;            // rule compiled to nothing → deny
      ruleSql = ` AND (${compiled.sql})`;
      ruleParams.push(...(compiled.params as Binding[]));
    }

    const ids = [
      ...new Set(
        items
          .map((it) => it[fieldName])
          .filter((v): v is string => typeof v === "string" && v.length > 0)
      ),
    ];
    if (ids.length === 0) continue;

    const placeholders = ids.map(() => "?").join(", ");
    const rows = await db.all<Record<string, unknown>>(`SELECT * FROM ${targetTable} WHERE "id" IN (${placeholders})${ruleSql}`, [...ids, ...ruleParams]);

    const expanded = await rowsToMeta(rows, targetCol, targetFields);
    const byId = new Map(expanded.map((rec) => [rec.id, rec]));

    for (const item of items) {
      const refId = item[fieldName];
      if (typeof refId === "string" && byId.has(refId)) {
        if (!item.expand) item.expand = {};
        item.expand[fieldName] = byId.get(refId);
      }
    }

    // Recurse: expand the remaining paths on the just-loaded target records
    if (restPaths.length > 0) {
      await expandRelations(expanded, restPaths, targetFields, auth, request);
    }
  }
}

// ── Gated entry points ──────────────────────────────────────────────────────
// Every record write goes through the write gate so it can never land inside
// another request's open batch transaction (see write-gate.ts).

export function createRecord(
  collectionName: string,
  data: Record<string, unknown> | null | undefined,
  auth: AuthContext | null = null,
  guard: WriteGuard = {},
): Promise<RecordWithMeta> {
  return withWriteOwner(() => withSharedWrite(() => createRecordImpl(collectionName, data, auth, guard)));
}

export function updateRecord(
  collectionName: string,
  id: string,
  data: Record<string, unknown> | null | undefined,
  auth: AuthContext | null = null,
  guard: WriteGuard = {},
): Promise<RecordWithMeta> {
  return withWriteOwner(() => withSharedWrite(() =>
    withRowLockForGuard(collectionName, id, guard, () => updateRecordImpl(collectionName, id, data, auth, guard))));
}

/**
 * A delete that cascades touches several rows and awaits hooks in between, so
 * it runs in a transaction: its own (taking the gate exclusively, like a
 * batch), or a savepoint inside an enclosing batch. A plain delete with
 * nothing to cascade is a single statement and stays on the shared path.
 */
export function deleteRecord(
  collectionName: string,
  id: string,
  auth: AuthContext | null = null,
  guard: WriteGuard = {},
): Promise<void> {
  return withWriteOwner(() => deleteRecordOwned(collectionName, id, auth, guard));
}

async function deleteRecordOwned(
  collectionName: string,
  id: string,
  auth: AuthContext | null,
  guard: WriteGuard,
): Promise<void> {
  const col = await getCollection(collectionName);
  const cascades = col
    ? (await findIncomingRefs(col.name)).some((r) => r.cascade !== "restrict")
    : false;
  const run = () => withRowLockForGuard(collectionName, id, guard, () => deleteRecordImpl(collectionName, id, auth, guard));
  if (!cascades) return withSharedWrite(run);

  const mode = gateMode();
  if (mode === "exclusive") return db.savepoint(run);
  // Nested inside another ordinary write (e.g. a hook deleting a record):
  // taking the gate exclusively here would wait on ourselves. Runs without
  // a transaction; hook-before-cascade ordering still applies.
  if (mode === "shared") return run();

  return withExclusiveWrite(async (tx) => {
    try {
      // The lock is taken at the first write, as it always was here.
      await db.transaction(run, { immediate: false });
      flushTableReports();
      tx.commit();
    } catch (e) {
      discardTableReports();
      tx.rollback();
      throw e;
    }
  });
}
