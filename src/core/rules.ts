import type { Expr, Operand, AnyCmpOp, FieldModifier } from "./expression.ts";
import { cachedParseExpression as parseExpression } from "./filter-cache.ts";
import type { RequestContextLike } from "./filter.ts";

export interface AuthContext {
  id: string;
  type: "user" | "admin";
  email?: string;
}

export interface EvalContext {
  auth: AuthContext | null;
  record: Record<string, unknown> | null;
  request?: RequestContextLike | null | undefined;
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

/** True if the rule references SQL-only constructs that need filter compilation. */
export function isExpressionRule(rule: string | null): boolean {
  return rule !== null && rule !== "";
}

// ── AST evaluation ──────────────────────────────────────────────────────────

const UNAUTH_SENTINEL = Symbol("unauth");

function evaluateExpr(ast: Expr, ctx: EvalContext): boolean {
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

  if (l === UNAUTH_SENTINEL || r === UNAUTH_SENTINEL) return false;

  switch (op) {
    case "=":  return looseEq(l, r);
    case "!=": return !looseEq(l, r);
    case ">":  return cmp(l, r) > 0;
    case ">=": return cmp(l, r) >= 0;
    case "<":  return cmp(l, r) < 0;
    case "<=": return cmp(l, r) <= 0;
    case "~":  return String(l ?? "").includes(String(r ?? ""));
    case "!~": return !String(l ?? "").includes(String(r ?? ""));
    default:   return false;
  }
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

  const arr = resolveOperand(stripped, ctx);
  if (!Array.isArray(arr) || arr.length === 0) return false;
  const target = resolveOperand(scalarOperand, ctx);
  if (target === UNAUTH_SENTINEL) return false;

  return arr.every((item) => {
    switch (op) {
      case "=":  return looseEq(item, target);
      case "!=": return !looseEq(item, target);
      case ">":  return cmp(item, target) > 0;
      case ">=": return cmp(item, target) >= 0;
      case "<":  return cmp(item, target) < 0;
      case "<=": return cmp(item, target) <= 0;
      case "~":  return String(item ?? "").includes(String(target ?? ""));
      case "!~": return !String(item ?? "").includes(String(target ?? ""));
      default:   return false;
    }
  });
}

function evaluateArrayCmp(left: Operand, right: Operand, scalarOp: AnyCmpOp, ctx: EvalContext): boolean {
  // Array operand is the field side; scalar is the literal/auth side.
  const arrayOperand = left.kind === "field" || left.kind === "collection" ? left : right;
  const scalarOperand = arrayOperand === left ? right : left;

  const arr = resolveOperand(arrayOperand, ctx);
  if (!Array.isArray(arr)) return false;
  const target = resolveOperand(scalarOperand, ctx);
  if (target === UNAUTH_SENTINEL) return false;

  for (const item of arr) {
    let match: boolean;
    switch (scalarOp) {
      case "=":  match = looseEq(item, target); break;
      case "!=": match = !looseEq(item, target); break;
      case ">":  match = cmp(item, target) > 0; break;
      case ">=": match = cmp(item, target) >= 0; break;
      case "<":  match = cmp(item, target) < 0; break;
      case "<=": match = cmp(item, target) <= 0; break;
      case "~":  match = String(item ?? "").includes(String(target ?? "")); break;
      case "!~": match = !String(item ?? "").includes(String(target ?? "")); break;
      default:   match = false;
    }
    if (match) return true;
  }
  return false;
}

function resolveOperand(op: Operand, ctx: EvalContext): unknown {
  switch (op.kind) {
    case "literal": return op.value;
    case "auth": {
      if (!ctx.auth) return UNAUTH_SENTINEL;
      if (op.prop === "id") return ctx.auth.id || UNAUTH_SENTINEL;
      if (op.prop === "type") return ctx.auth.type;
      return ctx.auth.email ?? UNAUTH_SENTINEL;
    }
    case "request": return ctx.request?.[op.prop] ?? null;
    case "requestMap": {
      const map = ctx.request?.[op.mapKind];
      const key = op.key;
      const norm = key.toLowerCase().replace(/-/g, "_");
      const v = (map as Record<string, unknown> | undefined)?.[norm]
        ?? (map as Record<string, unknown> | undefined)?.[key]
        ?? null;
      if (op.modifier === "isset") {
        if (!map) return false;
        return key in (map as Record<string, unknown>) || norm in (map as Record<string, unknown>);
      }
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
      const head = ctx.record?.[op.name];
      const v = walkPath(head, op.path);
      return applyModifierValue(v, op.modifier);
    }
    case "collection": {
      // In-process eval: cross-collection joins require a DB read; we don't
      // run them here. The SQL filter path (filter.ts) handles them. Returning
      // null here means rules referencing @collection.* in single-record eval
      // (view_rule on get-by-id) deny conservatively.
      return null;
    }
    case "viaRelation": {
      // Same conservative-deny stance for back-relations in single-record eval.
      return null;
    }
  }
}

function walkPath(start: unknown, path: string[]): unknown {
  let v: unknown = start;
  for (const seg of path) {
    if (v == null) return null;
    if (typeof v !== "object") return null;
    v = (v as Record<string, unknown>)[seg];
  }
  return v;
}

function applyModifierValue(v: unknown, m?: FieldModifier): unknown {
  if (!m) return v;
  switch (m) {
    case "lower":  return typeof v === "string" ? v.toLowerCase() : v;
    case "length":
      if (Array.isArray(v)) return v.length;
      if (typeof v === "string") return v.length;
      return 0;
    default: return v;
  }
}

function evalFunc(op: Extract<Operand, { kind: "func" }>, ctx: EvalContext): unknown {
  if (op.name === "geoDistance") {
    const args = op.args.map((a) => Number(resolveOperand(a, ctx)));
    if (args.some((n) => !Number.isFinite(n))) return null;
    const [lonA, latA, lonB, latB] = args as [number, number, number, number];
    return haversineKm(latA, lonA, latB, lonB);
  }
  if (op.name === "strftime") {
    // In-process eval doesn't support full strftime; surface as null so SQL path is preferred.
    return null;
  }
  return null;
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

function macroValue(name: string): string | number {
  const now = new Date();
  const utc = (d: Date) => d.toISOString();
  switch (name) {
    case "now":        return utc(now);
    case "yesterday":  return utc(new Date(now.getTime() - 86_400_000));
    case "tomorrow":   return utc(new Date(now.getTime() + 86_400_000));
    case "todayStart": return utc(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
    case "todayEnd":   return utc(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999)));
    case "monthStart": return utc(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
    case "monthEnd":   return utc(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999)));
    case "yearStart":  return utc(new Date(Date.UTC(now.getUTCFullYear(), 0, 1)));
    case "yearEnd":    return utc(new Date(Date.UTC(now.getUTCFullYear(), 11, 31, 23, 59, 59, 999)));
    case "second":     return now.getUTCSeconds();
    case "minute":     return now.getUTCMinutes();
    case "hour":       return now.getUTCHours();
    case "day":        return now.getUTCDate();
    case "weekday":    return now.getUTCDay();
    case "month":      return now.getUTCMonth() + 1;
    case "year":       return now.getUTCFullYear();
    default:           throw new Error(`unknown macro: ${name}`);
  }
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === UNAUTH_SENTINEL || b === UNAUTH_SENTINEL) return false;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (typeof a === "boolean") a = a ? 1 : 0;
  if (typeof b === "boolean") b = b ? 1 : 0;
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return String(a) === String(b);
}

function cmp(a: unknown, b: unknown): number {
  const na = typeof a === "boolean" ? (a ? 1 : 0) : Number(a);
  const nb = typeof b === "boolean" ? (b ? 1 : 0) : Number(b);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return String(a ?? "").localeCompare(String(b ?? ""));
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
