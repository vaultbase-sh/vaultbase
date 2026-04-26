import type { AuthContext } from "./rules.ts";
import type { Expr, Operand } from "./expression.ts";
import { parseExpression } from "./expression.ts";

/** Compiled SQL fragment + bound parameters. */
export interface CompiledSql {
  sql: string;
  params: unknown[];
}

/**
 * Parse a filter expression and compile to a SQL fragment for the given table.
 * @param expr  expression string
 * @param tableName  unquoted table name (e.g. "vb_posts")
 * @param auth  optional auth context for @request.auth.* substitution
 * Returns null if the expression is empty or malformed.
 */
export function parseFilter(
  expr: string,
  tableName: string,
  auth?: AuthContext | null
): CompiledSql | null {
  const ast = parseExpression(expr);
  if (!ast) return null;
  return compileToSql(ast, tableName, auth ?? null);
}

export function compileToSql(
  ast: Expr,
  tableName: string,
  auth: AuthContext | null
): CompiledSql {
  const params: unknown[] = [];
  const sql = compileNode(ast, tableName, auth, params);
  return { sql, params };
}

function compileNode(
  ast: Expr,
  tableName: string,
  auth: AuthContext | null,
  params: unknown[]
): string {
  if (ast.kind === "and") {
    return `(${compileNode(ast.left, tableName, auth, params)} AND ${compileNode(ast.right, tableName, auth, params)})`;
  }
  if (ast.kind === "or") {
    return `(${compileNode(ast.left, tableName, auth, params)} OR ${compileNode(ast.right, tableName, auth, params)})`;
  }

  // Comparison
  // Handle null comparisons specially
  if (ast.right.kind === "literal" && ast.right.value === null) {
    const left = compileOperand(ast.left, tableName, auth, params);
    if (ast.op === "=")  return `${left} IS NULL`;
    if (ast.op === "!=") return `${left} IS NOT NULL`;
  }
  if (ast.left.kind === "literal" && ast.left.value === null) {
    const right = compileOperand(ast.right, tableName, auth, params);
    if (ast.op === "=")  return `${right} IS NULL`;
    if (ast.op === "!=") return `${right} IS NOT NULL`;
  }

  const left = compileOperand(ast.left, tableName, auth, params);
  if (ast.op === "~") {
    // LIKE pattern: wrap right side with %...%
    const v = operandValue(ast.right, auth);
    params.push(`%${String(v ?? "")}%`);
    return `${left} LIKE ?`;
  }
  const right = compileOperand(ast.right, tableName, auth, params);
  return `${left} ${ast.op} ${right}`;
}

function compileOperand(
  op: Operand,
  tableName: string,
  auth: AuthContext | null,
  params: unknown[]
): string {
  if (op.kind === "literal") {
    params.push(coerceLiteral(op.value));
    return "?";
  }
  if (op.kind === "auth") {
    params.push(auth ? authValue(auth, op.prop) : "");
    return "?";
  }
  // field → quoted column on the table
  return `"${tableName}"."${op.name}"`;
}

function operandValue(op: Operand, auth: AuthContext | null): unknown {
  if (op.kind === "literal") return coerceLiteral(op.value);
  if (op.kind === "auth") return auth ? authValue(auth, op.prop) : "";
  return null;
}

function authValue(auth: AuthContext, prop: "id" | "email" | "type"): string {
  if (prop === "id") return auth.id;
  if (prop === "type") return auth.type;
  return auth.email ?? "";
}

function coerceLiteral(v: string | number | boolean | null): string | number | null {
  if (v === true) return 1;
  if (v === false) return 0;
  if (v === null) return null;
  return v;
}
