/**
 * SQL in this code base is written with `?` placeholders. Postgres wants
 * `$1`, `$2`, …: this rewrites a statement once (the result is cached per
 * statement text) while skipping string literals, quoted identifiers,
 * comments and dollar-quoted strings, where a `?` means nothing.
 */
const cache = new Map<string, string>();
const CACHE_MAX = 1024;

export function toPositional(sql: string): string {
  const hit = cache.get(sql);
  if (hit !== undefined) return hit;
  let out = "";
  let n = 0;
  const len = sql.length;
  for (let i = 0; i < len; i++) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      // A quoted string or identifier; a doubled quote is an escaped quote.
      let j = i + 1;
      while (j < len) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j += 2; continue; }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j;
    } else if (ch === "-" && sql[i + 1] === "-") {
      const j = sql.indexOf("\n", i);
      const end = j < 0 ? len : j;
      out += sql.slice(i, end);
      i = end - 1;
    } else if (ch === "/" && sql[i + 1] === "*") {
      const j = sql.indexOf("*/", i + 2);
      const end = j < 0 ? len : j + 2;
      out += sql.slice(i, end);
      i = end - 1;
    } else if (ch === "$" && sql[i + 1] === "$") {
      const j = sql.indexOf("$$", i + 2);
      const end = j < 0 ? len : j + 2;
      out += sql.slice(i, end);
      i = end - 1;
    } else if (ch === "?") {
      out += `$${++n}`;
    } else {
      out += ch;
    }
  }
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(sql, out);
  return out;
}
