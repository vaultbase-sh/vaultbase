import type { Expr, Operand, AnyCmpOp, FieldModifier } from "./expression.ts";
import { macroValue, requestMapHas, requestMapValue, stableEq } from "./expression.ts";
import { cachedParseExpression as parseExpression } from "./filter-cache.ts";
import type { RequestContextLike } from "./filter.ts";
import { db, getDriver } from "../db/index.ts";

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

/**
 * A value this engine can't produce exactly as the SQL would (a case fold
 * the database might do differently, a JSON text whose form it can't be
 * sure of). Like UNAUTH_SENTINEL, every comparison with it is false, so the
 * single-record check can only deny more than the list query.
 */
const UNSURE = Symbol("unsure");

const unknownValue = (v: unknown): boolean => v === UNAUTH_SENTINEL || v === UNSURE;

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

  let l = resolveOperand(ast.left, ctx);
  let r = resolveOperand(ast.right, ctx);

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
    if (v === UNSURE) return false;
    // No signed-in user: `@request.auth.id = null` holds, as in the SQL.
    const isNull = v === null || v === undefined || v === UNAUTH_SENTINEL;
    return op === "=" ? isNull : !isNull;
  }
  if (readsJsonText(ast.left, ctx)) l = asSqlJsonText(l, op);
  if (readsJsonText(ast.right, ctx)) r = asSqlJsonText(r, op);
  if (unknownValue(l) || unknownValue(r)) return false;
  // A pattern written in the rule: `%` and `_` are wildcards, as the SQL
  // (LIKE) has them. Here they were plain text, so a list showed records
  // that the same rule refused by id and over realtime.
  if ((op === "~" || op === "!~") && ast.right.kind === "literal" && typeof r === "string" && /[%_]/.test(r)) {
    const m = likeMatch(l, r);
    return m === null ? false : op === "~" ? m : !m;
  }
  return compareScalar(l, op, r, ctx.item === true);
}

/**
 * `~`, as SQLite's LIKE does it in list queries: an empty or missing needle
 * matches nothing, and ASCII letters match regardless of case (other letters
 * don't). Matching case-sensitively here let `title !~ "confidential"` hide
 * "CONFIDENTIAL plan" from lists but serve it by id and over realtime.
 */
function contains(haystack: unknown, needle: unknown): boolean | null {
  const n = needle === null || needle === undefined ? "" : String(needle);
  if (n === "") return false;
  const h = sqlFold(String(haystack ?? ""));
  const f = sqlFold(n);
  // A fold this engine can't be sure of decides nothing (see sqlFold).
  if (h === null || f === null) return null;
  return h.includes(f);
}

/** `~` and `!~` from contains(): an unsure fold is false for both. */
const like = (haystack: unknown, needle: unknown): boolean => contains(haystack, needle) === true;
const notLike = (haystack: unknown, needle: unknown): boolean => contains(haystack, needle) === false;

/**
 * SQLite's `x LIKE '%pattern%'`: `%` any run, `_` one character, ASCII
 * letters in either case. A wildcard match with one backtrack point (the
 * last `%`), so it runs in linear time; the regex it replaced backtracked
 * quadratically on a long value, and a create rule ran it on the body.
 */
function likeMatch(haystack: unknown, pattern: string): boolean | null {
  if (haystack === null || haystack === undefined || pattern === "") return false;
  // The list query binds the pattern as `%pattern%` (filter.ts likeParam).
  const fp = sqlFold(pattern);
  const fh = sqlFold(String(asStoredText(haystack)));
  if (fp === null || fh === null) return null;
  const p = ["%", ...fp, "%"];
  const h = [...fh];
  let i = 0, j = 0, star = -1, mark = 0;
  while (i < h.length) {
    if (j < p.length && (p[j] === "_" || (p[j] !== "%" && p[j] === h[i]))) { i++; j++; }
    else if (j < p.length && p[j] === "%") { star = j++; mark = i; }
    else if (star !== -1) { j = star + 1; i = ++mark; }
    else return false;
  }
  while (j < p.length && p[j] === "%") j++;
  return j === p.length;
}

function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/**
 * Case folding as the list query does it, or null when this engine can't
 * be sure of the database's answer (the comparison is then false).
 *
 * SQLite's LIKE and lower() fold ASCII letters only. Postgres's ILIKE is
 * lower(text) LIKE lower(pattern), and lower() follows the database's
 * locale: ASCII only under a C/POSIX ctype, one code point at a time under
 * other libc locales (so Σ is σ, never the final ς), and the full Unicode
 * mapping under ICU. The locale is read once per connection (pgFoldMode).
 */
function sqlFold(s: string): string | null {
  if (!onPostgres()) return asciiLower(s);
  return foldAs(pgFoldMode() ?? "unsure", s);
}

/**
 * How the connected Postgres database folds case:
 * - ascii:  C/POSIX ctype, or the builtin C locale: A-Z only.
 * - simple: other libc locales, builtin C.UTF-8: each code point by itself.
 * - full:   ICU, builtin PG_UNICODE_FAST: the full mapping (final sigma).
 * - turkic: ICU tr/az/lt, whose I/i rules this engine doesn't reproduce.
 * - unsure: anything else, or not read yet: ASCII letters fold, and any
 *           other letter that has a lowercase makes the fold unsure.
 */
type FoldMode = "ascii" | "simple" | "full" | "turkic" | "unsure";

/** Per driver, so a reopened or switched database (tests) is read again. */
const foldModes = new WeakMap<object, FoldMode>();
const foldLoads = new WeakMap<object, Promise<void>>();

const FOLD_MODE_SQL =
  `SELECT pg_encoding_to_char(d.encoding) AS enc, d.datctype AS ctype,` +
  ` to_jsonb(d) ->> 'datlocprovider' AS provider,` +
  ` COALESCE(to_jsonb(d) ->> 'datlocale', to_jsonb(d) ->> 'daticulocale') AS locale` +
  ` FROM pg_database d WHERE d.datname = current_database()`;

/** The open Postgres database's fold mode; null until it has been read (the read starts here). */
function pgFoldMode(): FoldMode | null {
  let driver: object;
  try { driver = getDriver(); } catch { return null; }
  const mode = foldModes.get(driver);
  if (mode) return mode;
  if (!foldLoads.has(driver)) void loadFoldMode(driver);
  return null;
}

function loadFoldMode(driver: object): Promise<void> {
  const running = foldLoads.get(driver);
  if (running) return running;
  const load = (async () => {
    try {
      const row = await (driver as typeof db).get<{ enc: string; ctype: string; provider: string | null; locale: string | null }>(FOLD_MODE_SQL);
      foldModes.set(driver, row ? foldModeOf(row) : "unsure");
    } catch {
      // Not read (the connection closing): stay unsure, and read again next time.
    } finally {
      foldLoads.delete(driver);
    }
  })();
  foldLoads.set(driver, load);
  return load;
}

/**
 * Read the open database's case-folding locale now, instead of on the first
 * rule that needs it (until then a non-ASCII fold is unsure and denies).
 * A no-op on SQLite.
 */
export async function primeRuleCaseFolding(): Promise<void> {
  if (!onPostgres()) return;
  let driver: object;
  try { driver = getDriver(); } catch { return; }
  if (!foldModes.has(driver)) await loadFoldMode(driver);
}

/** Test hook: forget what was read. */
export function _resetRuleCaseFolding(): void {
  try { const d = getDriver(); foldModes.delete(d); foldLoads.delete(d); } catch { /* no database */ }
}

function foldModeOf(row: { enc: string; ctype: string; provider: string | null; locale: string | null }): FoldMode {
  const provider = row.provider ?? "c";
  const isC = (v: string | null) => v === "C" || v === "POSIX";
  if (provider === "c" && isC(row.ctype)) return "ascii";
  if (provider === "b" && row.locale === "C") return "ascii";
  // A single-byte encoding folds by the libc tables byte by byte.
  if (row.enc !== "UTF8") return "unsure";
  if (provider === "c") return "simple";
  if (provider === "b") return row.locale === "C.UTF-8" ? "simple" : row.locale === "PG_UNICODE_FAST" ? "full" : "unsure";
  if (provider === "i") return /^(tr|az|lt)(?![a-z])/i.test(row.locale ?? "") ? "turkic" : "full";
  return "unsure";
}

/**
 * Letters whose lowercase every supported Postgres build agrees on with
 * this runtime: Latin, IPA, Greek, Cyrillic, Armenian, Latin Extended
 * Additional, Greek Extended, fullwidth Latin. A letter outside these
 * that has a lowercase makes the fold unsure (libc and ICU tables follow
 * different Unicode versions).
 */
const settledCase = (cp: number) =>
  cp < 0x590 || (cp >= 0x1e00 && cp < 0x2000) || (cp >= 0xff21 && cp <= 0xff3a);

const ASCII_ONLY = /^[\x00-\x7f]*$/;

function foldAs(mode: FoldMode, s: string): string | null {
  if (mode === "ascii") return asciiLower(s);
  if (mode === "turkic" && /[IJ]/.test(s)) return null;
  if (ASCII_ONLY.test(s)) return asciiLower(s);
  if (mode === "full") {
    for (const ch of s) {
      if (ch.toLowerCase() !== ch && !settledCase(ch.codePointAt(0)!)) return null;
    }
    return s.toLowerCase();
  }
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) { out += cp >= 65 && cp <= 90 ? String.fromCharCode(cp + 32) : ch; continue; }
    const lower = ch.toLowerCase();
    if (lower === ch) { out += ch; continue; }
    // simple: one code point to one (İ, whose JS lowercase is two, is unsure).
    if (mode !== "simple" || !settledCase(cp) || lower.length !== ch.length || lower.codePointAt(0)! < 0x80) return null;
    out += lower;
  }
  return out;
}

/**
 * Whether SQL reads this operand out of JSON text: a dotted path into a
 * column (`info.m`), or a key of the item inside `:any(...)`. On Postgres
 * that is jsonb's `#>>`, whose text is jsonb's, not the stored text.
 */
function readsJsonText(op: Operand, ctx: EvalContext): boolean {
  return op.kind === "field" && !op.modifier && (ctx.item === true || op.path.length > 0);
}

/**
 * A value SQL reads out of JSON (readsJsonText, or an element of a list),
 * as that SQL sees it under `op`. SQLite: the value as it is. Postgres:
 * - an object or array matches `~`/`!~` as jsonb's text of it (`{"a": 1}`,
 *   keys shortest first) and nothing else: compared with a value it is
 *   typed (jsonb_typeof), which an object or array never passes;
 * - a number matches `~`/`!~` as jsonb's text of the number as it was
 *   written ("1.50"), which a parsed number has lost: unsure.
 */
function asSqlJsonText(v: unknown, op: AnyCmpOp): unknown {
  if (!onPostgres() || v === null || typeof v !== "object" && typeof v !== "number") return v;
  if (v instanceof Date) return v;
  if (op !== "~" && op !== "!~") return typeof v === "number" ? v : UNSURE;
  return jsonbText(v) ?? UNSURE;
}

const utf8 = new TextEncoder();

/** jsonb's key order: shorter (in UTF-8 bytes) first, then byte by byte. */
function jsonbKeyOrder(a: string, b: string): number {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  if (x.length !== y.length) return x.length - y.length;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/**
 * `v` as Postgres prints jsonb: `", "` and `": "` separators, keys in
 * jsonb's order, strings escaped as JSON.stringify escapes them. Null when
 * it holds a number (its written form is lost) or anything not JSON.
 */
function jsonbText(v: unknown): string | null {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (const e of v) {
      const t = jsonbText(e);
      if (t === null) return null;
      parts.push(t);
    }
    return `[${parts.join(", ")}]`;
  }
  if (isItem(v) && !(v instanceof Date)) {
    const parts: string[] = [];
    for (const k of Object.keys(v).sort(jsonbKeyOrder)) {
      const t = jsonbText(v[k]);
      if (t === null) return null;
      parts.push(`${JSON.stringify(k)}: ${t}`);
    }
    return `{${parts.join(", ")}}`;
  }
  return null;
}

function onPostgres(): boolean {
  try { return db.name === "postgres"; } catch { return false; } // no database opened yet
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
  if (unknownValue(target)) return false;
  const items = itemPath(stripped);
  if (items) {
    // At least one item, every one an object whose value compares true (filter.ts everyItemCmp).
    const list = resolveOperand(items.list, ctx);
    if (Array.isArray(list) && list.length > 0
      && list.every((item) => isItem(item) && compareScalar(asSqlJsonText(walkPath(item, items.path), op), op, target, true))) return true;
  }
  const arr = resolveOperand(stripped, ctx);
  if (!Array.isArray(arr) || arr.length === 0) return false;

  if (ctx.item) return arr.every((item) => compareScalar(asSqlJsonText(item, op), op, target, true));
  return arr.every((element) => {
    // Elements are read out of the JSON text (json_each / jsonb_array_elements).
    const item = asSqlJsonText(element, op);
    if (item === UNSURE) return false;
    switch (op) {
      case "=":  return looseEq(item, target);
      case "!=": return !looseEq(item, target);
      case ">":  return cmp(item, target) > 0;
      case ">=": return cmp(item, target) >= 0;
      case "<":  return cmp(item, target) < 0;
      case "<=": return cmp(item, target) <= 0;
      case "~":  return like(item, target);
      case "!~": return notLike(item, target);
      default:   return false;
    }
  });
}

function evaluateArrayCmp(left: Operand, right: Operand, scalarOp: AnyCmpOp, ctx: EvalContext): boolean {
  // Array operand is the field side; scalar is the literal/auth side.
  const arrayOperand = left.kind === "field" || left.kind === "collection" ? left : right;
  const scalarOperand = arrayOperand === left ? right : left;

  const target = resolveOperand(scalarOperand, ctx);
  if (unknownValue(target)) return false;
  const items = itemPath(arrayOperand);
  if (items) {
    // Some item whose value compares true (filter.ts anyItemCmp).
    const list = resolveOperand(items.list, ctx);
    if (Array.isArray(list) && list.some((item) => isItem(item) && compareScalar(asSqlJsonText(walkPath(item, items.path), scalarOp), scalarOp, target, true))) return true;
  }
  const arr = resolveOperand(arrayOperand, ctx);
  if (!Array.isArray(arr)) return false;

  if (ctx.item) return arr.some((item) => compareScalar(asSqlJsonText(item, scalarOp), scalarOp, target, true));
  for (const element of arr) {
    // Elements are read out of the JSON text (json_each / jsonb_array_elements).
    const item = asSqlJsonText(element, scalarOp);
    if (item === UNSURE) continue;
    let match: boolean;
    switch (scalarOp) {
      case "=":  match = looseEq(item, target); break;
      case "!=": match = !looseEq(item, target); break;
      case ">":  match = cmp(item, target) > 0; break;
      case ">=": match = cmp(item, target) >= 0; break;
      case "<":  match = cmp(item, target) < 0; break;
      case "<=": match = cmp(item, target) <= 0; break;
      case "~":  match = like(item, target); break;
      case "!~": match = notLike(item, target); break;
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
  if (unknownValue(l) || unknownValue(r)) return false;
  // A whole JSON value (a json or group field, a multi-value list) is
  // compared in SQL as its stored JSON text. As a JS value it became
  // "[object Object]" or "a,b", so a rule decided differently by id, on
  // update and over realtime than in the list query.
  l = asStoredText(l);
  r = asStoredText(r);
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
    case "~":  return like(l, r);
    case "!~": return notLike(l, r);
    default:   return false;
  }
}

/** An object or array as the JSON text the column stores; anything else as is. */
function asStoredText(v: unknown): unknown {
  return v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v;
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
      // `:lower` here is a value filter.ts binds lowered by JS (applyModifierToValue).
      if (op.modifier === "lower") return typeof v === "string" ? (onPostgres() ? v.toLowerCase() : asciiLower(v)) : v;
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
    case "lower":
      if (typeof v === "string") return sqlFold(v) ?? UNSURE;
      // Postgres's LOWER() of a JSON path reads its jsonb text (see asSqlJsonText).
      return onPostgres() && v !== null && v !== undefined ? UNSURE : v;
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
  if (args.some(unknownValue)) return UNAUTH_SENTINEL;
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
  if (unknownValue(a) || unknownValue(b)) return false;
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

