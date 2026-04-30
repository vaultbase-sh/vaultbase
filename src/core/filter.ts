import type { AuthContext } from "./rules.ts";
import type { Expr, Operand, AnyCmpOp, FieldModifier } from "./expression.ts";
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
  (collectionName: string): { viewRule: string | null; hasField: (name: string) => boolean } | null;
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
}

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
    hostIdField: opts.hostIdField ?? "id",
    params: [],
    /** Track recursion depth on @collection.* / _via_ joins to bound work. */
    joinDepth: 0,
  };
  const sql = compileNode(ast, ctx);
  return { sql, params: ctx.params };
}

interface CompileCtx {
  tableName: string;
  auth: AuthContext | null;
  request: RequestContextLike | null;
  lookup: CollectionLookup | undefined;
  hostIdField: string;
  params: unknown[];
  joinDepth: number;
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

  // Standard scalar comparison
  if (op === "~" || op === "!~") {
    const left = compileOperand(ast.left, ctx);
    const v = operandValue(ast.right, ctx);
    ctx.params.push(`%${String(v ?? "")}%`);
    return `${left} ${op === "~" ? "LIKE" : "NOT LIKE"} ?`;
  }

  const left = compileOperand(ast.left, ctx);
  const right = compileOperand(ast.right, ctx);
  return `${left} ${sqlOpFor(op)} ${right}`;
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
    const v = operandValue(scalarOperand, ctx);
    ctx.params.push(`%${String(v ?? "")}%`);
    cmp = `value ${op === "~" ? "LIKE" : "NOT LIKE"} ?`;
  } else {
    const right = compileOperand(scalarOperand, ctx);
    cmp = `value ${sqlOpFor(op)} ${right}`;
  }
  return `(json_array_length(${arraySql}) > 0 AND NOT EXISTS (SELECT 1 FROM json_each(${arraySql}) WHERE NOT (${cmp})))`;
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
    const v = operandValue(scalarOperand, innerCtx);
    inner.push(`%${String(v ?? "")}%`);
    cmp = `value ${scalarOp === "~" ? "LIKE" : "NOT LIKE"} ?`;
  } else {
    const right = compileOperand(scalarOperand, innerCtx);
    cmp = `value ${sqlOpFor(scalarOp)} ${right}`;
  }
  // Splice inner params into outer in the right position.
  ctx.params.push(...inner);
  return `EXISTS (SELECT 1 FROM json_each(${arraySql}) WHERE ${cmp})`;
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
      const raw = map?.[op.key.toLowerCase().replace(/-/g, "_")] ?? map?.[op.key] ?? null;
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

function compileFieldRef(op: Extract<Operand, { kind: "field" }>, ctx: CompileCtx): string {
  if (!IDENT_RE.test(op.name)) throw new Error(`invalid field name: ${op.name}`);
  const baseCol = `${escapeIdent(ctx.tableName)}.${escapeIdent(op.name)}`;
  if (op.path.length === 0 && !op.modifier) return baseCol;

  // Dotted path → JSON extraction
  let expr = baseCol;
  for (const seg of op.path) {
    if (!IDENT_RE.test(seg)) throw new Error(`invalid field path segment: ${seg}`);
    expr = `json_extract(${expr}, '$.${seg}')`;
  }
  return applyModifierToSql(expr, op.modifier);
}

function compileCollectionRef(op: Extract<Operand, { kind: "collection" }>, ctx: CompileCtx): string {
  if (!IDENT_RE.test(op.collection)) throw new Error(`invalid collection: ${op.collection}`);
  for (const p of op.path) if (!IDENT_RE.test(p)) throw new Error(`invalid path: ${p}`);
  if (++ctx.joinDepth > MAX_JOIN_DEPTH) {
    throw new Error("@collection.* join depth exceeded");
  }
  try {
    const targetTable = `vb_${op.collection}`;
    if (!IDENT_RE.test(targetTable)) throw new Error(`invalid table: ${targetTable}`);

    const head = op.path[0]!;
    let inner = `${escapeIdent(targetTable)}.${escapeIdent(head)}`;
    for (let i = 1; i < op.path.length; i++) {
      inner = `json_extract(${inner}, '$.${op.path[i]}')`;
    }

    // Inherit the joined collection's view_rule. Anonymous-rule-eval (no
    // lookup provided) returns `null` view_rule which is fail-CLOSED on
    // the SQL path (caller passes a NULL parameter so the equality match
    // can never satisfy a non-trivial join condition). Provided lookups
    // return the configured rule and we compile it against the target table.
    let where = "";
    if (ctx.lookup) {
      const meta = ctx.lookup(op.collection);
      if (!meta) {
        throw new Error(`unknown collection in @collection.*: ${op.collection}`);
      }
      if (meta.viewRule === "") {
        // admin-only; non-admin rule eval can never satisfy → emit a no-row guard
        if (ctx.auth?.type !== "admin") {
          where = " WHERE 1=0";
        }
      } else if (meta.viewRule !== null) {
        const innerAst = parseExpression(meta.viewRule);
        if (innerAst) {
          // Recursively compile against the target table; share params.
          const innerCtx: CompileCtx = { ...ctx, tableName: targetTable };
          const sql = compileNode(innerAst, innerCtx);
          // copy back joinDepth so siblings see the work
          ctx.joinDepth = innerCtx.joinDepth;
          where = ` WHERE ${sql}`;
        }
      }
    } else if (ctx.auth?.type !== "admin") {
      // No lookup + non-admin caller → admin-trust shortcut, deny.
      where = " WHERE 1=0";
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
    const targetTable = `vb_${op.targetCollection}`;
    if (!IDENT_RE.test(targetTable)) throw new Error(`invalid table: ${targetTable}`);

    // Default selection — id of the matching back-related rows. With a path,
    // pull `<path>` instead.
    const sel = op.path.length === 0
      ? `${escapeIdent(targetTable)}.${escapeIdent("id")}`
      : (() => {
          let inner = `${escapeIdent(targetTable)}.${escapeIdent(op.path[0]!)}`;
          for (let i = 1; i < op.path.length; i++) {
            inner = `json_extract(${inner}, '$.${op.path[i]}')`;
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
      // Inherit view_rule on the joined collection.
      if (meta.viewRule === "") {
        if (ctx.auth?.type !== "admin") {
          where += " AND 1=0";
        }
      } else if (meta.viewRule !== null) {
        const innerAst = parseExpression(meta.viewRule);
        if (innerAst) {
          const innerCtx: CompileCtx = { ...ctx, tableName: targetTable };
          const ruleSql = compileNode(innerAst, innerCtx);
          ctx.joinDepth = innerCtx.joinDepth;
          where += ` AND (${ruleSql})`;
        }
      }
    } else if (ctx.auth?.type !== "admin") {
      where += " AND 1=0";
    }

    // 1000-row cap mirrors PB's hard cap to bound back-ref expansion cost.
    const subq = `(SELECT json_group_array(${sel}) FROM ${escapeIdent(targetTable)} WHERE ${where} LIMIT 1000)`;
    return applyModifierToSql(subq, op.modifier);
  } finally {
    ctx.joinDepth--;
  }
}

function compileFunc(op: Extract<Operand, { kind: "func" }>, ctx: CompileCtx): string {
  if (op.name === "geoDistance") {
    if (op.args.length !== 4) throw new Error("geoDistance expects 4 args");
    const [lonA, latA, lonB, latB] = op.args.map((a) => compileOperand(a, ctx));
    // Haversine in km. Earth radius 6371.
    return `(2 * 6371 * asin(sqrt(` +
      `pow(sin(radians(${latB} - ${latA}) / 2), 2) + ` +
      `cos(radians(${latA})) * cos(radians(${latB})) * ` +
      `pow(sin(radians(${lonB} - ${lonA}) / 2), 2)` +
    `)))`;
  }
  if (op.name === "strftime") {
    if (op.args.length < 2) throw new Error("strftime expects at least 2 args");
    const parts = op.args.map((a) => compileOperand(a, ctx));
    return `strftime(${parts.join(", ")})`;
  }
  throw new Error(`unknown function: ${op.name}`);
}

function applyModifierToSql(expr: string, m?: FieldModifier): string {
  if (!m) return expr;
  switch (m) {
    case "lower":  return `LOWER(${expr})`;
    case "length": return `COALESCE(json_array_length(${expr}), length(${expr}))`;
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

function operandValue(op: Operand, ctx: CompileCtx): unknown {
  switch (op.kind) {
    case "literal": return coerceLiteral(op.value);
    case "auth":    return authValue(ctx.auth, op.prop);
    case "request": return ctx.request?.[op.prop] ?? null;
    case "requestMap": {
      const map = ctx.request?.[op.mapKind];
      return map?.[op.key.toLowerCase().replace(/-/g, "_")] ?? map?.[op.key] ?? null;
    }
    case "macro":   return macroValue(op.name);
    default:        return null;
  }
}

/** SQL-side `:isset` resolution: 1 if request has the key, 0 otherwise. */
function requestIsSet(op: Extract<Operand, { kind: "requestMap" }>, ctx: CompileCtx): string {
  const map = ctx.request?.[op.mapKind];
  const present = map !== undefined && (
    op.key in (map as Record<string, unknown>) ||
    op.key.toLowerCase().replace(/-/g, "_") in (map as Record<string, unknown>)
  );
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

function authValue(auth: AuthContext | null, prop: "id" | "email" | "type"): string | null {
  if (!auth) return null;
  if (prop === "id")   return auth.id || null;
  if (prop === "type") return auth.type;
  return auth.email ?? null;
}

function macroValue(name: string): string | number {
  const now = new Date();
  const utc = (d: Date) => d.toISOString();
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
