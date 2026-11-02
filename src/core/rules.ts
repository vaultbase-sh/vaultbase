import type { Expr, Operand, AnyCmpOp, FieldModifier } from "./expression.ts";
import { macroValue, requestMapHas, requestMapValue, stableEq } from "./expression.ts";
import { cachedParseExpression as parseExpression } from "./filter-cache.ts";
import type { RequestContextLike } from "./filter.ts";

export interface AuthContext {
  id: string;
  type: "user" | "admin";
  email?: string;
  /** Users: the auth collection the account belongs to. */
  collection?: string;
  /** Users: a guest session from `/auth/:collection/anonymous`. */
  anonymous?: boolean;
  /** Users: the account's email is verified (as of this request). */
  verified?: boolean;
}

export interface EvalContext {
  auth: AuthContext | null;
  record: Record<string, unknown> | null;
  request?: RequestContextLike | null | undefined;
  /**
   * `record` is an item inside `items:any(...)`: its keys are read as they
   * are (no `created`/`updated` twins), and values compare by JSON type as
   * the SQL does (`qty = "3"` doesn't match 3).
   */
  item?: boolean;
}

/**
 * Evaluate a rule against the current auth + record + request context.
 *
 * Conventions:
 * - `null` rule  → public access (always allowed)
 * - `""`   rule  → admin only
 * - any expression → parse + evaluate. Admin always passes regardless.
 *
 * Returns true if access is allowed.
 */
export function evaluateRule(
  rule: string | null,
  auth: AuthContext | null,
  record: Record<string, unknown> | null,
  request?: RequestContextLike | null,
): boolean {
  if (rule === null) return true;
  if (rule === "") return auth?.type === "admin";

  // Admins bypass all rules
  if (auth?.type === "admin") return true;

  const ast = parseExpression(rule);
  if (!ast) return false;

  try {
    return evaluateExpr(ast, { auth, record, request: request ?? null });
  } catch {
    return false;
  }
}

/**
 * A non-admin's check of one rule expression, parsed once, for checking
 * many records (evaluateRule parses on every call). An expression that
 * doesn't parse denies, as there.
 */
export function compileRule(rule: string): (auth: AuthContext | null, record: Record<string, unknown> | null, request: RequestContextLike | null) => boolean {
  const ast = parseExpression(rule);
  return (auth, record, request) => {
    if (!ast) return false;
    try {
      return evaluateExpr(ast, { auth, record, request });
    } catch {
      return false;
    }
  };
}

// ── AST evaluation ──────────────────────────────────────────────────────────

/**
 * An operand with no usable value here: an anonymous caller's auth field, or a
 * cross-collection lookup this engine can't run. Any comparison involving it
 * is false — whatever the operator, so `!=` can't turn "unknown" into a pass.
 */
const UNAUTH_SENTINEL = Symbol("unauth");

function evaluateExpr(ast: Expr, ctx: EvalContext): boolean {
  if (ast.kind === "any") return evaluateAny(ast, ctx);
  if (ast.kind === "and") return evaluateExpr(ast.left, ctx) && evaluateExpr(ast.right, ctx);
  if (ast.kind === "or")  return evaluateExpr(ast.left, ctx) || evaluateExpr(ast.right, ctx);

  const op = ast.op;

  // Array-prefix operator: match-any-element semantics.
  if (op.startsWith("?")) {
    const scalarOp = op.slice(1) as AnyCmpOp;
    return evaluateArrayCmp(ast.left, ast.right, scalarOp, ctx);
  }

  // `:each` modifier — match-every-element semantics.
  if (
    ((ast.left.kind === "field" || ast.left.kind === "collection") && ast.left.modifier === "each") ||
    ((ast.right.kind === "field" || ast.right.kind === "collection") && ast.right.modifier === "each")
  ) {
    return evaluateEach(ast.left, ast.right, op, ctx);
  }

  const l = resolveOperand(ast.left, ctx);
  const r = resolveOperand(ast.right, ctx);

  // NULL as SQL has it, so a single-record check agrees with the list query:
  // `= null` / `!= null` written as a literal are IS NULL / IS NOT NULL, and
  // any other comparison with a missing value is unknown, which no rule
  // passes (`status != "secret"` doesn't admit a record with no status).
  // `~` / `!~` are the exception: the SQL wraps LIKE in coalesce(…, false),
  // so a missing side is false for `~` and true for `!~`, which contains()
  // below already gives.
  const nullLiteral = (o: Operand) => o.kind === "literal" && o.value === null;
  if ((op === "=" || op === "!=") && (nullLiteral(ast.left) || nullLiteral(ast.right))) {
    const v = nullLiteral(ast.left) ? r : l;
    // No signed-in user: `@request.auth.id = null` holds, as in the SQL.
    const isNull = v === null || v === undefined || v === UNAUTH_SENTINEL;
    return op === "=" ? isNull : !isNull;
  }
  if (l === UNAUTH_SENTINEL || r === UNAUTH_SENTINEL) return false;
  // A pattern written in the rule: `%` and `_` are wildcards, as the SQL
  // (LIKE) has them. Here they were plain text, so a list showed records
  // that the same rule refused by id and over realtime.
  if ((op === "~" || op === "!~") && ast.right.kind === "literal" && typeof r === "string" && /[%_]/.test(r)) {
    const m = likeMatch(l, r);
    return op === "~" ? m : !m;
  }
  return compareScalar(l, op, r, ctx.item === true);
}

/**
 * `~`, as SQLite's LIKE does it in list queries: an empty or missing needle
 * matches nothing, and ASCII letters match regardless of case (other letters
 * don't). Matching case-sensitively here let `title !~ "confidential"` hide
 * "CONFIDENTIAL plan" from lists but serve it by id and over realtime.
 */
function contains(haystack: unknown, needle: unknown): boolean {
  const n = needle === null || needle === undefined ? "" : String(needle);
  return n !== "" && asciiLower(String(haystack ?? "")).includes(asciiLower(n));
}

/** SQLite's `x LIKE '%pattern%'`: `%` any run, `_` one character, ASCII letters in either case. */
function likeMatch(haystack: unknown, pattern: string): boolean {
  if (haystack === null || haystack === undefined || pattern === "") return false;
  const re = asciiLower(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, "[\\s\\S]*").replace(/_/g, "[\\s\\S]");
  return new RegExp(re, "u").test(asciiLower(String(haystack)));
}

function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

function evaluateEach(left: Operand, right: Operand, op: AnyCmpOp, ctx: EvalContext): boolean {
  const isArrayCandidate = (o: Operand) =>
    (o.kind === "field" || o.kind === "collection") && o.modifier === "each";
  const arrayOperand: Operand = isArrayCandidate(left) ? left : right;
  const scalarOperand = arrayOperand === left ? right : left;

  // Resolve the array WITHOUT the modifier (modifier turned the operand into a marker only).
  let stripped: Operand;
  if (arrayOperand.kind === "field") {
    stripped = { kind: "field", name: arrayOperand.name, path: arrayOperand.path };
  } else if (arrayOperand.kind === "collection") {
    stripped = arrayOperand.alias
      ? { kind: "collection", collection: arrayOperand.collection, alias: arrayOperand.alias, path: arrayOperand.path }
      : { kind: "collection", collection: arrayOperand.collection, path: arrayOperand.path };
  } else {
    return false;
  }

  const target = resolveOperand(scalarOperand, ctx);
  if (target === UNAUTH_SENTINEL) return false;
  const items = itemPath(stripped);
  if (items) {
    // At least one item, every one an object whose value compares true (filter.ts everyItemCmp).
    const list = resolveOperand(items.list, ctx);
    if (Array.isArray(list) && list.length > 0
      && list.every((item) => isItem(item) && compareScalar(walkPath(item, items.path), op, target, true))) return true;
  }
  const arr = resolveOperand(stripped, ctx);
  if (!Array.isArray(arr) || arr.length === 0) return false;

  if (ctx.item) return arr.every((item) => compareScalar(item, op, target, true));
  return arr.every((item) => {
    switch (op) {
      case "=":  return looseEq(item, target);
      case "!=": return !looseEq(item, target);
      case ">":  return cmp(item, target) > 0;
      case ">=": return cmp(item, target) >= 0;
      case "<":  return cmp(item, target) < 0;
      case "<=": return cmp(item, target) <= 0;
      case "~":  return contains(item, target);
      case "!~": return !contains(item, target);
      default:   return false;
    }
  });
}

function evaluateArrayCmp(left: Operand, right: Operand, scalarOp: AnyCmpOp, ctx: EvalContext): boolean {
  // Array operand is the field side; scalar is the literal/auth side.
  const arrayOperand = left.kind === "field" || left.kind === "collection" ? left : right;
  const scalarOperand = arrayOperand === left ? right : left;

  const target = resolveOperand(scalarOperand, ctx);
  if (target === UNAUTH_SENTINEL) return false;
  const items = itemPath(arrayOperand);
  if (items) {
    // Some item whose value compares true (filter.ts anyItemCmp).
    const list = resolveOperand(items.list, ctx);
    if (Array.isArray(list) && list.some((item) => isItem(item) && compareScalar(walkPath(item, items.path), scalarOp, target, true))) return true;
  }
  const arr = resolveOperand(arrayOperand, ctx);
  if (!Array.isArray(arr)) return false;

  if (ctx.item) return arr.some((item) => compareScalar(item, scalarOp, target, true));
  for (const item of arr) {
    let match: boolean;
    switch (scalarOp) {
      case "=":  match = looseEq(item, target); break;
      case "!=": match = !looseEq(item, target); break;
      case ">":  match = cmp(item, target) > 0; break;
      case ">=": match = cmp(item, target) >= 0; break;
      case "<":  match = cmp(item, target) < 0; break;
      case "<=": match = cmp(item, target) <= 0; break;
      case "~":  match = contains(item, target); break;
      case "!~": match = !contains(item, target); break;
      default:   match = false;
    }
    if (match) return true;
  }
  return false;
}

/**
 * `items:any(<where>)`: some element of the list is an object for which
 * `where` holds, its field names read from the element (filter.ts compileAny).
 */
function evaluateAny(ast: Extract<Expr, { kind: "any" }>, ctx: EvalContext): boolean {
  const list = resolveOperand(ast.target, ctx);
  if (!Array.isArray(list)) return false;
  return list.some((item) => isItem(item) && evaluateExpr(ast.where, { ...ctx, record: item, item: true }));
}

const isItem = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `x.f` → the field `x` and the path read in each of its items (filter.ts itemPath). */
function itemPath(op: Operand): { list: Operand; path: string[] } | null {
  if (op.kind !== "field" || op.path.length === 0) return null;
  return { list: { kind: "field", name: op.name, path: [] }, path: op.path };
}

/**
 * One comparison with SQL's NULL rules, as evaluateExpr applies them to a
 * plain comparison. `json`: the values are an item's JSON values, compared
 * by type as filter.ts does there (a number or boolean with a number, text
 * with text); values of different types match nothing.
 */
function compareScalar(l: unknown, op: AnyCmpOp, r: unknown, json = false): boolean {
  if (l === UNAUTH_SENTINEL || r === UNAUTH_SENTINEL) return false;
  if (op !== "~" && op !== "!~" && (l === null || l === undefined || r === null || r === undefined)) return false;
  if (json && op !== "~" && op !== "!~") {
    const num = (v: unknown) => typeof v === "number" || typeof v === "boolean";
    if (!(num(l) && num(r)) && !(typeof l === "string" && typeof r === "string")) return false;
    // Text orders as SQL orders it, by code point: "10" < "9", "B" < "a".
    if (typeof l === "string" && typeof r === "string" && op !== "=" && op !== "!=") {
      const c = codePointOrder(l, r);
      return op === ">" ? c > 0 : op === ">=" ? c >= 0 : op === "<" ? c < 0 : c <= 0;
    }
  }
  switch (op) {
    case "=":  return looseEq(l, r);
    case "!=": return !looseEq(l, r);
    case ">":  return cmp(l, r) > 0;
    case ">=": return cmp(l, r) >= 0;
    case "<":  return cmp(l, r) < 0;
    case "<=": return cmp(l, r) <= 0;
    case "~":  return contains(l, r);
    case "!~": return !contains(l, r);
    default:   return false;
  }
}

/** `a` against `b` by Unicode code point, as SQLite and Postgres (C collation) order UTF-8 text. */
function codePointOrder(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

function resolveOperand(op: Operand, ctx: EvalContext): unknown {
  switch (op.kind) {
    case "literal": return op.value;
    case "auth": {
      if (!ctx.auth) return UNAUTH_SENTINEL;
      if (op.prop === "id") return ctx.auth.id || UNAUTH_SENTINEL;
      if (op.prop === "type") return ctx.auth.type;
      if (op.prop === "collectionName") return ctx.auth.collection ?? null;
      if (op.prop === "verified") return ctx.auth.verified ? 1 : 0;
      if (op.prop === "anonymous") return ctx.auth.anonymous ? 1 : 0;
      return ctx.auth.email ?? UNAUTH_SENTINEL;
    }
    case "request": return ctx.request?.[op.prop] ?? null;
    case "requestMap": {
      const map = ctx.request?.[op.mapKind];
      const key = op.key;
      const v = requestMapValue(map, op.mapKind, key);
      if (op.modifier === "isset") return requestMapHas(map, op.mapKind, key);
      if (op.modifier === "changed" && op.mapKind === "body") {
        const body = ctx.request?.body ?? null;
        const existing = ctx.request?.existing ?? null;
        if (!body || !existing) return false;
        return !stableEq(
          (existing as Record<string, unknown>)[key],
          (body as Record<string, unknown>)[key],
        );
      }
      return applyModifierValue(v, op.modifier);
    }
    case "macro": return macroValue(op.name);
    case "func":  return evalFunc(op, ctx);
    case "field": {
      const head = ctx.item
        ? (ctx.record && Object.prototype.hasOwnProperty.call(ctx.record, op.name) ? ctx.record[op.name] : undefined)
        : fieldValue(ctx.record, op.name);
      const v = walkPath(head, op.path);
      return applyModifierValue(v, op.modifier);
    }
    case "collection":
    case "viaRelation": {
      // In-process eval: cross-collection joins require a DB read; we don't
      // run them here. The SQL filter path (filter.ts) handles them. In
      // single-record eval (view_rule on get-by-id, realtime) any comparison
      // with one is false, so the rule can only deny more. Returning null
      // here used to let `@collection.bans.user != @request.auth.id` pass.
      return UNAUTH_SENTINEL;
    }
  }
}

/**
 * A JSON path read as SQL reads it: through objects' own keys only, so
 * `tags.length` on a list or `meta.constructor` is no value.
 */
function walkPath(start: unknown, path: string[]): unknown {
  let v: unknown = start;
  for (const seg of path) {
    if (!isItem(v) || !Object.prototype.hasOwnProperty.call(v, seg)) return null;
    v = v[seg];
  }
  return v;
}

/**
 * A record's field for a rule. A record may come as the API shapes it
 * (`created`, `updated`) or as the table row (`created_at`, `updated_at`);
 * the list query (filter.ts) takes either name, so this does too.
 */
function fieldValue(record: Record<string, unknown> | null | undefined, name: string): unknown {
  if (!record) return undefined;
  if (Object.prototype.hasOwnProperty.call(record, name)) return record[name];
  const twin = name === "created_at" ? "created" : name === "updated_at" ? "updated"
    : name === "created" ? "created_at" : name === "updated" ? "updated_at" : null;
  return twin ? record[twin] : undefined;
}

function applyModifierValue(v: unknown, m?: FieldModifier): unknown {
  if (!m) return v;
  switch (m) {
    case "lower":  return typeof v === "string" ? v.toLowerCase() : v;
    case "length":
      if (Array.isArray(v)) return v.length;
      if (typeof v === "string") return v.length;
      // SQL's length of NULL is NULL, which no comparison matches.
      return v === null || v === undefined ? null : 0;
    default: return v;
  }
}

/**
 * A function this engine can't answer the way SQL would (an argument it
 * can't use, a form it doesn't support) yields UNAUTH_SENTINEL, so every
 * comparison with it is false: a single-record check never allows what the
 * list query would deny.
 */
function evalFunc(op: Extract<Operand, { kind: "func" }>, ctx: EvalContext): unknown {
  const args = op.args.map((a) => resolveOperand(a, ctx));
  if (args.some((a) => a === UNAUTH_SENTINEL)) return UNAUTH_SENTINEL;
  if (op.name === "geoDistance") {
    if (args.length !== 4 || args.some((a) => a === null || a === undefined || a === "")) return UNAUTH_SENTINEL;
    // An item's value counts only as a JSON number (or boolean), as the SQL reads it.
    if (ctx.item && op.args.some((a, i) => a.kind === "field" && !a.modifier && typeof args[i] !== "number" && typeof args[i] !== "boolean")) {
      return UNAUTH_SENTINEL;
    }
    const nums = args.map(Number);
    if (nums.some((n) => !Number.isFinite(n))) return UNAUTH_SENTINEL;
    const [lonA, latA, lonB, latB] = nums as [number, number, number, number];
    return haversineKm(latA, lonA, latB, lonB);
  }
  if (op.name === "strftime") return strftimeUtc(args) ?? UNAUTH_SENTINEL;
  return UNAUTH_SENTINEL;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** The strftime codes this engine and the Postgres compiler both support, in UTC. */
const STRFTIME_CODES: Readonly<Record<string, (d: Date) => string>> = {
  Y: (d) => pad(d.getUTCFullYear(), 4),
  m: (d) => pad(d.getUTCMonth() + 1),
  d: (d) => pad(d.getUTCDate()),
  H: (d) => pad(d.getUTCHours()),
  M: (d) => pad(d.getUTCMinutes()),
  S: (d) => pad(d.getUTCSeconds()),
  j: (d) => pad(Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1, 3),
  // A literal %: both SQL compilers support it.
  "%": () => "%",
};

/** "YYYY-MM-DD", optionally with " HH:MM[:SS[.fff]]" or "T…" and a "Z": what SQLite reads as UTC. */
const SQL_TIME = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?Z?$/;

/**
 * SQLite's `strftime(format, time, mods…)` for the forms the Postgres
 * compiler also accepts: a format of the codes above, and a time that is
 * 'now', a literal timestamp, or a stored date (Unix seconds) with the
 * 'unixepoch' modifier. Anything else, or a missing time, is null here
 * (SQL answers NULL too, which no comparison matches).
 */
function strftimeUtc(args: unknown[]): string | null {
  const [fmt, time, ...mods] = args;
  if (typeof fmt !== "string" || mods.length > 1 || (mods.length === 1 && mods[0] !== "unixepoch")) return null;
  let date: Date;
  if (mods.length === 1) {
    if (time === null || time === undefined || time === "" || typeof time === "boolean") return null;
    const secs = Number(time);
    if (!Number.isFinite(secs)) return null;
    date = new Date(secs * 1000);
  } else if (time === "now") {
    date = new Date();
  } else if (typeof time === "string") {
    const m = SQL_TIME.exec(time);
    if (!m) return null;
    date = new Date(`${m[1]}T${m[2] ?? "00:00"}Z`);
  } else {
    return null;
  }
  if (Number.isNaN(date.getTime())) return null;
  let out = "";
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] !== "%") { out += fmt[i]; continue; }
    const code = STRFTIME_CODES[fmt[i + 1] ?? ""];
    if (!code) return null;
    out += code(date);
    i++;
  }
  return out;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === UNAUTH_SENTINEL || b === UNAUTH_SENTINEL) return false;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (typeof a === "boolean") a = a ? 1 : 0;
  if (typeof b === "boolean") b = b ? 1 : 0;
  if (typeof a === "number" || typeof b === "number") {
    // Number("") is 0, but in SQL '' isn't 0.
    if (a === "" || b === "") return false;
    return Number(a) === Number(b);
  }
  return String(a) === String(b);
}

function cmp(a: unknown, b: unknown): number {
  // Two strings compare as text, by code point, as the SQL does ("B" < "a",
  // "10" < "9"); turning numeric-looking ones into numbers, or comparing by
  // locale, made a single record pass where the list refused it.
  if (typeof a === "string" && typeof b === "string") return codePointOrder(a, b);
  const na = typeof a === "boolean" ? (a ? 1 : 0) : a === "" ? NaN : Number(a);
  const nb = typeof b === "boolean" ? (b ? 1 : 0) : b === "" ? NaN : Number(b);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return codePointOrder(String(a ?? ""), String(b ?? ""));
}

