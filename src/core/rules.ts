import { parseExpression, type Expr, type Operand } from "./expression.ts";

export interface AuthContext {
  id: string;
  type: "user" | "admin";
  email?: string;
}

/**
 * Evaluate a rule against the current auth + record context.
 *
 * Conventions:
 * - `null` rule  → public access (always allowed)
 * - `""`   rule  → admin only (allowed only if auth.type === "admin")
 * - any expression → parse + evaluate. Admin always passes regardless.
 *
 * Returns true if access is allowed.
 */
export function evaluateRule(
  rule: string | null,
  auth: AuthContext | null,
  record: Record<string, unknown> | null
): boolean {
  if (rule === null) return true;
  if (rule === "") return auth?.type === "admin";

  // Admins bypass all rules
  if (auth?.type === "admin") return true;

  const ast = parseExpression(rule);
  if (!ast) return false; // unparseable rule → deny

  try {
    return evaluateExpr(ast, auth, record ?? {});
  } catch {
    return false;
  }
}

/** True if a rule is set and would require an auth-context filter on list queries. */
export function isExpressionRule(rule: string | null): boolean {
  return rule !== null && rule !== "";
}

// ── AST evaluation ──────────────────────────────────────────────────────────

function evaluateExpr(
  ast: Expr,
  auth: AuthContext | null,
  record: Record<string, unknown>
): boolean {
  if (ast.kind === "and") return evaluateExpr(ast.left, auth, record) && evaluateExpr(ast.right, auth, record);
  if (ast.kind === "or")  return evaluateExpr(ast.left, auth, record) || evaluateExpr(ast.right, auth, record);

  const l = resolveOperand(ast.left, auth, record);
  const r = resolveOperand(ast.right, auth, record);

  switch (ast.op) {
    case "=":  return looseEq(l, r);
    case "!=": return !looseEq(l, r);
    case ">":  return cmp(l, r) > 0;
    case ">=": return cmp(l, r) >= 0;
    case "<":  return cmp(l, r) < 0;
    case "<=": return cmp(l, r) <= 0;
    case "~":  return String(l ?? "").includes(String(r ?? ""));
  }
}

function resolveOperand(
  op: Operand,
  auth: AuthContext | null,
  record: Record<string, unknown>
): unknown {
  if (op.kind === "literal") return op.value;
  if (op.kind === "auth") {
    if (!auth) return "";
    if (op.prop === "id") return auth.id;
    if (op.prop === "type") return auth.type;
    return auth.email ?? "";
  }
  // field
  if (op.name === "id")      return record["id"];
  if (op.name === "created" || op.name === "created_at") return record["created"];
  if (op.name === "updated" || op.name === "updated_at") return record["updated"];
  return record[op.name];
}

function looseEq(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined || b === "";
  if (b === null || b === undefined) return a === null || a === undefined || a === "";
  // Coerce bools to numbers for SQL parity (true=1, false=0)
  if (typeof a === "boolean") a = a ? 1 : 0;
  if (typeof b === "boolean") b = b ? 1 : 0;
  // String/number comparison: try numeric first
  if (typeof a === "number" || typeof b === "number") {
    return Number(a) === Number(b);
  }
  return String(a) === String(b);
}

function cmp(a: unknown, b: unknown): number {
  const na = typeof a === "boolean" ? (a ? 1 : 0) : Number(a);
  const nb = typeof b === "boolean" ? (b ? 1 : 0) : Number(b);
  if (!isNaN(na) && !isNaN(nb)) return na - nb;
  return String(a ?? "").localeCompare(String(b ?? ""));
}
