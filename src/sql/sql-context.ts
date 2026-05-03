/**
 * Cursor-context detection for SQL completion.
 *
 * Walks tokens up to the cursor and returns one of:
 *
 *   { kind: "afterDot", base }         the cursor is at `<base>.|` →
 *                                      caller resolves <base> to a table
 *                                      (or alias) and returns its columns.
 *   { kind: "expectTable" }            after FROM, JOIN, INTO, UPDATE, …
 *                                      → table names.
 *   { kind: "expectColumn" }           inside SELECT / WHERE / ON / ORDER
 *                                      BY / GROUP BY / HAVING / SET → cols
 *                                      from every table currently in
 *                                      scope (FROM/JOIN list).
 *   { kind: "expectAny" }              fallback / unknown — broad set
 *                                      (keywords + tables + functions).
 *
 * Heuristic, not parser-perfect. Walks BACKWARD from the cursor token
 * until it hits a context-defining keyword. Skips parens contents (we
 * don't need to be smart about subqueries — the surrounding context
 * still applies). Strings + comments are pre-filtered by callers.
 */

import { meaningful, tokenize, tokenAtOffset, unquoteIdent, type SqlToken } from "./sql-tokenizer.ts";

export type SqlContext =
  | { kind: "afterDot"; base: string }
  | { kind: "expectTable" }
  | { kind: "expectColumn" }
  | { kind: "expectAny" };

/** Keywords that start a "table-expecting" clause. */
const TABLE_KWS = new Set(["FROM", "JOIN", "INTO", "UPDATE", "TABLE", "VIEW", "INDEX"]);
/** Keywords that start a "column-expecting" clause. */
const COLUMN_KWS = new Set([
  "SELECT", "WHERE", "ON", "ORDER", "GROUP", "HAVING", "SET", "BY", "AND", "OR",
  "RETURNING", "USING", "VALUES",
]);

export interface AnalyzeOpts {
  /** Source SQL string. */
  src: string;
  /** Caret offset within `src` (0-based). */
  offset: number;
  /** Optional pre-tokenised input — saves work in hot paths. */
  tokens?: SqlToken[];
}

/** True iff `ch` would be part of an identifier. */
function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

/**
 * Inspect the cursor context. Returns the lexical position and (when
 * applicable) the partial-word prefix the user is typing.
 */
export function analyzeContext(opts: AnalyzeOpts): {
  context: SqlContext;
  /** The currently-typed prefix (may be empty). Useful for filtering. */
  prefix: string;
  /** Source range that the prefix occupies (for replacement). */
  prefixStart: number;
} {
  const { src, offset } = opts;
  const tokens = opts.tokens ?? meaningful(tokenize(src));

  // Inside string literal? Caller usually skips completion in that case.
  // We emit "expectAny" so the editor's UI knows nothing useful is here.
  // (We deliberately don't filter out string positions here — the
  // tokenizer already returns the string token verbatim and analyzeContext
  // ignores token text, only token roles.)

  // Determine the prefix the user is typing (if any).
  let prefix = "";
  let prefixStart = offset;
  if (offset > 0 && isIdentChar(src[offset - 1] ?? "")) {
    let s = offset;
    while (s > 0 && isIdentChar(src[s - 1] ?? "")) s--;
    prefix = src.slice(s, offset);
    prefixStart = s;
  }

  // After-dot? Look back: the char immediately before the prefix should be `.`,
  // and before THAT should be an identifier (or quoted ident).
  const beforePrefix = prefixStart - 1;
  if (beforePrefix >= 0 && src[beforePrefix] === ".") {
    let baseEnd = beforePrefix;
    let baseStart = baseEnd;
    if (baseStart > 0 && (src[baseStart - 1] === '"' || src[baseStart - 1] === "]" || src[baseStart - 1] === "`")) {
      // Quoted identifier — walk backward to matching opener.
      const openCh = src[baseStart - 1] === '"' ? '"' : src[baseStart - 1] === "]" ? "[" : "`";
      baseStart -= 1;
      while (baseStart > 0 && src[baseStart - 1] !== openCh) baseStart--;
      if (baseStart > 0) baseStart -= 1; // step over opener
    } else {
      while (baseStart > 0 && isIdentChar(src[baseStart - 1] ?? "")) baseStart--;
    }
    const base = unquoteIdent(src.slice(baseStart, baseEnd));
    if (base) return {
      context: { kind: "afterDot", base },
      prefix, prefixStart,
    };
  }

  // Walk meaningful tokens BEFORE the cursor, find the most recent
  // context-defining keyword that isn't inside a paren depth that opened
  // after it. We collapse parens by tracking depth as we scan backward.
  let depth = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]!;
    // Tokens at or after the prefix don't count.
    if (t.start >= prefixStart) continue;
    if (t.type === "punct") {
      if (t.text === ")") depth++;
      else if (t.text === "(") depth = Math.max(0, depth - 1);
      // Comma at depth 0 means we're listing items — stay in current ctx.
      continue;
    }
    if (t.type !== "ident") continue;
    const upper = t.text.toUpperCase();
    if (TABLE_KWS.has(upper) && depth === 0) {
      return { context: { kind: "expectTable" }, prefix, prefixStart };
    }
    if (COLUMN_KWS.has(upper) && depth === 0) {
      return { context: { kind: "expectColumn" }, prefix, prefixStart };
    }
  }

  return { context: { kind: "expectAny" }, prefix, prefixStart };
}

/**
 * Walk the SQL and build a `{alias|tableName: tableName}` map of every
 * table referenced in FROM / JOIN / UPDATE / INTO clauses.
 *
 * Patterns recognised:
 *
 *   FROM users              → users → users
 *   FROM users u            → u → users, users → users
 *   FROM users AS u         → u → users, users → users
 *   FROM "long name" ln     → ln → "long name", "long name" → "long name"
 *   FROM users u, orders o  → u → users, o → orders
 *
 * Subqueries (`FROM (SELECT …) sub`) skip the inner SELECT and bind the
 * subquery's alias to itself with no underlying table.
 */
export function buildAliasMap(src: string, tokens?: SqlToken[]): Map<string, string> {
  const out = new Map<string, string>();
  const toks = tokens ?? meaningful(tokenize(src));
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.type !== "ident") continue;
    const upper = t.text.toUpperCase();
    if (upper !== "FROM" && upper !== "JOIN" && upper !== "INTO" && upper !== "UPDATE") continue;

    // Read table reference(s) until we hit a non-comma terminator.
    let j = i + 1;
    while (j < toks.length) {
      const tk = toks[j]!;
      if (tk.type === "punct" && tk.text === "(") {
        // Subquery — skip until balanced close paren.
        let depth = 1;
        j++;
        while (j < toks.length && depth > 0) {
          const x = toks[j]!;
          if (x.type === "punct" && x.text === "(") depth++;
          else if (x.type === "punct" && x.text === ")") depth--;
          j++;
        }
        // Optional alias right after.
        if (j < toks.length) {
          const alias = optionalAlias(toks, j);
          if (alias) {
            out.set(alias.name, alias.name);
            j = alias.next;
          }
        }
      } else if (tk.type === "ident") {
        const upper2 = tk.text.toUpperCase();
        // Stop on next clause-starting keyword.
        if (CLAUSE_TERMINATORS.has(upper2) && j > i + 1) break;
        const tableName = unquoteIdent(tk.text);
        out.set(tableName, tableName);
        j++;
        // Optional AS / bare alias.
        if (j < toks.length) {
          const alias = optionalAlias(toks, j);
          if (alias) {
            out.set(alias.name, tableName);
            j = alias.next;
          }
        }
      } else {
        break;
      }
      // Continue past commas (multi-table FROM list).
      if (j < toks.length && toks[j]!.type === "punct" && toks[j]!.text === ",") {
        j++;
        continue;
      }
      break;
    }
    i = j - 1;
  }
  return out;
}

const CLAUSE_TERMINATORS = new Set([
  "WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "JOIN", "ON", "USING",
  "UNION", "INTERSECT", "EXCEPT", "RETURNING", "VALUES", "SET",
  // Joins (LEFT/RIGHT/FULL/INNER/CROSS/NATURAL JOIN are all opened by JOIN
  // when scanning forward — these stop a FROM table list cleanly).
  "LEFT", "RIGHT", "FULL", "INNER", "CROSS", "NATURAL",
]);

function optionalAlias(toks: SqlToken[], idx: number): { name: string; next: number } | null {
  let j = idx;
  if (j >= toks.length) return null;
  const tk = toks[j]!;
  if (tk.type === "ident" && tk.text.toUpperCase() === "AS") {
    j++;
    if (j >= toks.length || toks[j]!.type !== "ident") return null;
    return { name: unquoteIdent(toks[j]!.text), next: j + 1 };
  }
  // Bare alias — only when next ident isn't a clause terminator + not a kw.
  if (tk.type === "ident") {
    const upper = tk.text.toUpperCase();
    if (CLAUSE_TERMINATORS.has(upper)) return null;
    if (BARE_ALIAS_NEVER.has(upper)) return null;
    return { name: unquoteIdent(tk.text), next: j + 1 };
  }
  return null;
}

/** Common SQL keywords that should never be misread as a bare alias. */
const BARE_ALIAS_NEVER = new Set([
  "ON", "USING", "WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET",
  "VALUES", "SET", "INNER", "OUTER", "LEFT", "RIGHT", "FULL", "CROSS",
  "NATURAL", "JOIN", "AND", "OR", "NOT", "WITH", "RECURSIVE", "UNION",
  "INTERSECT", "EXCEPT", "PRIMARY", "FOREIGN", "REFERENCES", "RETURNING",
]);
