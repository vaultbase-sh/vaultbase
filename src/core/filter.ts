import type { AuthContext } from "./rules.ts";
import type { Expr, Operand, AnyCmpOp, FieldModifier, AuthProp } from "./expression.ts";
import { db, driverOpen } from "../db/index.ts";
import { SQLITE_DIALECT } from "../db/sqlite.ts";
import type { Dialect } from "../db/driver.ts";

/** The open driver's dialect; SQLite's when nothing is open (rules compiled offline, tests). */
function dialect(): Dialect {
  return driverOpen() ? db.dialect : SQLITE_DIALECT;
}
import { requestMapHas, requestMapValue } from "./expression.ts";
import { cachedParseExpression as parseExpression } from "./filter-cache.ts";

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
  /** The id-field of the host table (default "id") — needed for back-relation join. */
  hostIdField?: string;
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
    bindText: false,
    tableName,
    auth: opts.auth ?? null,
    request: opts.request ?? null,
    lookup: opts.lookup,
    hostIdField: opts.hostIdField ?? "id",
    hostPrivateField: opts.hostPrivateField ?? (() => false),
    hostFilterable: opts.hostFilterable,
    params: [],
    /** Track recursion depth on @collection.* / _via_ joins to bound work. */
    joinDepth: 0,
    hoist: null,
    aliasSeq: { n: 0 },
    maxJoins: opts.maxJoins ?? MAX_COLLECTION_JOINS,
    crossRefs: { n: 0, max: opts.maxCrossRefs ?? Number.POSITIVE_INFINITY },
    clientFilter: opts.clientFilter === true && opts.auth?.type !== "admin",
  };
  const sql = compileScoped(ast, ctx);
  return { sql, params: ctx.params };
}

interface CompileCtx {
  /** Set while compiling the value side of a comparison with a JSON path (see bindValue). */
  bindText: boolean;
  tableName: string;
  auth: AuthContext | null;
  request: RequestContextLike | null;
  lookup: CollectionLookup | undefined;
  hostIdField: string;
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
  const joins = scope.joins.map((j) => `LEFT JOIN ${escapeIdent(j.table)} AS ${j.alias} ON ${j.on}`).join(" ");
  return `EXISTS (SELECT 1 FROM (SELECT 1) AS _vb_one ${joins} WHERE ${sql})`;
}

const MAX_JOIN_DEPTH = 4;

function compileNode(ast: Expr, ctx: CompileCtx): string {
  if (ast.kind === "and") {
    return `(${compileNode(ast.left, ctx)} AND ${compileNode(ast.right, ctx)})`;
  }
  if (ast.kind === "or") {
    return `(${compileNode(ast.left, ctx)} OR ${compileNode(ast.right, ctx)})`;
  }

  const op = ast.op;

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
    return `(${lhs}) ${sqlOpFor(op)} (${rhs})`;
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
    return `(${lhs}) ${sqlOpFor(op)} (${rhs})`;
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

  const leftJson = isJsonPath(ast.left);
  const rightJson = isJsonPath(ast.right);
  const left = rightJson ? withBindText(ctx, () => compileOperand(ast.left, ctx)) : compileOperand(ast.left, ctx);
  const right = leftJson ? withBindText(ctx, () => compileOperand(ast.right, ctx)) : compileOperand(ast.right, ctx);
  return `${left} ${sqlOpFor(op)} ${right}`;
}

function withBindText<T>(ctx: CompileCtx, fn: () => T): T {
  const prev = ctx.bindText;
  ctx.bindText = true;
  try { return fn(); } finally { ctx.bindText = prev; }
}

function sqlOpFor(op: AnyCmpOp): string {
  if (op === "=" || op === "!=") return op === "=" ? "=" : "!=";
  if (op === ">" || op === ">=" || op === "<" || op === "<=") return op;
  // ~ / !~ handled inline; ? variants handled inline
  return op;
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
  if (op === "~" || op === "!~") {
    cmp = likeSql("value", op, scalarOperand, ctx);
  } else {
    const right = compileOperand(scalarOperand, ctx);
    cmp = `value ${sqlOpFor(op)} ${right}`;
  }
  const d = dialect();
  return `(${d.jsonArrayLength(arraySql)} > 0 AND NOT EXISTS (SELECT 1 FROM ${d.jsonEach(arraySql)} WHERE NOT (${cmp})))`;
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
  if (scalarOp === "~" || scalarOp === "!~") {
    cmp = likeSql("value", scalarOp, scalarOperand, innerCtx);
  } else {
    const right = compileOperand(scalarOperand, innerCtx);
    cmp = `value ${sqlOpFor(scalarOp)} ${right}`;
  }
  // Splice inner params into outer in the right position.
  ctx.params.push(...inner);
  return `EXISTS (SELECT 1 FROM ${dialect().jsonEach(arraySql)} WHERE ${cmp})`;
}

/** A bound comparison value; text when the other side is a JSON path the dialect reads as text. */
function bindValue(ctx: CompileCtx, v: unknown): unknown {
  return ctx.bindText && v !== null && v !== undefined && typeof v !== "string" && dialect().jsonCompareAsText ? String(v) : v;
}

/** Whether comparing against this operand reads a JSON path. */
function isJsonPath(op: Operand): boolean {
  return (op.kind === "field" || op.kind === "collection") && op.path.length > (op.kind === "field" ? 0 : 1);
}

function compileOperand(op: Operand, ctx: CompileCtx): string {
  switch (op.kind) {
    case "literal": {
      ctx.params.push(bindValue(ctx, coerceLiteral(op.value)));
      return "?";
    }
    case "auth": {
      ctx.params.push(bindValue(ctx, authValue(ctx.auth, op.prop)));
      return "?";
    }
    case "request": {
      const v = ctx.request?.[op.prop] ?? null;
      ctx.params.push(bindValue(ctx, v));
      return "?";
    }
    case "requestMap": {
      const map = ctx.request?.[op.mapKind];
      const raw = requestMapValue(map, op.mapKind, op.key);
      const v = applyModifierToValue(raw, op.modifier);
      ctx.params.push(bindValue(ctx, v));
      return "?";
    }
    case "macro": {
      ctx.params.push(bindValue(ctx, macroValue(op.name)));
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

function compileFieldRef(op: Extract<Operand, { kind: "field" }>, ctx: CompileCtx): string {
  if (!IDENT_RE.test(op.name)) throw new Error(`invalid field name: ${op.name}`);
  // Private first, then existence — both raise the same error, so the order
  // only matters for readability.
  if (ctx.hostPrivateField(op.name)) throw new PrivateFieldError(op.name);
  if (ctx.hostFilterable && !ctx.hostFilterable(op.name)) throw new PrivateFieldError(op.name);
  const baseCol = `${escapeIdent(ctx.tableName)}.${escapeIdent(op.name)}`;
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
      hostPrivateField: (n) => ctx.lookup?.(collection)?.isPrivateField(n) ?? false,
      hostFilterable: (n) => ctx.lookup?.(collection)?.isFilterable(n) ?? true,
      clientFilter: false,
    });
    parts.push(compileScoped(innerAst, innerCtx));
    ctx.joinDepth = innerCtx.joinDepth;
  }
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : parts.map((p) => `(${p})`).join(" AND ");
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

    const head = op.path[0]!;
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
      let col = `${join.alias}.${escapeIdent(head)}`;
      for (let i = 1; i < op.path.length; i++) col = dialect().jsonExtract(col, `$.${op.path[i]}`);
      return applyModifierToSql(col, op.modifier);
    }
    // `@collection.users.password_hash` is the same oracle as a local ref.
    const targetMeta = ctx.lookup?.(op.collection);
    if (targetMeta && (targetMeta.isPrivateField(head) || !targetMeta.isFilterable(head))) {
      throw new PrivateFieldError(head);
    }
    let inner = `${escapeIdent(targetTable)}.${escapeIdent(head)}`;
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
      const match = `EXISTS (SELECT 1 FROM ${escapeIdent(targetTable)} WHERE ${cond}${exists(applyModifierToSql(inner, op.modifier))})`;
      return negate ? `NOT ${match}` : match;
    }
    return applyModifierToSql(
      `(SELECT ${inner} FROM ${escapeIdent(targetTable)}${where} LIMIT 1)`,
      op.modifier,
    );
  } finally {
    ctx.joinDepth--;
  }
}

function compileViaRelationRef(op: Extract<Operand, { kind: "viaRelation" }>, ctx: CompileCtx): string {
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

    // Default selection — id of the matching back-related rows. With a path,
    // pull `<path>` instead.
    const sel = op.path.length === 0
      ? `${escapeIdent(targetTable)}.${escapeIdent("id")}`
      : (() => {
          let inner = `${escapeIdent(targetTable)}.${escapeIdent(op.path[0]!)}`;
          for (let i = 1; i < op.path.length; i++) {
            inner = dialect().jsonExtract(inner, `$.${op.path[i]}`);
          }
          return inner;
        })();

    // Validate ref field if a lookup is provided.
    let where = `${escapeIdent(targetTable)}.${escapeIdent(op.refField)} = ${escapeIdent(ctx.tableName)}.${escapeIdent(ctx.hostIdField)}`;
    if (ctx.lookup) {
      const meta = ctx.lookup(op.targetCollection);
      if (!meta) {
        throw new Error(`unknown collection in _via_: ${op.targetCollection}`);
      }
      if (!meta.hasField(op.refField)) {
        throw new Error(`back-relation ref field '${op.refField}' not on '${op.targetCollection}'`);
      }
      if (meta.isPrivateField(op.refField)) throw new PrivateFieldError(op.refField);
      // `posts_via_author.password_hash` selects the column out of the joined
      // table, so the path head needs the same guard as a direct reference.
      if (op.path.length > 0) {
        const head = op.path[0]!;
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

    // 1000-row cap mirrors PB's hard cap to bound back-ref expansion cost.
    // The LIMIT sits on the rows being aggregated: on the aggregate itself
    // it would only limit its single output row and cap nothing.
    const subq = `(SELECT ${dialect().jsonGroupArray("_vb_v")} FROM (SELECT ${sel} AS _vb_v FROM ${escapeIdent(targetTable)} WHERE ${where} LIMIT 1000) AS _vb_sub)`;
    return applyModifierToSql(subq, op.modifier);
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
    const c = (a: Operand) => isJsonPath(a) ? `CAST(${compileOperand(a, ctx)} AS DOUBLE PRECISION)` : compileOperand(a, ctx);
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
    if (dialect().name !== "sqlite") throw new Error("strftime() is not available on this database");
    const parts = op.args.map((a) => compileOperand(a, ctx));
    return `strftime(${parts.join(", ")})`;
  }
  throw new Error(`unknown function: ${op.name}`);
}

function applyModifierToSql(expr: string, m?: FieldModifier): string {
  if (!m) return expr;
  switch (m) {
    case "lower":  return `LOWER(${expr})`;
    case "length": return `COALESCE(${dialect().jsonArrayLength(expr)}, length(${dialect().asText(expr)}))`;
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

function macroValue(name: string): string | number {
  const now = new Date();
  // Unix seconds: the storage format of date and autodate fields, so a
  // comparison with them is a comparison, not SQLite's type ordering.
  const utc = (d: Date) => Math.floor(d.getTime() / 1000);
  switch (name) {
    case "now":          return utc(now);
    case "yesterday":    return utc(new Date(now.getTime() - 86_400_000));
    case "tomorrow":     return utc(new Date(now.getTime() + 86_400_000));
    case "todayStart":   return utc(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
    case "todayEnd":     return utc(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999)));
    case "monthStart":   return utc(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
    case "monthEnd":     return utc(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999)));
    case "yearStart":    return utc(new Date(Date.UTC(now.getUTCFullYear(), 0, 1)));
    case "yearEnd":      return utc(new Date(Date.UTC(now.getUTCFullYear(), 11, 31, 23, 59, 59, 999)));
    case "second":       return now.getUTCSeconds();
    case "minute":       return now.getUTCMinutes();
    case "hour":         return now.getUTCHours();
    case "day":          return now.getUTCDate();
    case "weekday":      return now.getUTCDay();
    case "month":        return now.getUTCMonth() + 1;
    case "year":         return now.getUTCFullYear();
    default:             throw new Error(`unknown macro: ${name}`);
  }
}

function coerceLiteral(v: string | number | boolean | null): string | number | null {
  if (v === true) return 1;
  if (v === false) return 0;
  if (v === null) return null;
  return v;
}

function escapeIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function stableEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === "object") {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return false;
}
