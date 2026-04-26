import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { records } from "../db/schema.ts";
import type { AuthContext } from "./rules.ts";
import type { Expr, Operand } from "./expression.ts";
import { parseExpression } from "./expression.ts";

/**
 * Parse a filter expression and compile to a Drizzle SQL condition.
 *
 * @param expr filter string, e.g. "title = 'hello' && (status = 'active' || age >= 18)"
 * @param auth optional auth context for substituting @request.auth.X references
 *
 * Returns undefined if the expression is empty or malformed.
 */
export function parseFilter(
  expr: string,
  auth?: AuthContext | null
): SQL<unknown> | undefined {
  const ast = parseExpression(expr);
  if (!ast) return undefined;
  return compileToSql(ast, auth ?? null);
}

export function compileToSql(ast: Expr, auth: AuthContext | null): SQL<unknown> {
  if (ast.kind === "and") {
    return sql`(${compileToSql(ast.left, auth)} AND ${compileToSql(ast.right, auth)})`;
  }
  if (ast.kind === "or") {
    return sql`(${compileToSql(ast.left, auth)} OR ${compileToSql(ast.right, auth)})`;
  }
  // cmp
  const left = compileOperand(ast.left, auth);
  const right = compileOperand(ast.right, auth);

  // Handle null comparisons specially
  if (ast.right.kind === "literal" && ast.right.value === null) {
    if (ast.op === "=")  return sql`${left} IS NULL`;
    if (ast.op === "!=") return sql`${left} IS NOT NULL`;
  }
  if (ast.left.kind === "literal" && ast.left.value === null) {
    if (ast.op === "=")  return sql`${right} IS NULL`;
    if (ast.op === "!=") return sql`${right} IS NOT NULL`;
  }

  switch (ast.op) {
    case "=":  return sql`${left} = ${right}`;
    case "!=": return sql`${left} != ${right}`;
    case ">":  return sql`${left} > ${right}`;
    case ">=": return sql`${left} >= ${right}`;
    case "<":  return sql`${left} < ${right}`;
    case "<=": return sql`${left} <= ${right}`;
    case "~":  return sql`${left} LIKE ${rightLikePattern(ast.right, auth)}`;
  }
}

function compileOperand(op: Operand, auth: AuthContext | null): SQL<unknown> {
  if (op.kind === "literal") {
    const v = coerceLiteral(op.value);
    return sql`${v}`;
  }
  if (op.kind === "auth") {
    const v = auth ? authValue(auth, op.prop) : "";
    return sql`${v}`;
  }
  // field
  if (op.name === "id")      return sql`${records.id}`;
  if (op.name === "created" || op.name === "created_at") return sql`${records.created_at}`;
  if (op.name === "updated" || op.name === "updated_at") return sql`${records.updated_at}`;
  return sql`JSON_EXTRACT(${records.data}, ${`$.${op.name}`})`;
}

function rightLikePattern(op: Operand, auth: AuthContext | null): string {
  if (op.kind === "literal") return `%${String(op.value)}%`;
  if (op.kind === "auth") return `%${authValue(auth!, op.prop)}%`;
  return `%${op.name}%`;
}

function authValue(auth: AuthContext, prop: "id" | "email" | "type"): string {
  if (prop === "id") return auth.id;
  if (prop === "type") return auth.type;
  return auth.email ?? "";
}

function coerceLiteral(v: string | number | boolean | null): string | number {
  if (v === true)  return 1;
  if (v === false) return 0;
  if (v === null)  return ""; // nulls handled above as IS [NOT] NULL
  return v;
}
