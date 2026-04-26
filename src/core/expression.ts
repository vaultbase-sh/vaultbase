/**
 * Expression parser for filters and access rules.
 * Produces an AST that can be compiled to SQL (for list/filter)
 * or evaluated in JS (for single-record rule checks).
 *
 * Grammar:
 *   expr     := or
 *   or       := and ( '||' and )*
 *   and      := atom ( '&&' atom )*
 *   atom     := '(' or ')' | comparison
 *   comparison := operand op operand
 *   operand  := authRef | literal | field
 *   authRef  := '@request.auth.' ('id' | 'email' | 'type')
 *   literal  := quoted-string | number | 'true' | 'false' | 'null'
 *   field    := word (id | created | updated | any.json.path)
 *   op       := '=' | '!=' | '>' | '>=' | '<' | '<=' | '~'
 */

export type CmpOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "~";

export type Operand =
  | { kind: "field"; name: string }
  | { kind: "auth"; prop: "id" | "email" | "type" }
  | { kind: "literal"; value: string | number | boolean | null };

export type Expr =
  | { kind: "cmp"; left: Operand; op: CmpOp; right: Operand }
  | { kind: "and"; left: Expr; right: Expr }
  | { kind: "or"; left: Expr; right: Expr };

const OPERATORS: CmpOp[] = ["!=", ">=", "<=", ">", "<", "~", "="];

class TokenStream {
  pos = 0;
  constructor(public src: string) {}

  skipWs() {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos]!)) this.pos++;
  }

  startsWith(s: string): boolean {
    this.skipWs();
    return this.src.startsWith(s, this.pos);
  }

  consume(s: string): boolean {
    this.skipWs();
    if (this.src.startsWith(s, this.pos)) { this.pos += s.length; return true; }
    return false;
  }

  expect(s: string) {
    if (!this.consume(s)) throw new Error(`Expected "${s}" at ${this.pos}`);
  }

  readWord(): string {
    this.skipWs();
    let w = "";
    while (this.pos < this.src.length && /[a-zA-Z0-9_.@-]/.test(this.src[this.pos]!)) {
      w += this.src[this.pos++];
    }
    return w;
  }

  readQuotedString(): string {
    this.skipWs();
    const quote = this.src[this.pos];
    if (quote !== "'" && quote !== '"') throw new Error("Expected quoted string");
    this.pos++;
    let s = "";
    while (this.pos < this.src.length && this.src[this.pos] !== quote) {
      if (this.src[this.pos] === "\\" && this.src[this.pos + 1] === quote) {
        s += quote; this.pos += 2;
      } else {
        s += this.src[this.pos++];
      }
    }
    this.pos++;
    return s;
  }

  readOperator(): CmpOp {
    this.skipWs();
    for (const op of OPERATORS) {
      if (this.src.startsWith(op, this.pos)) { this.pos += op.length; return op; }
    }
    throw new Error(`Unknown operator at ${this.pos}`);
  }

  peekChar(): string {
    this.skipWs();
    return this.src[this.pos] ?? "";
  }
}

export function parseExpression(input: string): Expr | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const ts = new TokenStream(trimmed);
    const expr = parseOr(ts);
    ts.skipWs();
    if (ts.pos !== ts.src.length) return null; // trailing garbage
    return expr;
  } catch {
    return null;
  }
}

function parseOr(ts: TokenStream): Expr {
  let left = parseAnd(ts);
  while (ts.consume("||")) {
    const right = parseAnd(ts);
    left = { kind: "or", left, right };
  }
  return left;
}

function parseAnd(ts: TokenStream): Expr {
  let left = parseAtom(ts);
  while (ts.consume("&&")) {
    const right = parseAtom(ts);
    left = { kind: "and", left, right };
  }
  return left;
}

function parseAtom(ts: TokenStream): Expr {
  if (ts.consume("(")) {
    const inner = parseOr(ts);
    ts.expect(")");
    return inner;
  }
  return parseComparison(ts);
}

function parseComparison(ts: TokenStream): Expr {
  const left = readOperand(ts);
  const op = ts.readOperator();
  const right = readOperand(ts);
  return { kind: "cmp", left, op, right };
}

function readOperand(ts: TokenStream): Operand {
  ts.skipWs();

  // Quoted string literal (single or double quotes)
  const ch = ts.peekChar();
  if (ch === "'" || ch === '"') {
    return { kind: "literal", value: ts.readQuotedString() };
  }

  // Auth ref
  if (ts.startsWith("@request.auth.")) {
    ts.consume("@request.auth.");
    const prop = ts.readWord();
    if (prop !== "id" && prop !== "email" && prop !== "type") {
      throw new Error(`Unsupported auth prop: ${prop}`);
    }
    return { kind: "auth", prop };
  }

  // Word: literal keyword, number, or field name
  const w = ts.readWord();
  if (!w) throw new Error("Expected operand");
  if (w === "true")  return { kind: "literal", value: true };
  if (w === "false") return { kind: "literal", value: false };
  if (w === "null")  return { kind: "literal", value: null };
  if (/^-?\d+(\.\d+)?$/.test(w)) return { kind: "literal", value: Number(w) };
  return { kind: "field", name: w };
}
