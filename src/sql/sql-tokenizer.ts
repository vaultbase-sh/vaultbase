/**
 * Hand-rolled SQLite tokenizer. Just enough to drive context-aware
 * completion + alias resolution.
 *
 * Tokens we care about:
 *   - identifiers   (`name`, `"qu""oted"`, `[bracketed]`, `` `backtick` ``)
 *   - keywords      (uppercased identifiers that match SQL_KEYWORDS — but
 *                   we treat keywords-as-identifiers in the AST loop, so
 *                   the consumer normalises by case)
 *   - numbers
 *   - strings       ('text', x'cafe')
 *   - punctuation   ( ) , ; . * = < > <= >= != etc.
 *   - comments      -- line ... and ⁄* block *⁄ (skipped, tracked as type)
 *   - whitespace    (skipped)
 *
 * We don't need full lexical correctness — pathological inputs (escaped
 * quotes inside CTEs inside views) should at worst produce a noisier
 * autocomplete, never crash the editor.
 */

export type SqlTokenType =
  | "ident"        // raw identifier (caller normalises to keyword if applicable)
  | "string"       // 'text' / x'cafe'
  | "number"
  | "punct"        // single-char punctuation . , ; ( ) * etc.
  | "op"           // multi-char operator (>=, <=, !=, ||, ->, ->>)
  | "comment"
  | "whitespace";

export interface SqlToken {
  type: SqlTokenType;
  /** Raw lexeme as it appeared in source. */
  text: string;
  /** 0-based offset into the source string. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

const PUNCT = new Set("().,;*+-/%~");
const OP_STARTS = new Set("<>!=|-?");

export function tokenize(src: string): SqlToken[] {
  const out: SqlToken[] = [];
  const n = src.length;
  let i = 0;

  while (i < n) {
    const ch = src[i]!;

    // Whitespace.
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      const start = i;
      while (i < n && /\s/.test(src[i]!)) i++;
      out.push({ type: "whitespace", text: src.slice(start, i), start, end: i });
      continue;
    }

    // Line comment.
    if (ch === "-" && src[i + 1] === "-") {
      const start = i;
      i += 2;
      while (i < n && src[i] !== "\n") i++;
      out.push({ type: "comment", text: src.slice(start, i), start, end: i });
      continue;
    }

    // Block comment.
    if (ch === "/" && src[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < n - 1 && !(src[i] === "*" && src[i + 1] === "/")) i++;
      if (i < n - 1) i += 2; else i = n;
      out.push({ type: "comment", text: src.slice(start, i), start, end: i });
      continue;
    }

    // String literal — single quote (with '' escape).
    if (ch === "'") {
      const start = i++;
      while (i < n) {
        if (src[i] === "'" && src[i + 1] === "'") { i += 2; continue; }
        if (src[i] === "'") { i++; break; }
        i++;
      }
      out.push({ type: "string", text: src.slice(start, i), start, end: i });
      continue;
    }

    // Hex blob literal — x'CAFE'.
    if ((ch === "x" || ch === "X") && src[i + 1] === "'") {
      const start = i;
      i += 2;
      while (i < n && src[i] !== "'") i++;
      if (i < n) i++;
      out.push({ type: "string", text: src.slice(start, i), start, end: i });
      continue;
    }

    // Double-quoted identifier (with "" escape).
    if (ch === '"') {
      const start = i++;
      while (i < n) {
        if (src[i] === '"' && src[i + 1] === '"') { i += 2; continue; }
        if (src[i] === '"') { i++; break; }
        i++;
      }
      out.push({ type: "ident", text: src.slice(start, i), start, end: i });
      continue;
    }

    // Backtick / bracket identifier — non-standard but supported by SQLite.
    if (ch === "`") {
      const start = i++;
      while (i < n && src[i] !== "`") i++;
      if (i < n) i++;
      out.push({ type: "ident", text: src.slice(start, i), start, end: i });
      continue;
    }
    if (ch === "[") {
      const start = i++;
      while (i < n && src[i] !== "]") i++;
      if (i < n) i++;
      out.push({ type: "ident", text: src.slice(start, i), start, end: i });
      continue;
    }

    // Number — integer or REAL literal.
    if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < n && /[0-9_]/.test(src[i]!)) i++;
      if (src[i] === ".") {
        i++;
        while (i < n && /[0-9_]/.test(src[i]!)) i++;
      }
      if (src[i] === "e" || src[i] === "E") {
        i++;
        if (src[i] === "+" || src[i] === "-") i++;
        while (i < n && /[0-9]/.test(src[i]!)) i++;
      }
      out.push({ type: "number", text: src.slice(start, i), start, end: i });
      continue;
    }

    // Identifier (and keyword — caller decides via case-insensitive lookup).
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_$]/.test(src[i]!)) i++;
      out.push({ type: "ident", text: src.slice(start, i), start, end: i });
      continue;
    }

    // Multi-char operators: <= >= != <> || -> ->>.
    if (OP_STARTS.has(ch)) {
      const start = i;
      i++;
      while (i < n && OP_STARTS.has(src[i]!)) i++;
      out.push({ type: "op", text: src.slice(start, i), start, end: i });
      continue;
    }

    // Single-char punctuation.
    if (PUNCT.has(ch)) {
      out.push({ type: "punct", text: ch, start: i, end: i + 1 });
      i++;
      continue;
    }

    // Unknown — skip a char so we make progress.
    i++;
  }

  return out;
}

/**
 * Strip `whitespace` + `comment` tokens. Convenience for context analysis,
 * which doesn't care about layout.
 */
export function meaningful(tokens: SqlToken[]): SqlToken[] {
  return tokens.filter((t) => t.type !== "whitespace" && t.type !== "comment");
}

/**
 * Strip the surrounding quote chars (`"…"`, `[…]`, `` `…` ``) from an
 * identifier lexeme. Returns the inner text with `""` un-escaped.
 */
export function unquoteIdent(text: string): string {
  if (!text) return text;
  const first = text[0]!;
  if (first === '"' && text.endsWith('"')) {
    return text.slice(1, -1).split('""').join('"');
  }
  if (first === "[" && text.endsWith("]")) return text.slice(1, -1);
  if (first === "`" && text.endsWith("`")) return text.slice(1, -1);
  return text;
}

/**
 * Find the index of the token whose span contains (or ends at) `offset`.
 * Returns -1 if before the first token; tokens.length if past the last.
 */
export function tokenAtOffset(tokens: SqlToken[], offset: number): number {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (offset <= t.end) return i;
  }
  return tokens.length;
}
