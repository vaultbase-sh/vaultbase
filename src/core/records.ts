import type { Database } from "bun:sqlite";
import { getDb } from "../db/client.ts";
import type { Collection } from "../db/schema.ts";
import {
  getCollection,
  getCollectionCached,
  getSchemaVersion,
  listCollections,
  parseFields,
  userTableName,
  type CascadeMode,
  type FieldDef,
} from "./collections.ts";
import { parseFilter, type CollectionLookup } from "./filter.ts";
import { maybeRecordHistory } from "./record-history.ts";
import { ftsTableName, hasFts, toFtsQuery } from "./fts.ts";

/**
 * Build a lookup the rule SQL compiler uses for joined-collection view_rule
 * inheritance + back-relation ref-field validation. Synchronous interface
 * (the compiler runs in a hot path), so we hit the in-process collection
 * cache. Cold-cache → returns null and the compiler conservatively denies
 * for non-admin callers.
 */
/**
 * Prepared-statement cache — bun:sqlite re-parses SQL on every `.prepare()`
 * call which dominates list-endpoint latency under load. We keep one cached
 * statement per unique SQL string. Evicted only on schema changes (collection
 * rename / field add/drop).
 */
const STMT_CACHE = new Map<string, { stmt: ReturnType<Database["prepare"]> }>();
const STMT_CACHE_MAX = 256;

function getCachedStmt(client: Database, sql: string): ReturnType<Database["prepare"]> {
  const hit = STMT_CACHE.get(sql);
  if (hit) return hit.stmt;
  if (STMT_CACHE.size >= STMT_CACHE_MAX) {
    const oldest = STMT_CACHE.keys().next().value;
    if (oldest !== undefined) STMT_CACHE.delete(oldest);
  }
  const stmt = client.prepare(sql);
  STMT_CACHE.set(sql, { stmt });
  return stmt;
}

function preparedAll(client: Database, sql: string, params: unknown[]): unknown[] {
  return (getCachedStmt(client, sql) as unknown as {
    all: (...args: unknown[]) => unknown[];
  }).all(...params);
}

function preparedGet(client: Database, sql: string, params: unknown[]): unknown {
  return (getCachedStmt(client, sql) as unknown as {
    get: (...args: unknown[]) => unknown;
  }).get(...params);
}

/** Drop the cache when collection schema changes. */
export function invalidatePreparedStatements(): void {
  STMT_CACHE.clear();
}

function makeCollectionLookup(): CollectionLookup {
  return (name: string) => {
    const col = getCollectionCached(name);
    if (!col) return null;
    let fieldNames: Set<string>;
    try {
      const parsed = parseFields(col.fields);
      fieldNames = new Set(parsed.map((f) => f.name));
    } catch {
      fieldNames = new Set();
    }
    return {
      viewRule: col.view_rule,
      hasField: (n) => fieldNames.has(n) || n === "id" || n === "created_at" || n === "updated_at",
    };
  };
}
export const DEFAULT_PER_PAGE = 30;
/** Largest page size a client-facing endpoint may request. */
export const MAX_PER_PAGE = 500;

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
import { broadcast } from "../realtime/manager.ts";
import { afterCommit, gateMode, withExclusiveWrite, withSharedWrite } from "./write-gate.ts";
import { dbScopedTtlCache } from "./ttl-cache.ts";
import { invalidateRecordVectors } from "./vector-cache.ts";
import { dispatchEvent } from "./webhooks.ts";
import { validateRecord } from "./validate.ts";
import { makeHookHelpers, runAfterHook, runBeforeHook } from "./hooks.ts";
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
const AUTH_PRIVATE_COLUMNS = new Set([
  "password_hash", "totp_secret", "password_reset_at",
]);

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
  for (const [k, v] of Object.entries(row)) {
    if (k === "id" || k === "created_at" || k === "updated_at") continue;
    // Auth-system columns are private — never emit on the wire.
    if (col.type === "auth" && AUTH_PRIVATE_COLUMNS.has(k)) continue;
    const def = fieldByName.get(k);
    // Never expose password hashes via the API
    if (def?.type === "password") continue;
    out[k] = def ? decodeValue(v, def) : v;
  }
  return out;
}

/**
 * Stored rows → API records. The field map is built once per call, and the
 * conversion is synchronous unless the collection has encrypted fields, in
 * which case only those values are decrypted (async) before decoding.
 */
async function rowsToMeta(
  rows: Array<Record<string, unknown>>,
  col: Collection,
  fields: FieldDef[],
): Promise<RecordWithMeta[]> {
  const fieldByName = new Map(fields.map((f) => [f.name, f]));
  const encrypted = fields.filter((f) => f.options?.encrypted).map((f) => f.name);
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
    || (field.type === "file"   && field.options?.multiple === true);
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

// ── List ─────────────────────────────────────────────────────────────────────

type Binding = string | number | bigint | boolean | null | Uint8Array;

/**
 * WHERE clause for a list query: the caller's filter AND the collection's
 * access rule, both compiled fail-closed. Shared with vector search so it
 * scopes candidates exactly like a list does.
 */
export async function compileListWhere(
  col: Collection,
  opts: Pick<ListOptions, "filter" | "accessRule" | "auth" | "search">,
): Promise<{ whereSql: string; whereParams: Binding[] }> {
  const tname = userTableName(col.name);
  const whereParts: string[] = [];
  const whereParams: Binding[] = [];

  // Lookup callback so the SQL compiler can inherit joined-collection rules
  // and validate back-relation ref fields.
  const lookup = makeCollectionLookup();
  const filterOpts = { auth: opts.auth ?? null, lookup, hostIdField: "id" } as const;
  // The compiler resolves joined collections synchronously from the cache;
  // load them first so valid rules don't fail on a cold cache.
  await warmReferencedCollections([opts.filter, opts.accessRule]);

  if (opts.filter) {
    let compiled;
    try {
      compiled = parseFilter(opts.filter, tname, filterOpts);
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
  const match = searchMatch(col, opts.search);
  if (match) {
    whereParts.push(`${quoteIdent(tname)}.rowid IN (SELECT rowid FROM ${quoteIdent(match.table)} WHERE ${quoteIdent(match.table)} MATCH ?)`);
    whereParams.push(match.query);
  }
  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";
  return { whereSql, whereParams };
}

/**
 * Resolve `?search=` to an FTS5 query against the collection's index.
 * Null when the input is blank; FilterError when the collection has no
 * searchable fields.
 */
function searchMatch(col: Collection, search: string | undefined): { table: string; query: string } | null {
  if (search === undefined) return null;
  const query = toFtsQuery(search);
  if (!query) return null;
  if (col.type === "view" || !hasFts(rawClient(), col.name)) {
    throw new FilterError(`collection '${col.name}' has no searchable fields`);
  }
  return { table: ftsTableName(col.name), query };
}

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

  // Guard against values that would reach SQL as-is: LIMIT -1 means "no
  // limit" in SQLite, 0 gives Infinity pages, NaN fails the bind.
  const page = positiveInt(opts.page, 1);
  const perPage = positiveInt(opts.perPage, DEFAULT_PER_PAGE);
  const offset = (page - 1) * perPage;

  const { whereSql, whereParams } = await compileListWhere(col, opts);
  // A search with no explicit sort orders by relevance (bm25): the SELECT
  // joins the match set itself, so it skips the search clause in WHERE.
  const match = opts.sort === undefined ? searchMatch(col, opts.search) : null;
  const rankedWhere = match ? await compileListWhere(col, { ...(opts.filter !== undefined ? { filter: opts.filter } : {}), ...(opts.accessRule !== undefined ? { accessRule: opts.accessRule } : {}), auth: opts.auth ?? null }) : null;

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
  const sortSpec = opts.sort ?? (col.type === "view" ? "" : "-created_at");
  const orderClauses: string[] = [];
  for (const s of sortSpec.split(",").map((x) => x.trim()).filter(Boolean)) {
    const desc = s.startsWith("-");
    const field = desc ? s.slice(1) : s;
    const colName = field === "created" ? "created_at"
      : field === "updated" ? "updated_at" : field;
    // View collections accept any column name (the schema is inferred from
    // the SELECT and may not be fully reflected in `fields`); base + auth
    // collections strictly whitelist.
    if (col.type !== "view" && !sortableCols.has(colName)) continue;
    // Defense-in-depth even after whitelist: reject any value that doesn't
    // match a SQL identifier regex. Whitelist covers it for non-view, this
    // is the view-collection-fallback safety net.
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(colName)) continue;
    orderClauses.push(`${tableRef}.${quoteIdent(colName)} ${desc ? "DESC" : "ASC"}`);
  }
  const orderSql = orderClauses.length > 0 ? `ORDER BY ${orderClauses.join(", ")}` : "";

  const fts = match ? quoteIdent(match.table) : "";
  const selectSql = match && rankedWhere
    ? `SELECT ${tableRef}.* FROM ${tableRef}
         JOIN (SELECT rowid AS vb_fts_rowid, rank AS vb_fts_rank FROM ${fts} WHERE ${fts} MATCH ?) AS vb_fts
           ON vb_fts.vb_fts_rowid = ${tableRef}.rowid
         ${rankedWhere.whereSql} ORDER BY vb_fts.vb_fts_rank LIMIT ? OFFSET ?`
    : `SELECT * FROM ${tableRef} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`;
  const selectParams = match && rankedWhere
    ? [match.query, ...rankedWhere.whereParams, perPage, offset]
    : [...whereParams, perPage, offset];

  let rows: Record<string, unknown>[];
  let totalItems = -1;
  let totalPages = -1;
  try {
    // Execute SELECT — prepared statement cached by SQL string shape.
    rows = preparedAll(client, selectSql, selectParams) as Record<string, unknown>[];
    if (!opts.skipTotal) {
      const countSql = `SELECT COUNT(*) AS c FROM ${tableRef} ${whereSql}`;
      const cnt = preparedGet(client, countSql, whereParams) as { c: number } | undefined;
      totalItems = cnt?.c ?? 0;
      totalPages = Math.ceil(totalItems / perPage);
    }
  } catch (e) {
    // toFtsQuery quotes every term, but report anything FTS5 still rejects
    // as a bad request rather than a 500.
    if (opts.search && e instanceof Error && /fts5/i.test(e.message)) throw new FilterError(`invalid search: ${e.message}`);
    throw e;
  }

  let items = await rowsToMeta(rows, col, fields);

  // Expand
  if (opts.expand) {
    const expandPaths = opts.expand.split(",").map((s) => s.trim()).filter(Boolean);
    await expandRelations(items, expandPaths, fields);
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
  return row ? await rowToMetaAsync(row, col, fields) : null;
}

// ── Create ──────────────────────────────────────────────────────────────────

async function createRecordImpl(
  collectionName: string,
  data: Record<string, unknown> | null | undefined,
  auth: AuthContext | null = null
): Promise<RecordWithMeta> {
  const col = await getCollection(collectionName);
  if (!col) throw new Error(`Collection '${collectionName}' not found`);
  if (col.type === "view") throw new ReadOnlyCollectionError(col.name);
  if (col.type === "auth") {
    // Auth collections require credential hashing + verification-email
    // semantics + uniqueness checks that records.ts createRecord doesn't
    // run. Route callers to the auth signup flow instead.
    throw new Error(
      `'${col.name}' is an auth collection. Create users via POST /api/v1/auth/${col.name}/register ` +
      `(or /anonymous) — direct record-create bypasses password hashing + email verification.`,
    );
  }
  data = data ?? {};

  // beforeCreate hook (can mutate data, throw to abort)
  const helpers = makeHookHelpers();
  await runBeforeHook(col, "beforeCreate", { record: data, existing: null, auth, helpers });

  await validateRecord(col, data, "create");

  const fields = parseFields(col.fields);
  const userFields = fields.filter((f) => !f.system && !f.implicit);
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
      insertVals.push(await encodeForStorage((data as Record<string, unknown>)[f.name], f) as Binding);
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
  const result = await rowToMetaAsync(row, col, fields);
  await maybeRecordHistory(col, id, {
    op: "create",
    snapshot: result as unknown as Record<string, unknown>,
    auth,
  });
  // Inside a batch these run only after COMMIT (see write-gate.ts).
  afterCommit(() => {
    broadcast(col.name, { type: "create", collection: col.name, record: result }, {
      viewRule: col.view_rule,
      record: result as unknown as Record<string, unknown>,
    });
    void dispatchEvent({ event: `${col.name}.create`, data: { record: result } }).catch(() => { /* swallow */ });
    runAfterHook(col, "afterCreate", { record: result as unknown as Record<string, unknown>, existing: null, auth, helpers });
  });
  return result;
}

// ── Update ──────────────────────────────────────────────────────────────────

async function updateRecordImpl(
  collectionName: string,
  id: string,
  data: Record<string, unknown> | null | undefined,
  auth: AuthContext | null = null
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

  const existing = await getRecord(collectionName, id);
  if (!existing) throw new Error("Record not found");

  // beforeUpdate hook
  const helpers = makeHookHelpers();
  await runBeforeHook(col, "beforeUpdate", {
    record: data,
    existing: existing as unknown as Record<string, unknown>,
    auth,
    helpers,
  });

  await validateRecord(col, data, "update", id);

  const fields = parseFields(col.fields);
  const userFields = fields.filter((f) => !f.system && !f.implicit);
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
      setVals.push(await encodeForStorage((data as Record<string, unknown>)[f.name], f) as Binding);
    }
  }
  setCols.push(`"updated_at" = ?`);
  setVals.push(now);

  const tableRef = quoteIdent(userTableName(col.name));
  const client = rawClient();

  if (setCols.length > 1) {
    client.prepare(`UPDATE ${tableRef} SET ${setCols.join(", ")} WHERE "id" = ?`).run(...setVals, id);
  }
  // updated_at has 1 s resolution; drop the cached vector so a same-second
  // re-search sees the new value.
  invalidateRecordVectors(col.id, id);

  const row = client.prepare(`SELECT * FROM ${tableRef} WHERE "id" = ?`).get(id) as Record<string, unknown>;
  const result = await rowToMetaAsync(row, col, fields);
  await maybeRecordHistory(col, id, {
    op: "update",
    snapshot: result as unknown as Record<string, unknown>,
    auth,
  });
  afterCommit(() => {
    broadcast(col.name, { type: "update", collection: col.name, record: result }, {
      viewRule: col.view_rule,
      record: result as unknown as Record<string, unknown>,
    });
    void dispatchEvent({ event: `${col.name}.update`, data: { record: result } }).catch(() => { /* swallow */ });
    runAfterHook(col, "afterUpdate", {
      record: result as unknown as Record<string, unknown>,
      existing: existing as unknown as Record<string, unknown>,
      auth, helpers,
    });
  });
  return result;
}

// ── Delete ──────────────────────────────────────────────────────────────────

export class RestrictError extends Error {
  details: Record<string, string>;
  constructor(details: Record<string, string>) {
    super("Cannot delete: record is referenced by other records");
    this.details = details;
  }
}

export class ReadOnlyCollectionError extends Error {
  constructor(collectionName: string) {
    super(`Collection '${collectionName}' is read-only (view collection)`);
  }
}

/** A user-supplied `filter` that does not compile. Maps to HTTP 400. */
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
  const client = rawClient();
  for (const ref of refs) {
    if (ref.cascade !== "restrict") continue;
    const refTable = quoteIdent(userTableName(ref.collection.name));
    const row = client
      .prepare(`SELECT "id" FROM ${refTable} WHERE ${quoteIdent(ref.fieldName)} = ? LIMIT 1`)
      .get(id);
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
  visited: Set<string>
): Promise<void> {
  const key = `${targetColName}:${id}`;
  if (visited.has(key)) return;
  visited.add(key);

  const refs = await findIncomingRefs(targetColName);
  if (refs.length === 0) return;
  const client = rawClient();

  for (const ref of refs) {
    const refTable = quoteIdent(userTableName(ref.collection.name));
    const fieldQ = quoteIdent(ref.fieldName);

    if (ref.cascade === "setNull") {
      const affected = client
        .prepare(`SELECT "id" FROM ${refTable} WHERE ${fieldQ} = ?`)
        .all(id) as Array<{ id: string }>;
      if (affected.length === 0) continue;
      const now = Math.floor(Date.now() / 1000);
      client
        .prepare(`UPDATE ${refTable} SET ${fieldQ} = NULL, "updated_at" = ? WHERE ${fieldQ} = ?`)
        .run(now, id);
      // Notify realtime listeners with full record payloads. Hooks are skipped
      // on purpose — cascade is a bulk operation and per-row hook execution
      // would be surprisingly expensive.
      for (const r of affected) {
        const rec = await getRecord(ref.collection.name, r.id);
        if (rec) afterCommit(() => broadcast(ref.collection.name, { type: "update", collection: ref.collection.name, record: rec }, {
          viewRule: ref.collection.view_rule,
          record: rec as unknown as Record<string, unknown>,
        }));
      }
      continue;
    }

    if (ref.cascade === "cascade") {
      const affected = client
        .prepare(`SELECT "id" FROM ${refTable} WHERE ${fieldQ} = ?`)
        .all(id) as Array<{ id: string }>;
      for (const r of affected) {
        await deleteRecordInternal(ref.collection.name, r.id, auth, visited);
      }
    }
  }
}

async function deleteRecordImpl(
  collectionName: string,
  id: string,
  auth: AuthContext | null = null
): Promise<void> {
  return deleteRecordInternal(collectionName, id, auth, new Set<string>());
}

async function deleteRecordInternal(
  collectionName: string,
  id: string,
  auth: AuthContext | null,
  visited: Set<string>
): Promise<void> {
  const col = await getCollection(collectionName);
  if (!col) throw new Error(`Collection '${collectionName}' not found`);
  if (col.type === "view") throw new ReadOnlyCollectionError(col.name);

  const existing = await getRecord(collectionName, id);
  if (!existing) return;

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

  await applyCascades(col.name, id, auth, visited);

  const tableRef = quoteIdent(userTableName(col.name));
  rawClient().prepare(`DELETE FROM ${tableRef} WHERE "id" = ?`).run(id);
  invalidateRecordVectors(col.id, id);
  await maybeRecordHistory(col, id, {
    op: "delete",
    snapshot: existing as unknown as Record<string, unknown>,
    auth,
  });
  // Pass the just-deleted record snapshot so per-subscriber view_rule eval still has fields.
  afterCommit(() => {
    broadcast(col.name, { type: "delete", collection: col.name, id }, {
      viewRule: col.view_rule,
      record: existing as unknown as Record<string, unknown>,
    });
    void dispatchEvent({ event: `${col.name}.delete`, data: { id, record: existing } }).catch(() => { /* swallow */ });
    runAfterHook(col, "afterDelete", {
      record: {},
      existing: existing as unknown as Record<string, unknown>,
      auth, helpers,
    });
  });
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
  schema: FieldDef[]
): Promise<void> {
  if (items.length === 0 || expandPaths.length === 0) return;
  const client = rawClient();
  const tree = parseExpandTree(expandPaths);

  for (const [fieldName, restPaths] of tree) {
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
      await expandRelations(expanded, restPaths, targetFields);
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
): Promise<RecordWithMeta> {
  return withSharedWrite(() => createRecordImpl(collectionName, data, auth));
}

export function updateRecord(
  collectionName: string,
  id: string,
  data: Record<string, unknown> | null | undefined,
  auth: AuthContext | null = null,
): Promise<RecordWithMeta> {
  return withSharedWrite(() => updateRecordImpl(collectionName, id, data, auth));
}

/**
 * A delete that cascades touches several rows and awaits hooks in between, so
 * it runs in a transaction: its own (taking the gate exclusively, like a
 * batch), or a savepoint inside an enclosing batch. A plain delete with
 * nothing to cascade is a single statement and stays on the shared path.
 */
export async function deleteRecord(
  collectionName: string,
  id: string,
  auth: AuthContext | null = null,
): Promise<void> {
  const col = await getCollection(collectionName);
  const cascades = col
    ? (await findIncomingRefs(col.name)).some((r) => r.cascade !== "restrict")
    : false;
  const run = () => deleteRecordImpl(collectionName, id, auth);
  if (!cascades) return withSharedWrite(run);

  const mode = gateMode();
  if (mode === "exclusive") return inSavepoint(run);
  // Nested inside another ordinary write (e.g. a hook deleting a record):
  // taking the gate exclusively here would wait on ourselves. Runs without
  // a transaction; hook-before-cascade ordering still applies.
  if (mode === "shared") return run();

  const client = rawClient();
  return withExclusiveWrite(async (tx) => {
    try {
      client.exec("BEGIN");
      await run();
      client.exec("COMMIT");
      tx.commit();
    } catch (e) {
      if (client.inTransaction) client.exec("ROLLBACK");
      tx.rollback();
      throw e;
    }
  });
}

let savepointSeq = 0;

async function inSavepoint(fn: () => Promise<void>): Promise<void> {
  const name = `vb_delete_${++savepointSeq}`;
  const client = rawClient();
  client.exec(`SAVEPOINT ${name}`);
  try {
    await fn();
    client.exec(`RELEASE ${name}`);
  } catch (e) {
    client.exec(`ROLLBACK TO ${name}`);
    client.exec(`RELEASE ${name}`);
    throw e;
  }
}
