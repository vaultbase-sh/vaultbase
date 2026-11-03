import type { AuthContext } from "./rules.ts";
import type { Expr, Operand, AnyCmpOp, FieldModifier, AuthProp } from "./expression.ts";
import { db, driverOpen } from "../db/index.ts";
import { SQLITE_DIALECT } from "../db/sqlite.ts";
import type { Dialect } from "../db/driver.ts";

/** The open driver's dialect; SQLite's when nothing is open (rules compiled offline, tests). */
function dialect(): Dialect {
  return driverOpen() ? db.dialect : SQLITE_DIALECT;
}
import { macroValue, requestMapHas, requestMapValue, stableEq, viaCompareError } from "./expression.ts";
import { cachedParseExpression as parseExpression } from "./filter-cache.ts";
import { quoteIdent } from "../db/ident.ts";

/** Parameterized SQL fragment + bound values. */
export interface CompiledSql {
  sql: string;
  params: unknown[];
}

/** Hardening: every identifier put into raw SQL must pass this regex. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export interface RequestContextLike {
  /** "default" / "oauth2" / "otp" / "password" / "realtime" / "protectedFile" */
  context?: string;
  /** Uppercase HTTP method. */
  method?: string;
  /**
   * Header map. Caller MUST pre-redact `authorization` and `cookie` before
   * passing through to the rule engine — those values never enter rule eval.
   */
  headers?: Readonly<Record<string, string>>;
  /** URL query parameters. */
  query?: Readonly<Record<string, string>>;
  /** Parsed request body for create/update. May be `null` on GET/DELETE. */
  body?: Readonly<Record<string, unknown>> | null;
  /**
   * For UPDATE rule eval, the prior record state — used by `:changed` modifier.
   */
  existing?: Readonly<Record<string, unknown>> | null;
}

/**
 * Optional schema lookup the SQL compiler uses to:
 *   1. Inherit a joined collection's `view_rule` on `@collection.*` references.
 *   2. Validate that the back-relation's reference field exists.
 *
 * Implementations return `null` when the collection isn't found, or
 * `{ viewRule: null }` for collections with public view access.
 */
export interface CollectionLookup {
  (collectionName: string): {
    viewRule: string | null;
    /**
     * The collection's list rule. A caller's own filter joins other
     * collections under list *and* view rule (see ParseFilterOpts.clientFilter);
     * omit it and only the view rule applies.
     */
    listRule?: string | null;
    /** The collection's create rule; with list and view, whether it is hidden. */
    createRule?: string | null;
    hasField: (name: string) => boolean;
    /**
     * Columns that must never be referenced from a filter — password hashes,
     * TOTP secrets, and any user-declared `password` field. Stripping them
     * from output is not enough on its own: a comparison against a hidden
     * column leaks it through the row count, one character at a time.
     */
    isPrivateField: (name: string) => boolean;
    /**
     * Whether the column exists and may be filtered on. Unknown and private
     * columns raise the *same* error, so the schema can't be probed by
     * comparing responses.
     */
    isFilterable: (name: string) => boolean;
  } | null;
}

/**
 * Raised for a reference to a column the caller may not filter on — whether
 * because it is hidden or because it does not exist. One message for both, so
 * a caller cannot tell them apart and map out the schema.
 */
export class PrivateFieldError extends Error {
  constructor(public readonly field: string) {
    super(`unknown field: ${field}`);
    this.name = "PrivateFieldError";
  }
}

/**
 * Compile a filter expression to a parameterized SQL fragment for `tableName`.
 * Returns null on empty / malformed input. Caller binds the SQL with the
 * returned params array, in order.
 */
export interface ParseFilterOpts {
  auth?: AuthContext | null;
  request?: RequestContextLike | null;
  lookup?: CollectionLookup;
  /** Privacy predicate for the host collection's own columns. */
  hostPrivateField?: (name: string) => boolean;
  /**
   * Allow-list of the host collection's filterable columns. Omitted means
   * "don't validate" — rule evaluation without a collection context still
   * compiles, and the private-field guard above applies regardless.
   */
  hostFilterable?: (name: string) => boolean;
  /**
   * Most `@collection.*` joins one expression may create (default 3). Each
   * distinct collection/alias is joined against every other, so a client
   * filter repeating aliases multiplied rows: three aliases over a 300-row
   * collection ran for seconds, four for minutes, on the main thread.
   */
  maxJoins?: number;
  /**
   * Most cross-collection operands (`@collection.*`, `_via_`) the expression
   * itself may use, joined or not (default unlimited). Two in one comparison
   * cost |host| × |A| × |B|: `@collection.tags.name != comments_via_post.body`
   * took ~30 s at 1000 rows each, on the main thread. A client filter gets 1,
   * which keeps it at most quadratic.
   */
  maxCrossRefs?: number;
  /**
   * The expression is a caller's own `?filter=`, not an admin-written rule.
   * Collections it reaches through `@collection.*` / `_via_` are then joined
   * under their list rule as well as their view rule: a filter is a yes/no
   * oracle over the joined rows, so view-by-id-only collections (invite
   * codes, a users list restricted to self) could otherwise be enumerated.
   */
  clientFilter?: boolean;
}

/** Default cap on `@collection.*` joins per expression (see ParseFilterOpts.maxJoins). */
export const MAX_COLLECTION_JOINS = 3;

export function parseFilter(
  expr: string,
  tableName: string,
  auth?: AuthContext | null | ParseFilterOpts,
  request?: RequestContextLike | null,
): CompiledSql | null {
  // Backwards-compat: legacy 4-arg signature used `auth, request`. New
  // call sites pass an opts object as the third argument.
  let opts: ParseFilterOpts = {};
  if (auth && typeof auth === "object" && !("id" in auth) && !("type" in auth)) {
    opts = auth as ParseFilterOpts;
  } else {
    opts = {
      auth: (auth as AuthContext | null | undefined) ?? null,
      request: request ?? null,
    };
  }
  const ast = parseExpression(expr);
  if (!ast) return null;
  return compileToSql(ast, tableName, opts);
}

export function compileToSql(
  ast: Expr,
  tableName: string,
  opts: ParseFilterOpts = {},
): CompiledSql {
  if (!IDENT_RE.test(tableName)) {
    throw new Error(`invalid table identifier: ${tableName}`);
  }
  const ctx: CompileCtx = {
    tableName,
    auth: opts.auth ?? null,
    request: opts.request ?? null,
    lookup: opts.lookup,
    hostPrivateField: opts.hostPrivateField ?? (() => false),
    hostFilterable: opts.hostFilterable,
    params: [],
    /** Track recursion depth on @collection.* / _via_ joins to bound work. */
    joinDepth: 0,
    hoist: null,
    aliasSeq: { n: 0 },
    itemSeq: { n: 0 },
    maxJoins: opts.maxJoins ?? MAX_COLLECTION_JOINS,
    crossRefs: { n: 0, max: opts.maxCrossRefs ?? Number.POSITIVE_INFINITY },
    clientFilter: opts.clientFilter === true && opts.auth?.type !== "admin",
  };
  const sql = compileScoped(ast, ctx);
  return { sql, params: ctx.params };
}

interface CompileCtx {
  tableName: string;
  auth: AuthContext | null;
  request: RequestContextLike | null;
  lookup: CollectionLookup | undefined;
  params: unknown[];
  joinDepth: number;
  /** Privacy predicate for whichever table `tableName` currently points at. */
  hostPrivateField: (name: string) => boolean;
  /** Allow-list for the same table, or undefined to skip validation. */
  hostFilterable: ((name: string) => boolean) | undefined;
  /** Joined `@collection.*` rows for the expression being compiled (see compileScoped). */
  hoist: HoistScope | null;
  /** Shared counter for join aliases, unique across nested scopes. */
  aliasSeq: { n: number };
  /** Counter for the aliases of list-item scans (`:any`, `x.f ?= v`); not a join, so not capped by maxJoins. */
  itemSeq: { n: number };
  /**
   * Inside `items:any(...)`: the JSON of the item being tested. Field
   * operands then read that item's keys instead of the table's columns.
   */
  element?: string | undefined;
  /** Cap on aliasSeq.n for this compile. */
  maxJoins: number;
  /**
   * Cross-collection operands charged to this compile, shared with every
   * derived context — inherited view rules included, so a client filter's
   * one reference can't pull in more through the referenced collection.
   */
  crossRefs: { n: number; max: number };
  /** Join referenced collections under their list rule too (ParseFilterOpts.clientFilter). */
  clientFilter: boolean;
}

function chargeCrossRef(ctx: CompileCtx): void {
  if (++ctx.crossRefs.n > ctx.crossRefs.max) {
    throw new Error(`too many @collection / _via_ references in one filter (at most ${ctx.crossRefs.max})`);
  }
}

/**
 * Context for compiling an inherited view rule. Its cross-collection
 * operands count against the caller's budget too: each one runs once per
 * joined row, so a client filter's single `@collection.X` over an X whose
 * view rule uses `_via_` or another `@collection` was cubic again.
 */
function guardCtx(ctx: CompileCtx, overrides: Partial<CompileCtx>): CompileCtx {
  return { ...ctx, ...overrides };
}

interface HoistJoin { alias: string; table: string; on: string; onParams: unknown[] }
interface HoistScope { joins: HoistJoin[]; byKey: Map<string, HoistJoin> }

/**
 * Compile an expression in which every `@collection.X` reference (per alias)
 * is bound to one row of X: the expression becomes
 * `EXISTS (SELECT 1 FROM (SELECT 1) LEFT JOIN X AS j ON <X's view rule> … WHERE <expr>)`.
 * So `@collection.members.grp = grp && @collection.members.user = @request.auth.id`
 * needs one membership row matching both, and a LEFT JOIN keeps
 * `public = true || @collection.…` true when X has no visible rows.
 */
function compileScoped(ast: Expr, ctx: CompileCtx): string {
  const scope: HoistScope = { joins: [], byKey: new Map() };
  const exprParams: unknown[] = [];
  const sub: CompileCtx = { ...ctx, params: exprParams, hoist: scope };
  const sql = compileNode(ast, sub);
  if (scope.joins.length === 0) {
    ctx.params.push(...exprParams);
    return sql;
  }
  for (const j of scope.joins) ctx.params.push(...j.onParams);
  ctx.params.push(...exprParams);
  const joins = scope.joins.map((j) => `LEFT JOIN ${quoteIdent(j.table)} AS ${j.alias} ON ${j.on}`).join(" ");
  return `EXISTS (SELECT 1 FROM (SELECT 1) AS _vb_one ${joins} WHERE ${sql})`;
}

const MAX_JOIN_DEPTH = 4;

function compileNode(ast: Expr, ctx: CompileCtx): string {
  if (ast.kind === "any") return compileAny(ast, ctx);
  if (ast.kind === "and") {
    return `(${compileNode(ast.left, ctx)} AND ${compileNode(ast.right, ctx)})`;
  }
  if (ast.kind === "or") {
    return `(${compileNode(ast.left, ctx)} OR ${compileNode(ast.right, ctx)})`;
  }

  const op = ast.op;
  // A back-relation compared without `?`, `:each`, `:length` or `~`.
  const viaRefused = viaCompareError(ast);
  if (viaRefused) throw new Error(viaRefused);

  // NULL-aware shortcuts for `=` / `!=` only
  if (op === "=" || op === "!=") {
    if (ast.right.kind === "literal" && ast.right.value === null) {
      return `${compileOperand(ast.left, ctx)} IS ${op === "=" ? "" : "NOT "}NULL`;
    }
    if (ast.left.kind === "literal" && ast.left.value === null) {
      return `${compileOperand(ast.right, ctx)} IS ${op === "=" ? "" : "NOT "}NULL`;
    }
  }

  // `:isset` modifier — only valid on requestMap operands. Resolves to a
  // literal-bound boolean at compile time so the SQL is just `? = ?`.
  if (
    (ast.left.kind === "requestMap" && ast.left.modifier === "isset") ||
    (ast.right.kind === "requestMap" && ast.right.modifier === "isset")
  ) {
    const lhs = ast.left.kind === "requestMap" && ast.left.modifier === "isset"
      ? requestIsSet(ast.left, ctx) : compileOperand(ast.left, ctx);
    const rhs = ast.right.kind === "requestMap" && ast.right.modifier === "isset"
      ? requestIsSet(ast.right, ctx) : compileOperand(ast.right, ctx);
    return `(${lhs}) ${op} (${rhs})`;
  }

  // `:changed` modifier — only valid on @request.body.* fields, evaluated at
  // compile time against `request.body` vs `request.existing`.
  if (
    (ast.left.kind === "requestMap" && ast.left.mapKind === "body" && ast.left.modifier === "changed") ||
    (ast.right.kind === "requestMap" && ast.right.mapKind === "body" && ast.right.modifier === "changed")
  ) {
    const lhs = ast.left.kind === "requestMap" && ast.left.modifier === "changed"
      ? bodyChanged(ast.left, ctx) : compileOperand(ast.left, ctx);
    const rhs = ast.right.kind === "requestMap" && ast.right.modifier === "changed"
      ? bodyChanged(ast.right, ctx) : compileOperand(ast.right, ctx);
    return `(${lhs}) ${op} (${rhs})`;
  }

  // A back-relation with a `?` operator or `:each`: matched row by row.
  const viaOnLeft = ast.left.kind === "viaRelation";
  const via = viaOnLeft ? ast.left : ast.right.kind === "viaRelation" ? ast.right : null;
  if (via?.kind === "viaRelation" && (op.startsWith("?") || via.modifier === "each")) {
    return compileViaMatch(via, viaOnLeft ? ast.right : ast.left, op, viaOnLeft, ctx);
  }

  // Array-prefix operators (`?=` / `?~` / etc.) — match-any-element semantics
  // over a JSON-array column on the same table.
  if (op.startsWith("?")) {
    const scalar = op.slice(1) as AnyCmpOp;
    return compileArrayCmp(ast.left, ast.right, scalar, ctx);
  }

  // `:each` modifier on a field operand — match-EVERY-element semantics.
  // Compiles to NOT EXISTS (... WHERE NOT (value <op> ?)).
  if (
    (ast.left.kind === "field" || ast.left.kind === "collection") && ast.left.modifier === "each" ||
    (ast.right.kind === "field" || ast.right.kind === "collection") && ast.right.modifier === "each"
  ) {
    return compileEach(ast.left, ast.right, op, ctx);
  }

  // `@collection.X.f != v` / `!~ v` (either side): no row of X the caller
  // may view matches. Bound to the joined row instead, it meant "some row
  // differs" — and a ban list with two entries banned nobody.
  // Modifiers (`:lower`, `:length`) count too; `:each` was handled above.
  const leftColl = ast.left.kind === "collection";
  const rightColl = ast.right.kind === "collection";
  if (leftColl !== rightColl && (op === "!=" || op === "!~")) {
    const coll = (leftColl ? ast.left : ast.right) as Extract<Operand, { kind: "collection" }>;
    const other = leftColl ? ast.right : ast.left;
    return compileCollectionRef(coll, ctx, (inner) => {
      if (op === "!~") {
        if (leftColl) return likeSql(inner, "~", other, ctx);
        return dialect().like(compileOperand(other, ctx), sqlLikePattern(inner));
      }
      const otherSql = compileOperand(other, ctx);
      return leftColl ? `${inner} = ${otherSql}` : `${otherSql} = ${inner}`;
    }, true);
  }

  // Standard scalar comparison
  if (op === "~" || op === "!~") {
    const left = compileOperand(ast.left, ctx);
    return likeSql(left, op, ast.right, ctx);
  }

  return typedCmp(compiled(ast.left, ctx), op, compiled(ast.right, ctx), ctx, !!ctx.element);
}

/**
 * `items:any(<where>)`: an element of the list that is an object for which
 * `where` holds, `where`'s fields read from the element.
 */
function compileAny(ast: Extract<Expr, { kind: "any" }>, ctx: CompileCtx): string {
  if (ctx.element) throw new Error(":any(...) can't be used inside :any(...)");
  const listSql = compileFieldRef(ast.target, ctx);
  const d = dialect();
  const alias = `vb_item${++ctx.itemSeq.n}`;
  const where = compileNode(ast.where, { ...ctx, element: d.items.value(alias) });
  return `EXISTS (SELECT 1 FROM ${d.items.from(listSql, alias)} WHERE ${onItem(alias, where)})`;
}

/**
 * `cond` for the element in row `alias` when it is an object, else NULL.
 * A CASE, not AND: SQLite's json_extract fails on a string element, and
 * AND doesn't promise to test the type first.
 */
function onItem(alias: string, cond: string): string {
  return `(CASE WHEN ${dialect().items.isObject(alias)} THEN (${cond}) END)`;
}

/**
 * `x.f` where `x` may hold a list of items: the field `x` and the path read
 * in each item. `x.f ?= v` and `x.f:each = v` then also look at `f` in every
 * item of `x`, besides the list at `x.f` (a JSON object's array). The two
 * can't both apply to one value: a JSON path reads nothing from a list.
 */
function itemPath(op: Operand): { list: Extract<Operand, { kind: "field" }>; path: string[] } | null {
  if (op.kind !== "field" || op.path.length === 0) return null;
  return { list: { kind: "field", name: op.name, path: [] }, path: op.path };
}

/** `<item>.path <op> scalar` for the item in row `alias`; binds into ctx. */
function itemCmp(alias: string, path: string[], op: AnyCmpOp, scalar: Operand, ctx: CompileCtx): string {
  const d = dialect();
  let left = d.items.value(alias);
  for (const seg of path) {
    if (!IDENT_RE.test(seg)) throw new Error(`invalid field path segment: ${seg}`);
    left = d.jsonExtract(left, `$.${seg}`);
  }
  if (op === "~" || op === "!~") return likeSql(left, op, scalar, ctx);
  return typedCmp({ sql: left, params: [] }, op, compiled(scalar, ctx), ctx, true);
}

/** Some item of `items.list` whose `items.path` compares true. */
function anyItemCmp(items: { list: Extract<Operand, { kind: "field" }>; path: string[] }, op: AnyCmpOp, scalar: Operand, ctx: CompileCtx): string {
  const d = dialect();
  const listSql = compileFieldRef(items.list, ctx);
  const alias = `vb_item${++ctx.itemSeq.n}`;
  const cond = itemCmp(alias, items.path, op, scalar, ctx);
  return `EXISTS (SELECT 1 FROM ${d.items.from(listSql, alias)} WHERE ${onItem(alias, cond)})`;
}

/**
 * At least one item, and every item an object whose `items.path` compares
 * true. A missing value fails (`IS NOT TRUE`), as it does in rules.ts.
 */
function everyItemCmp(items: { list: Extract<Operand, { kind: "field" }>; path: string[] }, op: AnyCmpOp, scalar: Operand, ctx: CompileCtx): string {
  const d = dialect();
  const listSql = compileFieldRef(items.list, ctx);
  const alias = `vb_item${++ctx.itemSeq.n}`;
  const cond = itemCmp(alias, items.path, op, scalar, ctx);
  return `(${d.items.length(listSql)} > 0 AND NOT EXISTS (SELECT 1 FROM ${d.items.from(listSql, alias)} WHERE ${onItem(alias, cond)} IS NOT TRUE))`;
}

/** An operand compiled on its own: its SQL and the values it binds. */
interface Compiled { sql: string; params: unknown[] }

function compiled(op: Operand, ctx: CompileCtx): Compiled {
  const saved = ctx.params;
  const params: unknown[] = [];
  ctx.params = params;
  try {
    return { sql: compileOperand(op, ctx), params };
  } finally {
    ctx.params = saved;
  }
}

/**
 * `a op b`, binding a's values then b's. On Postgres (Dialect.typedCompare)
 * a single bound value is lined up with the expression it meets, so the
 * answer is SQLite's:
 * - against a JSON path, the JSON value compares by the bound value's type
 *   (a number numerically, true/false as 1/0, a string as text), and a JSON
 *   value of another type matches nothing; `#>>` alone compared text, so
 *   `meta.level < 5` held for 10 and `meta.banned != true` for a banned user;
 * - against anything else (a column, a modifier, a function), a number is
 *   bound untyped, as text, so the server casts it to that expression's type,
 *   as SQLite's affinity does: `sku = 123` on a text field matches "123"
 *   instead of failing with `text = integer`.
 */
function typedCmp(a: Compiled, op: string, b: Compiled, ctx: CompileCtx, item = false): string {
  const d = dialect();
  if (item && !isBound(a) && !isBound(b)) {
    // Two values of the item: typed against each other.
    const pair = d.itemPair(a.sql, op, b.sql);
    if (pair) { ctx.params.push(...a.params, ...b.params); return pair; }
  }
  const t = d.typedCompare;
  const loose = t ? looseNumberCmp(a, op, b, t) ?? looseNumberCmp(b, flipOp(op), a, t) : null;
  if (loose) { ctx.params.push(...loose.params); return loose.sql; }
  if (t) [a, b] = [lineUp(a, b, t, item), lineUp(b, a, t, item)];
  else if (item && d.itemCompare) [a, b] = [lineUpItem(a, b, d.itemCompare), lineUpItem(b, a, d.itemCompare)];
  ctx.params.push(...a.params, ...b.params);
  return `${a.sql} ${op} ${b.sql}`;
}

/**
 * `expr op number` for a number that isn't a whole one in bigint's range
 * (1.5, 1e20), against an expression that isn't a JSON path. Bound
 * untyped, as lineUp does, the server read it as the expression's type and
 * failed the query on an integer column (`created > 1.5`, a date, a bool,
 * `:length`). Compared by what the expression holds instead: as a number,
 * or as text (`sku = 1.5` on a text field, as before). The expression is
 * read once.
 */
function looseNumberCmp(expr: Compiled, op: string, value: Compiled, t: NonNullable<Dialect["typedCompare"]>): Compiled | null {
  if (!isBound(value) || isBound(expr) || expr.sql === "?" || t.jsonb(expr.sql)) return null;
  const v = value.params[0];
  if (typeof v !== "number" || Number.isSafeInteger(v) || !Number.isFinite(v)) return null;
  return {
    sql: `(SELECT CASE jsonb_typeof(_vb_j) WHEN 'number' THEN (_vb_j)::numeric ${op} CAST(? AS NUMERIC) WHEN 'string' THEN (_vb_j #>> '{}') ${op} ? END FROM (SELECT to_jsonb(${expr.sql}) AS _vb_j) AS _vb_n)`,
    // In the order the placeholders appear: both values come before the
    // expression, which sits in the FROM at the end.
    params: [String(v), String(v), ...expr.params],
  };
}

/** `a op b` as `b flipOp(op) a`. */
function flipOp(op: string): string {
  switch (op) {
    case "<": return ">";
    case ">": return "<";
    case "<=": return ">=";
    case ">=": return "<=";
    default: return op;
  }
}

/** SQLite, for an item's value: a JSON path met by a bound value, typed as that value (Dialect.itemCompare). */
function lineUpItem(side: Compiled, other: Compiled, as: NonNullable<Dialect["itemCompare"]>): Compiled {
  if (isBound(side) || !isBound(other)) return side;
  const kind = boundKind(other.params[0]);
  const typed = kind ? as(side.sql, kind) : null;
  return typed ? { sql: typed, params: side.params } : side;
}

const isBound = (c: Compiled): boolean => c.sql === "?" && c.params.length === 1;

/** `side` adjusted for being compared with `other` (see typedCmp). */
function lineUp(side: Compiled, other: Compiled, t: NonNullable<Dialect["typedCompare"]>, item = false): Compiled {
  if (isBound(side)) {
    // Untyped against an expression the server types; a JSON path is typed
    // from this value instead (the other branch), and two bound values keep
    // their own types.
    const v = side.params[0];
    if (other.sql === "?" || t.jsonb(other.sql) || (typeof v !== "number" && typeof v !== "boolean")) return side;
    return { sql: "?", params: [String(Number(v))] };
  }
  if (!isBound(other)) return side;
  const kind = boundKind(other.params[0]);
  const j = kind ? t.jsonb(side.sql) : null;
  if (!j || !kind) return side;
  return { sql: item && kind === "text" ? `${t.as(j, kind)} ${t.itemTextOrder}` : t.as(j, kind), params: side.params };
}

function boundKind(v: unknown): "number" | "text" | null {
  if (typeof v === "number" || typeof v === "boolean") return "number";
  if (typeof v === "string") return "text";
  return null;
}

/** `field:each <op> value` — match every array element. */
function compileEach(left: Operand, right: Operand, op: AnyCmpOp, ctx: CompileCtx): string {
  const arrayOperand = ((left.kind === "field" || left.kind === "collection") && left.modifier === "each")
    ? left : right;
  const scalarOperand = arrayOperand === left ? right : left;
  if (arrayOperand.kind !== "field" && arrayOperand.kind !== "collection") {
    throw new Error(":each requires a field operand");
  }

  // Strip the modifier when emitting the field reference inside the subquery.
  const stripped: Operand = arrayOperand.kind === "field"
    ? { kind: "field", name: arrayOperand.name, path: arrayOperand.path }
    : (arrayOperand.alias
        ? { kind: "collection", collection: arrayOperand.collection, alias: arrayOperand.alias, path: arrayOperand.path }
        : { kind: "collection", collection: arrayOperand.collection, path: arrayOperand.path });

  const arraySql = compileOperand(stripped, ctx);
  let cmp: string;
  let from = dialect().jsonEach(arraySql);
  if (op === "~" || op === "!~") {
    cmp = likeSql("value", op, scalarOperand, ctx);
  } else {
    ({ cmp, from } = elementCmp(arraySql, op, scalarOperand, ctx));
  }
  const d = dialect();
  // Inside an item a value that doesn't compare (a missing or mistyped one)
  // fails "every", as rules.ts compares items; elsewhere NOT keeps the old answer.
  const fails = ctx.element ? `(${cmp}) IS NOT TRUE` : `NOT (${cmp})`;
  const each = `(${d.jsonArrayLength(arraySql)} > 0 AND NOT EXISTS (SELECT 1 FROM ${from} WHERE ${fails}))`;
  const items = itemPath(arrayOperand);
  return items ? `(${each} OR ${everyItemCmp(items, op, scalarOperand, ctx)})` : each;
}

/** `column ARRAY-OP value` — wraps in `EXISTS (... json_each ...)`. */
function compileArrayCmp(
  left: Operand,
  right: Operand,
  scalarOp: AnyCmpOp,
  ctx: CompileCtx,
): string {
  // The array side MUST be a field operand (collection / table column).
  // The other side is a scalar value (literal / auth / etc.).
  const arrayOperand = left.kind === "field" || left.kind === "collection" ? left : right;
  const scalarOperand = arrayOperand === left ? right : left;

  if (arrayOperand.kind !== "field" && arrayOperand.kind !== "collection") {
    throw new Error("array-prefix operator requires a field operand");
  }

  const arraySql = compileOperand(arrayOperand, ctx);
  // Render the scalar side into a fresh sub-context so its bindings are
  // ordered relative to the EXISTS subquery body.
  const inner: unknown[] = [];
  const innerCtx: CompileCtx = { ...ctx, params: inner };
  let cmp: string;
  let from = dialect().jsonEach(arraySql);
  if (scalarOp === "~" || scalarOp === "!~") {
    cmp = likeSql("value", scalarOp, scalarOperand, innerCtx);
  } else {
    ({ cmp, from } = elementCmp(arraySql, scalarOp, scalarOperand, innerCtx));
  }
  // Splice inner params into outer in the right position.
  ctx.params.push(...inner);
  const exists = `EXISTS (SELECT 1 FROM ${from} WHERE ${cmp})`;
  const items = itemPath(arrayOperand);
  return items ? `(${exists} OR ${anyItemCmp(items, scalarOp, scalarOperand, ctx)})` : exists;
}

/**
 * `value op scalar` over the elements of `arraySql`, and the row source to
 * read them from. On Postgres a bound value picks how the elements compare,
 * as in typedCmp: the elements are read as jsonb and taken as numbers or as
 * text (elements of another type match nothing); otherwise as text, with a
 * bound number untyped so it is read as text too.
 */
function elementCmp(arraySql: string, op: AnyCmpOp, scalar: Operand, ctx: CompileCtx): { cmp: string; from: string } {
  const d = dialect();
  const right = compiled(scalar, ctx);
  const t = d.typedCompare;
  if (t && isBound(right)) {
    const kind = boundKind(right.params[0]);
    if (kind) {
      const v = right.params[0];
      ctx.params.push(typeof v === "boolean" ? Number(v) : v);
      const value = ctx.element && kind === "text" ? `${t.as("value", kind)} ${t.itemTextOrder}` : t.as("value", kind);
      return { cmp: `${value} ${op} ?`, from: t.eachJsonb(arraySql) };
    }
  }
  // A list inside an item, on SQLite: typed as the bound value too (Dialect.itemCompare).
  if (!t && ctx.element && d.itemElement && isBound(right)) {
    const kind = boundKind(right.params[0]);
    if (kind) {
      const v = right.params[0];
      ctx.params.push(typeof v === "boolean" ? Number(v) : v);
      return { cmp: `${d.itemElement(kind)} ${op} ?`, from: d.jsonEach(arraySql) };
    }
  }
  return { cmp: typedCmp({ sql: "value", params: [] }, op, right, ctx), from: d.jsonEach(arraySql) };
}

/** Whether this operand reads JSON: a JSON path, or a value of the item inside :any(...). */
function readsJson(op: Operand, ctx: CompileCtx): boolean {
  // A modifier (`:length`, `:lower`) makes it a number or text of SQL's own.
  if ((op.kind === "field" || op.kind === "collection") && op.modifier) return false;
  return isJsonPath(op) || (!!ctx.element && op.kind === "field");
}

/**
 * An item's value as a number for arithmetic: a JSON number, or a boolean
 * as 1/0; NULL for text or anything else, as rules.ts reads it.
 */
function itemNumber(sql: string): string {
  const d = dialect();
  const typed = d.itemCompare?.(sql, "number");
  if (typed) return typed;
  const j = d.typedCompare?.jsonb(sql);
  return j ? `CAST(${d.typedCompare!.as(j, "number")} AS DOUBLE PRECISION)` : jsonNumber(sql);
}

/**
 * A value read from JSON as a number for arithmetic. Postgres reads it as
 * text, and casting text that isn't a number fails the query: NULL instead.
 */
function jsonNumber(sql: string): string {
  return dialect().name === "sqlite"
    ? `CAST(${sql} AS DOUBLE PRECISION)`
    : `(CASE WHEN pg_input_is_valid(${sql}, 'double precision') THEN CAST(${sql} AS DOUBLE PRECISION) END)`;
}

/** Whether this operand reads a JSON path. */
function isJsonPath(op: Operand): boolean {
  return (op.kind === "field" || op.kind === "collection") && op.path.length > (op.kind === "field" ? 0 : 1);
}

function compileOperand(op: Operand, ctx: CompileCtx): string {
  switch (op.kind) {
    case "literal": {
      ctx.params.push(coerceLiteral(op.value));
      return "?";
    }
    case "auth": {
      ctx.params.push(authValue(ctx.auth, op.prop));
      return "?";
    }
    case "request": {
      const v = ctx.request?.[op.prop] ?? null;
      ctx.params.push(v);
      return "?";
    }
    case "requestMap": {
      const map = ctx.request?.[op.mapKind];
      const raw = requestMapValue(map, op.mapKind, op.key);
      const v = applyModifierToValue(raw, op.modifier);
      ctx.params.push(v);
      return "?";
    }
    case "macro": {
      ctx.params.push(macroValue(op.name));
      return "?";
    }
    case "func": {
      return compileFunc(op, ctx);
    }
    case "field": {
      return compileFieldRef(op, ctx);
    }
    case "collection": {
      return compileCollectionRef(op, ctx);
    }
    case "viaRelation": {
      return compileViaRelationRef(op, ctx);
    }
  }
}

/**
 * Records come back with `created` and `updated`, and `sort` takes those
 * names; the columns are `created_at` and `updated_at`. A filter takes both,
 * unless the table has a real column by the short name (a view can).
 */
function columnFor(name: string, ctx: CompileCtx): string {
  const alias = name === "created" ? "created_at" : name === "updated" ? "updated_at" : null;
  if (!alias) return name;
  return ctx.hostFilterable?.(name) ? name : alias;
}

function compileFieldRef(op: Extract<Operand, { kind: "field" }>, ctx: CompileCtx): string {
  if (!IDENT_RE.test(op.name)) throw new Error(`invalid field name: ${op.name}`);
  if (ctx.element) {
    // A key of the item `:any(...)` is testing.
    let expr = dialect().jsonExtract(ctx.element, `$.${op.name}`);
    for (const seg of op.path) {
      if (!IDENT_RE.test(seg)) throw new Error(`invalid field path segment: ${seg}`);
      expr = dialect().jsonExtract(expr, `$.${seg}`);
    }
    return applyModifierToSql(expr, op.modifier);
  }
  op = { ...op, name: columnFor(op.name, ctx) };
  // Private first, then existence — both raise the same error, so the order
  // only matters for readability.
  if (ctx.hostPrivateField(op.name)) throw new PrivateFieldError(op.name);
  if (ctx.hostFilterable && !ctx.hostFilterable(op.name)) throw new PrivateFieldError(op.name);
  const baseCol = `${quoteIdent(ctx.tableName)}.${quoteIdent(op.name)}`;
  if (op.path.length === 0 && !op.modifier) return baseCol;

  // Dotted path → JSON extraction
  let expr = baseCol;
  for (const seg of op.path) {
    if (!IDENT_RE.test(seg)) throw new Error(`invalid field path segment: ${seg}`);
    expr = dialect().jsonExtract(expr, `$.${seg}`);
  }
  return applyModifierToSql(expr, op.modifier);
}

/**
 * `@collection.X.f`. Normally a column of the row of X joined for this
 * expression (see compileScoped), so every reference to X shares one row.
 * With `exists`, a standalone `EXISTS (SELECT 1 FROM X WHERE <view rule> AND
 * exists(f))`, used for negated comparisons. It used to be
 * `(SELECT f FROM X LIMIT 1)`, one arbitrary row: a members list only worked
 * for its first member, a ban list only banned its first entry.
 */
/**
 * Which rows of `collection` (joined as `alias`) the caller may see: its
 * view rule compiled against the alias, `1=0` when admin-only (or no lookup
 * to check it with) for non-admins.
 */
function collectionRowGuard(collection: string, alias: string, ctx: CompileCtx): string {
  if (!ctx.lookup) return ctx.auth?.type === "admin" ? dialect().always : dialect().never;
  const meta = ctx.lookup(collection);
  if (!meta) throw new Error(`unknown collection in @collection.*: ${collection}`);
  return joinedCollectionGuard(meta, collection, alias, ctx) ?? dialect().always;
}

/**
 * The rules a joined collection's rows must pass: its view rule, plus its
 * list rule when compiling a caller's own filter. Returns null when
 * unrestricted, `1=0` when admin-only (or unparseable) for a non-admin.
 * The rules are compiled against `table` and are admin-written, so they get
 * the normal (non-client) compile.
 */
function joinedCollectionGuard(
  meta: NonNullable<ReturnType<CollectionLookup>>,
  collection: string,
  table: string,
  ctx: CompileCtx,
): string | null {
  const rules: Array<string | null> = [meta.viewRule];
  if (ctx.clientFilter && meta.listRule !== undefined) rules.push(meta.listRule);
  const parts: string[] = [];
  // Held back until every rule compiled: one that denies outright returns
  // a clause without them, and a rule compiled before it had left its
  // values in the statement, one more than its placeholders.
  const params: unknown[] = [];
  for (const rule of rules) {
    if (rule === null) continue;
    if (rule === "") {
      if (ctx.auth?.type === "admin") continue;
      return dialect().never;
    }
    const innerAst = parseExpression(rule);
    if (!innerAst) return dialect().never;
    const innerCtx: CompileCtx = guardCtx(ctx, {
      tableName: table,
      hostPrivateField: (n) => meta.isPrivateField(n),
      hostFilterable: (n) => meta.isFilterable(n),
      clientFilter: false,
      params,
    });
    parts.push(compileScoped(innerAst, innerCtx));
    ctx.joinDepth = innerCtx.joinDepth;
  }
  ctx.params.push(...params);
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : parts.map((p) => `(${p})`).join(" AND ");
}

/**
 * The collection a caller's own filter reaches with `@collection.*` or
 * `_via_`. A hidden one (list, view and create rules all admin-only, as the
 * records API and public OpenAPI document treat it) raises the same error
 * as one that doesn't exist, before any of its fields is checked: an empty
 * page for it against a 400 for a made-up name confirmed admin-only
 * collections and their fields. Admins and rules get the real lookup and
 * its specific errors.
 */
function refTarget(collection: string, ctx: CompileCtx, via: boolean): ReturnType<CollectionLookup> {
  const meta = ctx.lookup?.(collection) ?? null;
  if (!ctx.clientFilter || !ctx.lookup) return meta;
  const adminOnly = (r: string | null | undefined) => typeof r === "string" && r.trim() === "";
  // A lookup that doesn't report the create rule is judged on the other two.
  const hidden = meta && adminOnly(meta.viewRule) && adminOnly(meta.listRule)
    && (meta.createRule === undefined || adminOnly(meta.createRule));
  if (!meta || hidden) {
    throw new Error(via ? `unknown collection in _via_: ${collection}` : `unknown collection in @collection.*: ${collection}`);
  }
  return meta;
}

/**
 * `created` / `updated` on another collection (`@collection.x.created`,
 * `x_via_y.created`) as on the host: the columns are `created_at` and
 * `updated_at`, unless that table has a real column by the short name.
 */
function systemAlias(name: string, meta: { isFilterable(n: string): boolean } | null): string {
  if (name !== "created" && name !== "updated") return name;
  return meta?.isFilterable(name) ? name : `${name}_at`;
}

function compileCollectionRef(
  op: Extract<Operand, { kind: "collection" }>,
  ctx: CompileCtx,
  exists?: (inner: string) => string,
  negate = false,
): string {
  if (!IDENT_RE.test(op.collection)) throw new Error(`invalid collection: ${op.collection}`);
  for (const p of op.path) if (!IDENT_RE.test(p)) throw new Error(`invalid path: ${p}`);
  if (++ctx.joinDepth > MAX_JOIN_DEPTH) {
    throw new Error("@collection.* join depth exceeded");
  }
  try {
    const targetTable = `vb_${op.collection}`;
    if (!IDENT_RE.test(targetTable)) throw new Error(`invalid table: ${targetTable}`);

    const head = systemAlias(op.path[0]!, refTarget(op.collection, ctx, false));
    if (!exists && ctx.hoist) {
      const targetMeta0 = ctx.lookup?.(op.collection);
      if (targetMeta0 && (targetMeta0.isPrivateField(head) || !targetMeta0.isFilterable(head))) {
        throw new PrivateFieldError(head);
      }
      const key = `${op.collection}\u0000${op.alias ?? ""}`;
      let join = ctx.hoist.byKey.get(key);
      if (!join) {
        if (ctx.aliasSeq.n >= ctx.maxJoins) {
          throw new Error(`too many @collection references in one expression (at most ${ctx.maxJoins})`);
        }
        chargeCrossRef(ctx);
        const alias = `_vbj${++ctx.aliasSeq.n}`;
        const onParams: unknown[] = [];
        const on = collectionRowGuard(op.collection, alias, { ...ctx, params: onParams });
        join = { alias, table: targetTable, on, onParams };
        ctx.hoist.byKey.set(key, join);
        ctx.hoist.joins.push(join);
      }
      let col = `${join.alias}.${quoteIdent(head)}`;
      for (let i = 1; i < op.path.length; i++) col = dialect().jsonExtract(col, `$.${op.path[i]}`);
      return applyModifierToSql(col, op.modifier);
    }
    // `@collection.users.password_hash` is the same oracle as a local ref.
    const targetMeta = ctx.lookup?.(op.collection);
    if (targetMeta && (targetMeta.isPrivateField(head) || !targetMeta.isFilterable(head))) {
      throw new PrivateFieldError(head);
    }
    let inner = `${quoteIdent(targetTable)}.${quoteIdent(head)}`;
    for (let i = 1; i < op.path.length; i++) {
      inner = dialect().jsonExtract(inner, `$.${op.path[i]}`);
    }

    if (negate) {
      chargeCrossRef(ctx);
      // "No row matches" can only be shown over rows the caller may see.
      // For a non-admin, any view rule on X may hide rows (an admin-only ban
      // list, other users' entries), so the negation is false — decided
      // from the rule alone. Counting only visible rows let every banned user
      // pass; probing for hidden rows leaked whether any existed.
      const meta = ctx.lookup?.(op.collection);
      if (ctx.lookup && !meta) throw new Error(`unknown collection in @collection.*: ${op.collection}`);
      if (ctx.auth?.type !== "admin" && !(meta && meta.viewRule === null)) {
        // Still refuse private fields, as every other path does.
        if (meta && (meta.isPrivateField(head) || !meta.isFilterable(head))) throw new PrivateFieldError(head);
        return dialect().never;
      }
    }

    // Inherit the joined collection's view_rule. Anonymous-rule-eval (no
    // lookup provided) is fail-CLOSED for non-admins. A function, because a
    // negated comparison needs the guard twice (each use pushes its params).
    const buildWhere = (): string => {
    let where = "";
    if (ctx.lookup) {
      const meta = ctx.lookup(op.collection);
      if (!meta) {
        throw new Error(`unknown collection in @collection.*: ${op.collection}`);
      }
      // Compiled against the target table; shares params.
      const guard = joinedCollectionGuard(meta, op.collection, targetTable, ctx);
      if (guard) where = ` WHERE ${guard}`;
    } else if (ctx.auth?.type !== "admin") {
      // No lookup + non-admin caller → admin-trust shortcut, deny.
      where = ` WHERE ${dialect().never}`;
    }
    return where;
    };
    const where = buildWhere();

    if (exists) {
      const cond = where ? `${where.slice(" WHERE ".length)} AND ` : "";
      const match = `EXISTS (SELECT 1 FROM ${quoteIdent(targetTable)} WHERE ${cond}${exists(applyModifierToSql(inner, op.modifier))})`;
      return negate ? `NOT ${match}` : match;
    }
    return applyModifierToSql(
      `(SELECT ${inner} FROM ${quoteIdent(targetTable)}${where} LIMIT 1)`,
      op.modifier,
    );
  } finally {
    ctx.joinDepth--;
  }
}

type ViaOperand = Extract<Operand, { kind: "viaRelation" }>;

function compileViaRelationRef(op: ViaOperand, ctx: CompileCtx): string {
  const { table, sel, where } = viaSource(op, ctx);
  // 1000-row cap mirrors PB's hard cap to bound back-ref expansion cost.
  // The LIMIT sits on the rows being aggregated: on the aggregate itself
  // it would only limit its single output row and cap nothing.
  const rows = `(SELECT ${sel} AS _vb_v FROM ${table} WHERE ${where} LIMIT 1000) AS _vb_sub`;
  // `:length` counts the rows: the array's length took the subquery up to
  // four times, and on Postgres an empty json_agg is NULL, not 0.
  if (op.modifier === "length") return `(SELECT COUNT(*) FROM ${rows})`;
  return applyModifierToSql(`(SELECT ${dialect().jsonGroupArray("_vb_v")} FROM ${rows})`, op.modifier);
}

/**
 * `_via_` with a `?` operator (some back-related row matches) or `:each`
 * (there are some, and every one matches), compared row by row in the
 * target table with the column's own type. The value read from those rows
 * used to be a JSON array: `?` operators were refused, and `:each` matched
 * nothing on SQLite and failed on Postgres.
 */
function compileViaMatch(via: ViaOperand, other: Operand, op: string, viaOnLeft: boolean, ctx: CompileCtx): string {
  if (other.kind === "viaRelation") throw new Error("only one side of a comparison can be a _via_ back-relation");
  const any = op.startsWith("?");
  if (any ? via.modifier !== undefined : via.modifier !== "each") throw new Error(`_via_ with :${via.modifier} can't be compared with ${op}`);
  const scalarOp = (any ? op.slice(1) : op) as AnyCmpOp;
  // On the right, only = and != : `5 ?> field` on a field reads as
  // `field ?> 5`, so an order or a match there would answer differently.
  if (!viaOnLeft && scalarOp !== "=" && scalarOp !== "!=") throw new Error(`put the _via_ back-relation on the left of ${op}`);
  const like = scalarOp === "~" || scalarOp === "!~";
  // The rows' clause is compiled first but read after the comparison in
  // :each's SQL, so each keeps its own parameters.
  const outer = ctx.params;
  ctx.params = [];
  let source: ReturnType<typeof viaSource>;
  let whereParams: unknown[];
  let cmpParams: unknown[];
  let cmp: string;
  try {
    source = viaSource(via, ctx);
    whereParams = ctx.params;
    ctx.params = [];
    cmp = like
      ? likeSql(source.sel, scalarOp as "~" | "!~", other, ctx)
      : typedCmp({ sql: source.sel, params: [] }, scalarOp, compiled(other, ctx), ctx);
    cmpParams = ctx.params;
  } finally {
    ctx.params = outer;
  }
  const { table, where } = source;
  if (any) {
    outer.push(...whereParams, ...cmpParams);
    return `EXISTS (SELECT 1 FROM ${table} WHERE ${where} AND ${cmp})`;
  }
  outer.push(...cmpParams, ...whereParams);
  return `(SELECT COUNT(*) > 0 AND COUNT(*) = COUNT(CASE WHEN ${cmp} THEN 1 END) FROM ${table} WHERE ${where})`;
}

/**
 * The rows a `_via_` operand reads: the target table, the value selected
 * (the id, or the path), and the clause linking them to this row under
 * the target's rules.
 */
function viaSource(op: ViaOperand, ctx: CompileCtx): { table: string; sel: string; where: string } {
  if (!IDENT_RE.test(op.targetCollection)) throw new Error(`invalid back-relation target: ${op.targetCollection}`);
  if (!IDENT_RE.test(op.refField)) throw new Error(`invalid back-relation ref field: ${op.refField}`);
  for (const p of op.path) if (!IDENT_RE.test(p)) throw new Error(`invalid back-relation path: ${p}`);
  if (++ctx.joinDepth > MAX_JOIN_DEPTH) {
    throw new Error("_via_ join depth exceeded");
  }
  try {
    chargeCrossRef(ctx);
    const targetTable = `vb_${op.targetCollection}`;
    if (!IDENT_RE.test(targetTable)) throw new Error(`invalid table: ${targetTable}`);
    refTarget(op.targetCollection, ctx, true);

    // Default selection — id of the matching back-related rows. With a path,
    // pull `<path>` instead.
    const sel = op.path.length === 0
      ? `${quoteIdent(targetTable)}.${quoteIdent("id")}`
      : (() => {
          let inner = `${quoteIdent(targetTable)}.${quoteIdent(systemAlias(op.path[0]!, ctx.lookup?.(op.targetCollection) ?? null))}`;
          for (let i = 1; i < op.path.length; i++) {
            inner = dialect().jsonExtract(inner, `$.${op.path[i]}`);
          }
          return inner;
        })();

    // Validate ref field if a lookup is provided.
    let where = `${quoteIdent(targetTable)}.${quoteIdent(op.refField)} = ${quoteIdent(ctx.tableName)}."id"`;
    if (ctx.lookup) {
      const meta = ctx.lookup(op.targetCollection);
      if (!meta) {
        throw new Error(`unknown collection in _via_: ${op.targetCollection}`);
      }
      // A caller's own filter gets one answer for a missing and a private
      // ref field, as for any other field.
      if (meta.isPrivateField(op.refField) || (ctx.clientFilter && !meta.hasField(op.refField))) {
        throw new PrivateFieldError(op.refField);
      }
      if (!meta.hasField(op.refField)) {
        throw new Error(`back-relation ref field '${op.refField}' not on '${op.targetCollection}'`);
      }
      // `posts_via_author.password_hash` selects the column out of the joined
      // table, so the path head needs the same guard as a direct reference.
      if (op.path.length > 0) {
        const head = systemAlias(op.path[0]!, meta);
        if (meta.isPrivateField(head) || !meta.isFilterable(head)) {
          throw new PrivateFieldError(head);
        }
      }
      // Inherit the joined collection's rules (view, plus list for a client filter).
      const guard = joinedCollectionGuard(meta, op.targetCollection, targetTable, ctx);
      if (guard) where += ` AND (${guard})`;
    } else if (ctx.auth?.type !== "admin") {
      where += ` AND ${dialect().never}`;
    }

    return { table: quoteIdent(targetTable), sel, where };
  } finally {
    ctx.joinDepth--;
  }
}

function compileFunc(op: Extract<Operand, { kind: "func" }>, ctx: CompileCtx): string {
  if (op.name === "geoDistance") {
    if (op.args.length !== 4) throw new Error("geoDistance expects 4 args");
    const [lonA, latA, lonB, latB] = op.args as [Operand, Operand, Operand, Operand];
    // Each latitude appears twice in the SQL, so it is compiled once per
    // appearance, in SQL order: a literal binds a parameter every time it
    // is compiled, and compiling it once for two placeholders left the
    // statement one value short.
    // A coordinate read from a JSON path is text on some databases; the
    // arithmetic needs a number.
    const c = (a: Operand) => {
      const sql = compileOperand(a, ctx);
      if (!readsJson(a, ctx)) return sql;
      return ctx.element && a.kind === "field" ? itemNumber(sql) : jsonNumber(sql);
    };
    const latB1 = c(latB), latA1 = c(latA), latA2 = c(latA), latB2 = c(latB), lonB1 = c(lonB), lonA1 = c(lonA);
    // Haversine in km. Earth radius 6371.
    return `(2 * 6371 * asin(sqrt(` +
      `pow(sin(radians(${latB1} - ${latA1}) / 2), 2) + ` +
      `cos(radians(${latA2})) * cos(radians(${latB2})) * ` +
      `pow(sin(radians(${lonB1} - ${lonA1}) / 2), 2)` +
    `)))`;
  }
  if (op.name === "strftime") {
    if (op.args.length < 2) throw new Error("strftime expects at least 2 args");
    if (dialect().name !== "sqlite") return compilePgStrftime(op.args, ctx);
    const parts = op.args.map((a) => compileOperand(a, ctx));
    return `strftime(${parts.join(", ")})`;
  }
  throw new Error(`unknown function: ${op.name}`);
}

/** SQLite strftime codes and their Postgres to_char patterns: the subset filters may use elsewhere. */
const PG_STRFTIME: Readonly<Record<string, string>> = {
  Y: "YYYY", m: "MM", d: "DD", H: "HH24", M: "MI", S: "SS", j: "DDD", "%": "%",
};

/**
 * `strftime(format, time, mods…)` for databases other than SQLite, as
 * `to_char` in UTC. The format must be a literal made of the codes above;
 * the time is `'now'`, a literal timestamp, or a value with the
 * `unixepoch` modifier (dates are stored as Unix seconds). Anything else
 * is refused rather than answered differently from SQLite.
 */
function compilePgStrftime(args: Operand[], ctx: CompileCtx): string {
  const [fmtArg, timeArg, ...mods] = args as [Operand, Operand, ...Operand[]];
  if (fmtArg.kind !== "literal" || typeof fmtArg.value !== "string") throw new Error("strftime() needs a literal format on this database");
  const modValues = mods.map((m) => (m.kind === "literal" ? m.value : null));
  if (modValues.some((m) => m !== "unixepoch")) throw new Error("strftime() supports only the 'unixepoch' modifier on this database");
  let pattern = "";
  let literal = "";
  const flush = () => { if (literal) { pattern += `"${literal.replace(/"/g, "\\\"")}"`; literal = ""; } };
  const fmt = fmtArg.value;
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] === "%") {
      const code = fmt[i + 1] ?? "";
      const mapped = PG_STRFTIME[code];
      if (!mapped) throw new Error(`strftime() code %${code} is not available on this database (use %Y %m %d %H %M %S %j)`);
      if (code === "%") literal += "%";
      else { flush(); pattern += mapped; }
      i++;
    } else literal += fmt[i];
  }
  flush();
  let time: string;
  // Postgres reads 'now', 'NOW', ' today ', 'tomorrow' and 'yesterday' as the
  // clock, whatever their case or spacing. Bound as a cast they hid that the
  // query reads the clock, and list totals were cached (records.ts). Emit
  // them as now() so every clock read is visible in the SQL.
  const clock = timeArg.kind === "literal" && typeof timeArg.value === "string" && modValues.length === 0
    ? timeArg.value.trim().toLowerCase() : "";
  if (clock === "now") time = "now()";
  else if (clock === "today") time = "date_trunc('day', now(), 'UTC')";
  else if (clock === "tomorrow") time = "(date_trunc('day', now(), 'UTC') + interval '1 day')";
  else if (clock === "yesterday") time = "(date_trunc('day', now(), 'UTC') - interval '1 day')";
  else if (modValues.length === 1) {
    const t = compileOperand(timeArg, ctx);
    time = `to_timestamp(${readsJson(timeArg, ctx) ? jsonNumber(t) : `CAST(${t} AS DOUBLE PRECISION)`})`;
  }
  else if (timeArg.kind === "literal" && typeof timeArg.value === "string") time = `CAST(${compileOperand(timeArg, ctx)} AS TIMESTAMPTZ)`;
  else throw new Error("strftime() needs the 'unixepoch' modifier for a stored date on this database");
  ctx.params.push(pattern);
  return `to_char(${time} AT TIME ZONE 'UTC', ?)`;
}

function applyModifierToSql(expr: string, m?: FieldModifier): string {
  if (!m) return expr;
  switch (m) {
    case "lower":  return `LOWER(${expr})`;
    // items.length: NULL unless a JSON array, without failing on other text
    // (json_array_length fails on "A" and gives 0 for "10").
    case "length": return dialect().jsonPathLength(expr) ?? `COALESCE(${dialect().items.length(expr)}, length(${dialect().asText(expr)}))`;
    case "isset":
    case "changed":
    case "each":
      // `:isset` / `:changed` only valid on requestMap (handled at caller).
      // `:each` would need a nontrivial subquery; deferred.
      return expr;
  }
}

function applyModifierToValue(v: unknown, m?: FieldModifier): unknown {
  if (!m) return v;
  switch (m) {
    case "lower":
      return typeof v === "string" ? v.toLowerCase() : v;
    case "length":
      if (Array.isArray(v)) return v.length;
      if (typeof v === "string") return v.length;
      return 0;
    default:
      return v;
  }
}

/**
 * The bound pattern for `~` / `!~`: the value wrapped in `%…%`. A literal
 * the filter or rule author wrote keeps LIKE's wildcards (`%`, `_`). A value
 * that arrives at runtime — `@request.*`, `@request.auth.*` — is matched as
 * plain text, the way the in-process rule engine already matches it:
 * otherwise a caller who sends `%` makes `field ~ @request.body.x` match
 * every row.
 */
/**
 * `left ~ right` / `left !~ right` as SQL. An empty or NULL right side
 * matches nothing for `~` (and everything for `!~`) — before, it became the
 * pattern '%%' and a rule like `tags ~ @request.auth.team` let anonymous
 * callers see every row. coalesce() keeps `!~` the exact negation of `~`, as
 * in the rule engine.
 */
function likeSql(leftSql: string, op: "~" | "!~", operand: Operand, ctx: CompileCtx): string {
  const match = dialect().like(leftSql, likeParam(operand, ctx));
  return op === "~" ? match : `NOT ${match}`;
}

function isValueOperand(operand: Operand): boolean {
  switch (operand.kind) {
    case "literal":
    case "macro":
      return true;
    case "auth":
    case "request":
    case "requestMap":
      return !operand.modifier;
    default:
      return false;
  }
}

/** A LIKE pattern matching SQL value `col` as plain text; NULL when it is empty or NULL. */
function sqlLikePattern(col: string): string {
  return `'%' || replace(replace(replace(nullif(${dialect().asText(col)}, ''), '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%' ESCAPE '\\'`;
}

/** The LIKE pattern for `right`; NULL when the right side is empty or NULL. */
function likeParam(operand: Operand, ctx: CompileCtx): string {
  // Anything evaluated in SQL — a column (`a ~ b`), a `_via_` back-relation,
  // a function, a modified operand: operandValue() has no value for it, so
  // this used to bind '%%' and match every row. Build the pattern in SQL,
  // escaping the operand's own wildcards.
  if (!isValueOperand(operand)) return sqlLikePattern(compileOperand(operand, ctx));
  const raw = operandValue(operand, ctx);
  const v = raw === null || raw === undefined ? "" : String(raw);
  if (v === "") {
    ctx.params.push(null);
    return "?";
  }
  if (operand.kind === "literal" || operand.kind === "macro") {
    ctx.params.push(`%${v}%`);
    return "?";
  }
  ctx.params.push(`%${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  return "? ESCAPE '\\'";
}

function operandValue(op: Operand, ctx: CompileCtx): unknown {
  switch (op.kind) {
    case "literal": return coerceLiteral(op.value);
    case "auth":    return authValue(ctx.auth, op.prop);
    case "request": return ctx.request?.[op.prop] ?? null;
    case "requestMap": {
      const map = ctx.request?.[op.mapKind];
      return requestMapValue(map, op.mapKind, op.key);
    }
    case "macro":   return macroValue(op.name);
    default:        return null;
  }
}

/** SQL-side `:isset` resolution: 1 if request has the key, 0 otherwise. */
function requestIsSet(op: Extract<Operand, { kind: "requestMap" }>, ctx: CompileCtx): string {
  const map = ctx.request?.[op.mapKind];
  const present = requestMapHas(map, op.mapKind, op.key);
  ctx.params.push(present ? 1 : 0);
  return "?";
}

/** SQL-side `:changed` resolution: 1 if body[key] differs from existing[key], else 0. */
function bodyChanged(op: Extract<Operand, { kind: "requestMap" }>, ctx: CompileCtx): string {
  const body = ctx.request?.body ?? null;
  const existing = ctx.request?.existing ?? null;
  if (!body || !existing) {
    ctx.params.push(0);
    return "?";
  }
  const before = (existing as Record<string, unknown>)[op.key];
  const after = (body as Record<string, unknown>)[op.key];
  ctx.params.push(stableEq(before, after) ? 0 : 1);
  return "?";
}

function authValue(auth: AuthContext | null, prop: AuthProp): string | number | null {
  if (!auth) return null;
  if (prop === "id")   return auth.id || null;
  if (prop === "type") return auth.type;
  // Without these, `@request.auth.id != ""` was the only "signed in" test,
  // and it admits guests (anonymous sessions) and every auth collection.
  if (prop === "collectionName") return auth.collection ?? null;
  if (prop === "verified")  return auth.verified ? 1 : 0;
  if (prop === "anonymous") return auth.anonymous ? 1 : 0;
  return auth.email ?? null;
}

function coerceLiteral(v: string | number | boolean | null): string | number | null {
  if (v === true) return 1;
  if (v === false) return 0;
  if (v === null) return null;
  return v;
}

