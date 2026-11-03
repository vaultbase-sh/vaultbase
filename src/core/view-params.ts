/**
 * Parameters on view collections: `:name` in a view's query, filled from the
 * request (`?params[name]=…`) or from the caller (`from: "auth.id"`).
 *
 * A read of a view with parameters runs its query as a subquery with the
 * values bound, `FROM (<query>) AS "vb_<name>"`, so rules, filters, sorting
 * and paging apply on top as for any view. Values are always bound, each
 * behind a cast to its type, never written into the SQL.
 *
 * The database view stays, built with each parameter's default written in
 * (NULL where there is none): other views, `@collection.<view>` in rules and
 * relations into the view read it, and get the defaults.
 */
import { rewriteSqlParams } from "./sql-scan.ts";
import { db } from "../db/index.ts";
import type { RequestContextLike } from "./filter.ts";

export type ViewParamType = "text" | "number" | "bool" | "date";
export const VIEW_PARAM_TYPES: readonly ViewParamType[] = ["text", "number", "bool", "date"];

export interface ViewParam {
  name: string;
  type: ViewParamType;
  /** Used when the request doesn't pass the parameter; stored already converted. */
  default?: string | number | null;
  /** No default: a read without it is refused. */
  required?: boolean;
  /** Filled from the caller, never from the request (NULL for a guest). */
  from?: "auth.id";
}

export const MAX_VIEW_PARAMS = 20;
const MIN_DATE_SECONDS = -62135596800; // 0001-01-01
const MAX_DATE_SECONDS = 253402300799; // 9999-12-31T23:59:59
export const MAX_VIEW_PARAM_VALUE = 1000;
const NAME_RE = /^[a-z_][a-z0-9_]{0,31}$/;

/** A request's parameters don't fit the view. HTTP 400. */
export class ViewParamError extends Error {}

/** The stored list, or none when it's missing or unreadable. */
export function parseViewParams(raw: string | null | undefined): ViewParam[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as ViewParam[]) : [];
  } catch {
    return [];
  }
}

/**
 * `value` as the type binds it: text a string, number a finite number, bool
 * 1 / 0 (how bool fields are stored), date Unix seconds (as date fields).
 * Throws a message for the caller to put in context.
 */
export function coerceViewParam(type: ViewParamType, value: unknown): string | number {
  switch (type) {
    case "text": {
      if (typeof value !== "string" && typeof value !== "number") throw new Error("must be text");
      const s = String(value);
      if (s.length > MAX_VIEW_PARAM_VALUE) throw new Error(`must be at most ${MAX_VIEW_PARAM_VALUE} characters`);
      return s;
    }
    case "number": {
      const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
      if (!Number.isFinite(n)) throw new Error("must be a number");
      return n;
    }
    case "bool": {
      if (value === true || value === 1 || value === "true" || value === "1") return 1;
      if (value === false || value === 0 || value === "false" || value === "0") return 0;
      throw new Error("must be true or false");
    }
    case "date": {
      let sec: number | null = null;
      if (typeof value === "number" && Number.isFinite(value)) sec = Math.floor(value);
      else if (typeof value === "string" && value.trim() !== "") {
        if (/^-?\d+$/.test(value.trim())) sec = Number(value.trim());
        else {
          const ms = Date.parse(value);
          if (!Number.isNaN(ms)) sec = Math.floor(ms / 1000);
        }
      }
      if (sec === null) throw new Error("must be a date (ISO 8601) or Unix seconds");
      // Years 0001-9999: bound as a 64-bit integer on Postgres, where a value
      // past its range was a 500.
      if (sec < MIN_DATE_SECONDS || sec > MAX_DATE_SECONDS) throw new Error("is out of range (years 1 to 9999)");
      return sec;
    }
  }
}

function castType(type: ViewParamType): string {
  const pg = db.name === "postgres";
  switch (type) {
    case "text": return pg ? "text" : "TEXT";
    // double precision, as number fields are stored (numeric would come
    // back from Postgres as a string). For LIMIT write CAST(:n AS integer).
    case "number": return pg ? "double precision" : "NUMERIC";
    case "bool":
    case "date": return pg ? "bigint" : "INTEGER";
  }
}

function literal(type: ViewParamType, value: string | number | null | undefined): string {
  if (value === null || value === undefined) return `CAST(NULL AS ${castType(type)})`;
  const sql = typeof value === "number" ? String(value) : `'${value.replace(/'/g, "''")}'`;
  return `CAST(${sql} AS ${castType(type)})`;
}

/** The `:name`s in a query, in order (repeats included). */
export function viewQueryParamNames(query: string): string[] {
  return rewriteSqlParams(query, () => "NULL", { pg: db.name === "postgres", bound: false }).names;
}

/**
 * Check a `view_params` list against its query and return it tidied. Every
 * `:name` must be declared and every declared parameter used. Throws a
 * message for `view_params`.
 */
export function validateViewParams(query: string, input: unknown): ViewParam[] {
  if (input === undefined || input === null || input === "") input = [];
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { throw new Error("must be a JSON array"); }
  }
  if (!Array.isArray(input)) throw new Error("must be a list of parameters");
  if (input.length > MAX_VIEW_PARAMS) throw new Error(`at most ${MAX_VIEW_PARAMS} parameters`);
  const out: ViewParam[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object") throw new Error("each parameter must be an object");
    const p = raw as Record<string, unknown>;
    const name = p["name"];
    if (typeof name !== "string" || !NAME_RE.test(name)) {
      throw new Error(`'${String(name)}' isn't a parameter name (lowercase letters, digits and _, up to 32, not starting with a digit)`);
    }
    if (seen.has(name)) throw new Error(`'${name}' is declared twice`);
    seen.add(name);
    const type = p["type"];
    if (!VIEW_PARAM_TYPES.includes(type as ViewParamType)) throw new Error(`'${name}': type must be one of ${VIEW_PARAM_TYPES.join(", ")}`);
    const param: ViewParam = { name, type: type as ViewParamType };
    if (p["from"] !== undefined && p["from"] !== null) {
      if (p["from"] !== "auth.id") throw new Error(`'${name}': from can only be "auth.id"`);
      if (type !== "text") throw new Error(`'${name}': a parameter from auth.id is text`);
      param.from = "auth.id";
    }
    if (p["required"] === true) {
      if (param.from) throw new Error(`'${name}': a parameter from auth.id can't be required`);
      param.required = true;
    }
    if (p["default"] !== undefined && p["default"] !== null) {
      if (param.from || param.required) throw new Error(`'${name}': a ${param.from ? "parameter from auth.id" : "required parameter"} has no default`);
      try { param.default = coerceViewParam(param.type, p["default"]); } catch (e) { throw new Error(`'${name}': the default ${(e as Error).message}`); }
    }
    out.push(param);
  }
  const used = new Set(viewQueryParamNames(query));
  for (const n of used) if (!seen.has(n)) throw new Error(`the query uses :${n}, which isn't declared`);
  for (const p of out) if (!used.has(p.name)) throw new Error(`'${p.name}' is declared but the query doesn't use :${p.name}`);
  return out;
}

/** The value the database view is built with for `p`: its default, or NULL for a `from` or required one. */
function databaseViewValue(p: ViewParam): string | number | null {
  return p.from || p.required ? null : p.default ?? null;
}

/** The query with each parameter's default written in, for the database view and field inference. */
export function viewQueryWithDefaults(query: string, params: ViewParam[]): string {
  if (params.length === 0) return query;
  const byName = new Map(params.map((p) => [p.name, p]));
  return rewriteSqlParams(query, (name) => {
    const p = byName.get(name);
    return p ? literal(p.type, databaseViewValue(p)) : "NULL";
  }, { pg: db.name === "postgres", bound: false }).sql;
}

/**
 * Each parameter's value in the database view (viewQueryWithDefaults): what
 * `@collection.<view>` joins, relations and expand into the view read. Null
 * when the view has no parameters.
 */
export function databaseViewParamValues(params: ViewParam[]): Map<string, string | number | null> | null {
  if (params.length === 0) return null;
  return new Map(params.map((p) => [p.name, databaseViewValue(p)]));
}

/**
 * The request as rules see it, with `@request.query.params.<name>` set to
 * `values` (NULL ones left unset) and every other `params.*` key removed, so
 * a rule never checks a value other than the one the rows were read with.
 */
export function requestWithViewParams(
  request: RequestContextLike | null | undefined,
  values: ReadonlyMap<string, string | number | null> | null,
): RequestContextLike | null | undefined {
  if (!values) return request;
  const query: Record<string, string> = {};
  for (const [k, v] of Object.entries(request?.query ?? {})) if (!k.startsWith("params.")) query[k] = v;
  for (const [name, v] of values) if (v !== null) query[`params.${name}`] = String(v);
  return { ...(request ?? {}), query };
}

/** `params[name]=value` pairs of a URL's query string (the last wins), or null when there are none. */
export function viewParamsFromUrl(search: URLSearchParams): Record<string, string> | null {
  let out: Record<string, string> | null = null;
  for (const [k, v] of search) {
    const m = /^params\[([^\]]*)\]$/.exec(k);
    if (!m) continue;
    (out ??= {})[m[1]!] = v;
  }
  return out;
}

/**
 * Each parameter's value for one read: from the request, the caller or the
 * default. Throws ViewParamError for a name the view doesn't have, a value
 * that doesn't fit, a required one missing, or a caller setting one that
 * comes from auth.
 */
export function resolveViewParams(
  params: ViewParam[],
  given: Record<string, unknown> | null | undefined,
  authId: string | null,
): Map<string, string | number | null> {
  const byName = new Map(params.map((p) => [p.name, p]));
  const values = new Map<string, string | number | null>();
  const supplied = given ?? {};
  const keys = Object.keys(supplied);
  if (keys.length > MAX_VIEW_PARAMS) throw new ViewParamError(`at most ${MAX_VIEW_PARAMS} parameters`);
  for (const k of keys) {
    const p = byName.get(k);
    if (!p) throw new ViewParamError(`unknown parameter '${k}'`);
    if (p.from) throw new ViewParamError(`parameter '${k}' can't be set: it comes from the signed-in user`);
    try {
      values.set(k, coerceViewParam(p.type, supplied[k]));
    } catch (e) {
      throw new ViewParamError(`parameter '${k}' ${(e as Error).message}`);
    }
  }
  for (const p of params) {
    if (values.has(p.name)) continue;
    if (p.from === "auth.id") values.set(p.name, authId);
    else if (p.required) throw new ViewParamError(`parameter '${p.name}' is required`);
    else values.set(p.name, p.default ?? null);
  }
  return values;
}

/**
 * The view's query as a subquery source for one read: `(<query>) AS "<alias>"`
 * with a cast placeholder per `:name`, and the values to bind, in order.
 */
export function boundViewSource(
  query: string,
  params: ViewParam[],
  values: Map<string, string | number | null>,
  alias: string,
): { sql: string; binds: Array<string | number | null> } {
  const types = new Map(params.map((p) => [p.name, p.type]));
  const binds: Array<string | number | null> = [];
  const body = rewriteSqlParams(query.trim().replace(/;\s*$/, ""), (name) => {
    binds.push(values.get(name) ?? null);
    return `CAST(? AS ${castType(types.get(name) ?? "text")})`;
  }, { pg: db.name === "postgres", bound: true }).sql;
  return { sql: `(${body}) AS ${alias}`, binds };
}
