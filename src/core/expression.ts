/**
 * Expression parser for filters and access rules.
 *
 * Grammar:
 *   expr        := or
 *   or          := and ( '||' and )*
 *   and         := atom ( '&&' atom )*
 *   atom        := '(' or ')' | comparison
 *   comparison  := operand op operand
 *   operand     := authRef | requestRef | collectionRef | funcCall | macro | literal | field
 *   authRef     := '@request.auth.' ('id' | 'email' | 'type')
 *   requestRef  := '@request.' ('method' | 'context' | ('headers'|'query'|'body') '.' word)
 *   collectionRef := '@collection.' word (':' word)? '.' word ('.' word)*
 *   funcCall    := word '(' (operand (',' operand)*)? ')'
 *   macro       := '@now' | '@yesterday' | '@tomorrow' | '@todayStart' | ...
 *   field       := word ('.' word)* (':' modifier)?
 *   modifier    := 'isset' | 'changed' | 'length' | 'each' | 'lower'
 *   op          := '=' | '!=' | '>' | '>=' | '<' | '<=' | '~' | '!~'
 *               |  array-prefixed: '?=' | '?!=' | '?>' | '?>=' | '?<' | '?<=' | '?~' | '?!~'
 *
 * Compiles to an AST that the SQL filter compiler turns into parameterized
 * SQL and the in-process rule evaluator runs directly.
 *
 * Hardening:
 *   - Field / function names matched against allowlists; unknown → parse error
 *   - DoS guards: max operand count, max parse-recursion depth
 *   - Identifier shape validated; SQL injection blocked at compile time
 */

const MAX_OPERANDS = 50;
const MAX_DEPTH = 32;

export type CmpOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "~" | "!~";
/** "?=" / "?!=" / etc. — match-any-element-of-array semantics. */
export type ArrayCmpOp = `?${CmpOp}`;
export type AnyCmpOp = CmpOp | ArrayCmpOp;

export type FieldModifier = "isset" | "changed" | "length" | "each" | "lower";
export const FIELD_MODIFIERS: ReadonlySet<FieldModifier> = new Set([
  "isset", "changed", "length", "each", "lower",
]);

export type AuthProp = "id" | "email" | "type";
export type RequestProp = "method" | "context";
export type RequestMapKind = "headers" | "query" | "body";

export type Operand =
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "auth"; prop: AuthProp; modifier?: FieldModifier | undefined }
  | { kind: "request"; prop: RequestProp; modifier?: FieldModifier | undefined }
  | { kind: "requestMap"; mapKind: RequestMapKind; key: string; modifier?: FieldModifier | undefined }
  | { kind: "collection"; collection: string; alias?: string | undefined; path: string[]; modifier?: FieldModifier | undefined }
  | { kind: "field"; name: string; path: string[]; modifier?: FieldModifier | undefined }
  /**
   * Back-relation: `<targetCollection>_via_<refField>` — references the
   * collection that has a relation field pointing back at this collection.
   * Compiles to a subquery joining vb_<targetCollection> on `<refField> = <self>.id`.
   */
  | { kind: "viaRelation"; targetCollection: string; refField: string; path: string[]; modifier?: FieldModifier | undefined }
  | { kind: "macro"; name: string }
  | { kind: "func"; name: string; args: Operand[] };

export type Expr =
  | { kind: "cmp"; left: Operand; op: AnyCmpOp; right: Operand }
  | { kind: "and"; left: Expr; right: Expr }
  | { kind: "or"; left: Expr; right: Expr };

/** Two-character operators must be tried before their one-char prefixes. */
const OPERATORS: AnyCmpOp[] = [
  // array-prefix two-char first
  "?!=", "?>=", "?<=", "?!~", "?=", "?>", "?<", "?~",
  // scalar two-char
  "!=", ">=", "<=", "!~",
  // single-char
  ">", "<", "~", "=",
];

const ALLOWED_FUNCS: ReadonlySet<string> = new Set(["geoDistance", "strftime"]);

const ALLOWED_MACROS: ReadonlySet<string> = new Set([
  "now", "yesterday", "tomorrow",
  "todayStart", "todayEnd",
  "monthStart", "monthEnd",
  "yearStart", "yearEnd",
  "second", "minute", "hour",
  "day", "weekday", "month", "year",
]);

class TokenStream {
  pos = 0;
  /** Number of operands seen — used to cap rule complexity. */
  operandCount = 0;
  /** Recursion depth for `or`/`and`/`atom`. */
  depth = 0;
  constructor(public src: string) {}

  skipWs(): void {
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

  expect(s: string): void {
    if (!this.consume(s)) throw new Error(`Expected "${s}" at ${this.pos}`);
  }

  readWord(): string {
    this.skipWs();
    let w = "";
    while (this.pos < this.src.length && /[a-zA-Z0-9_]/.test(this.src[this.pos]!)) {
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

  readOperator(): AnyCmpOp {
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
  if (trimmed.length > 4096) return null;
  try {
    const ts = new TokenStream(trimmed);
    const expr = parseOr(ts);
    ts.skipWs();
    if (ts.pos !== ts.src.length) return null;
    return expr;
  } catch {
    return null;
  }
}

function pushDepth(ts: TokenStream): void {
  ts.depth++;
  if (ts.depth > MAX_DEPTH) throw new Error("expression too deeply nested");
}
function popDepth(ts: TokenStream): void { ts.depth--; }

function parseOr(ts: TokenStream): Expr {
  pushDepth(ts);
  let left = parseAnd(ts);
  while (ts.consume("||")) {
    const right = parseAnd(ts);
    left = { kind: "or", left, right };
  }
  popDepth(ts);
  return left;
}

function parseAnd(ts: TokenStream): Expr {
  pushDepth(ts);
  let left = parseAtom(ts);
  while (ts.consume("&&")) {
    const right = parseAtom(ts);
    left = { kind: "and", left, right };
  }
  popDepth(ts);
  return left;
}

function parseAtom(ts: TokenStream): Expr {
  pushDepth(ts);
  if (ts.consume("(")) {
    const inner = parseOr(ts);
    ts.expect(")");
    popDepth(ts);
    return inner;
  }
  const expr = parseComparison(ts);
  popDepth(ts);
  return expr;
}

function parseComparison(ts: TokenStream): Expr {
  const left = readOperand(ts);
  const op = ts.readOperator();
  const right = readOperand(ts);
  return { kind: "cmp", left, op, right };
}

function readOperand(ts: TokenStream): Operand {
  ts.operandCount++;
  if (ts.operandCount > MAX_OPERANDS) throw new Error("expression has too many operands");
  ts.skipWs();

  const ch = ts.peekChar();
  if (ch === "'" || ch === '"') {
    return { kind: "literal", value: ts.readQuotedString() };
  }

  // @-prefixed: auth, request, collection, macro
  if (ts.startsWith("@")) {
    return readAtRef(ts);
  }

  // Numeric / keyword / field. May be followed by a modifier (`:isset` etc.)
  // or a function call (`foo(...)`).
  const w = readDottedWord(ts);
  if (!w) throw new Error("Expected operand");

  // Function call?
  if (ts.peekChar() === "(") {
    if (!ALLOWED_FUNCS.has(w[0]!)) throw new Error(`unknown function: ${w[0]}`);
    ts.consume("(");
    const args: Operand[] = [];
    ts.skipWs();
    if (!ts.consume(")")) {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        args.push(readOperand(ts));
        if (ts.consume(",")) continue;
        ts.expect(")");
        break;
      }
    }
    return { kind: "func", name: w[0]!, args };
  }

  // Single-token literals
  if (w.length === 1) {
    const t = w[0]!;
    if (t === "true")  return { kind: "literal", value: true };
    if (t === "false") return { kind: "literal", value: false };
    if (t === "null")  return { kind: "literal", value: null };
    if (/^-?\d+(\.\d+)?$/.test(t)) return { kind: "literal", value: Number(t) };
  }

  const modifier = readOptionalModifier(ts);
  return makeFieldOperand(w, modifier);
}

/**
 * Read a dotted identifier sequence: `foo`, `foo.bar`, `foo.bar.baz`.
 * Returns segments as an array; first segment is the head, rest are the path.
 */
function readDottedWord(ts: TokenStream): string[] {
  const head = ts.readWord();
  if (!head) return [];
  const out: string[] = [head];
  while (ts.startsWith(".")) {
    // Don't consume `.` if it's actually part of a number (rare; numbers use literal path).
    ts.consume(".");
    const next = ts.readWord();
    if (!next) throw new Error("expected identifier after '.'");
    out.push(next);
  }
  return out;
}

/** Trailing `:modifier` after an operand. */
function readOptionalModifier(ts: TokenStream): FieldModifier | undefined {
  if (!ts.startsWith(":")) return undefined;
  ts.consume(":");
  const m = ts.readWord();
  if (!FIELD_MODIFIERS.has(m as FieldModifier)) {
    throw new Error(`unknown field modifier: ${m}`);
  }
  return m as FieldModifier;
}

function makeFieldOperand(parts: string[], modifier?: FieldModifier): Operand {
  const head = parts[0]!;
  const path = parts.slice(1);

  // Detect back-relation infix: `<targetCollection>_via_<refField>`.
  // Both names must match IDENT shape; reject empty / multi-`_via_`.
  const VIA = "_via_";
  const idx = head.indexOf(VIA);
  if (idx > 0 && head.indexOf(VIA, idx + VIA.length) === -1) {
    const targetCollection = head.slice(0, idx);
    const refField = head.slice(idx + VIA.length);
    if (
      targetCollection &&
      refField &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(targetCollection) &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(refField)
    ) {
      if (modifier) return { kind: "viaRelation", targetCollection, refField, path, modifier };
      return { kind: "viaRelation", targetCollection, refField, path };
    }
  }

  if (modifier) return { kind: "field", name: head, path, modifier };
  return { kind: "field", name: head, path };
}

function readAtRef(ts: TokenStream): Operand {
  // Already at `@` boundary
  if (ts.consume("@request.auth.")) {
    const prop = ts.readWord();
    if (prop !== "id" && prop !== "email" && prop !== "type") {
      throw new Error(`Unsupported auth prop: ${prop}`);
    }
    const modifier = readOptionalModifier(ts);
    if (modifier) return { kind: "auth", prop, modifier };
    return { kind: "auth", prop };
  }
  if (ts.consume("@request.headers.")) {
    const key = ts.readWord();
    if (!key) throw new Error("expected header name");
    const modifier = readOptionalModifier(ts);
    if (modifier) return { kind: "requestMap", mapKind: "headers", key, modifier };
    return { kind: "requestMap", mapKind: "headers", key };
  }
  if (ts.consume("@request.query.")) {
    const key = ts.readWord();
    if (!key) throw new Error("expected query key");
    const modifier = readOptionalModifier(ts);
    if (modifier) return { kind: "requestMap", mapKind: "query", key, modifier };
    return { kind: "requestMap", mapKind: "query", key };
  }
  if (ts.consume("@request.body.")) {
    const key = ts.readWord();
    if (!key) throw new Error("expected body key");
    const modifier = readOptionalModifier(ts);
    if (modifier) return { kind: "requestMap", mapKind: "body", key, modifier };
    return { kind: "requestMap", mapKind: "body", key };
  }
  if (ts.consume("@request.method")) {
    const modifier = readOptionalModifier(ts);
    if (modifier) return { kind: "request", prop: "method", modifier };
    return { kind: "request", prop: "method" };
  }
  if (ts.consume("@request.context")) {
    const modifier = readOptionalModifier(ts);
    if (modifier) return { kind: "request", prop: "context", modifier };
    return { kind: "request", prop: "context" };
  }
  if (ts.consume("@collection.")) {
    const collection = ts.readWord();
    if (!collection) throw new Error("expected collection name");
    let alias: string | undefined;
    if (ts.startsWith(":")) {
      ts.consume(":");
      alias = ts.readWord();
      if (!alias) throw new Error("expected alias after ':'");
    }
    const fieldParts: string[] = [];
    while (ts.startsWith(".")) {
      ts.consume(".");
      const w = ts.readWord();
      if (!w) throw new Error("expected field after '.'");
      fieldParts.push(w);
    }
    if (fieldParts.length === 0) throw new Error("@collection.* requires a field");
    const modifier = readOptionalModifier(ts);
    return alias
      ? (modifier
          ? { kind: "collection", collection, alias, path: fieldParts, modifier }
          : { kind: "collection", collection, alias, path: fieldParts })
      : (modifier
          ? { kind: "collection", collection, path: fieldParts, modifier }
          : { kind: "collection", collection, path: fieldParts });
  }
  // Datetime macros
  if (ts.consume("@")) {
    const name = ts.readWord();
    if (!ALLOWED_MACROS.has(name)) throw new Error(`unknown macro: @${name}`);
    return { kind: "macro", name };
  }
  throw new Error("expected @-reference");
}
