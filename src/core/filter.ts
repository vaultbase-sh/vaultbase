import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { records } from "../db/schema.ts";

/**
 * Parse PocketBase-style filter expression into a Drizzle SQL condition.
 * Supports: =, !=, >, >=, <, <=, ~  (~ = LIKE contains)
 * Supports: && (AND), || (OR), parentheses
 * Fields: id, created, updated, or any JSON data field
 *
 * Examples:
 *   title = 'hello'
 *   age > 18 && published = true
 *   (status = 'active' || status = 'pending') && age >= 21
 *   title ~ 'search term'
 */
export function parseFilter(expr: string): SQL<unknown> | undefined {
  const trimmed = expr.trim();
  if (!trimmed) return undefined;
  try {
    return parseOr(new TokenStream(trimmed));
  } catch {
    return undefined;
  }
}

// ── Tokenizer ────────────────────────────────────────────────────────────────

const OPERATORS = ["!=", ">=", "<=", ">", "<", "~", "="];

class TokenStream {
  private pos = 0;
  constructor(private src: string) {}

  private skipWs() {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos++;
  }

  peek(): string {
    this.skipWs();
    return this.src[this.pos] ?? "";
  }

  readWord(): string {
    this.skipWs();
    let word = "";
    while (this.pos < this.src.length && /[a-zA-Z0-9_.@-]/.test(this.src[this.pos]!)) {
      word += this.src[this.pos++];
    }
    return word;
  }

  readOperator(): string {
    this.skipWs();
    for (const op of OPERATORS) {
      if (this.src.startsWith(op, this.pos)) {
        this.pos += op.length;
        return op;
      }
    }
    throw new Error(`Unknown operator at ${this.pos}`);
  }

  readValue(): string {
    this.skipWs();
    if (this.src[this.pos] === "'") {
      this.pos++;
      let val = "";
      while (this.pos < this.src.length && this.src[this.pos] !== "'") {
        if (this.src[this.pos] === "\\" && this.src[this.pos + 1] === "'") {
          val += "'"; this.pos += 2;
        } else {
          val += this.src[this.pos++];
        }
      }
      this.pos++; // closing quote
      return val;
    }
    return this.readWord();
  }

  consume(str: string): boolean {
    this.skipWs();
    if (this.src.startsWith(str, this.pos)) {
      this.pos += str.length;
      return true;
    }
    return false;
  }

  expect(str: string) {
    if (!this.consume(str)) throw new Error(`Expected "${str}" at ${this.pos}`);
  }
}

// ── Parser ───────────────────────────────────────────────────────────────────

function parseOr(ts: TokenStream): SQL<unknown> {
  let left = parseAnd(ts);
  while (ts.consume("||")) {
    const right = parseAnd(ts);
    left = sql`(${left} OR ${right})`;
  }
  return left;
}

function parseAnd(ts: TokenStream): SQL<unknown> {
  let left = parseAtom(ts);
  while (ts.consume("&&")) {
    const right = parseAtom(ts);
    left = sql`(${left} AND ${right})`;
  }
  return left;
}

function parseAtom(ts: TokenStream): SQL<unknown> {
  if (ts.consume("(")) {
    const inner = parseOr(ts);
    ts.expect(")");
    return inner;
  }
  return parseComparison(ts);
}

function parseComparison(ts: TokenStream): SQL<unknown> {
  const field = ts.readWord();
  const op = ts.readOperator();
  const rawVal = ts.readValue();
  const val = coerce(rawVal);
  const colExpr = fieldToExpr(field);

  if (val === null) {
    if (op === "=")  return sql`${colExpr} IS NULL`;
    if (op === "!=") return sql`${colExpr} IS NOT NULL`;
  }

  switch (op) {
    case "=":  return sql`${colExpr} = ${val}`;
    case "!=": return sql`${colExpr} != ${val}`;
    case ">":  return sql`${colExpr} > ${val}`;
    case ">=": return sql`${colExpr} >= ${val}`;
    case "<":  return sql`${colExpr} < ${val}`;
    case "<=": return sql`${colExpr} <= ${val}`;
    case "~":  return sql`${colExpr} LIKE ${"%" + String(val) + "%"}`;
    default:   throw new Error(`Unsupported op: ${op}`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fieldToExpr(field: string): SQL<unknown> {
  if (field === "id")      return sql`${records.id}`;
  if (field === "created" || field === "created_at") return sql`${records.created_at}`;
  if (field === "updated" || field === "updated_at") return sql`${records.updated_at}`;
  return sql`JSON_EXTRACT(${records.data}, ${`$.${field}`})`;
}

function coerce(raw: string): unknown {
  if (raw === "true")  return 1;
  if (raw === "false") return 0;
  if (raw === "null")  return null;
  const num = Number(raw);
  if (!isNaN(num) && raw !== "") return num;
  return raw;
}
