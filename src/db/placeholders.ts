/**
 * SQL in this code base is written with `?` placeholders. Postgres wants
 * `$1`, `$2`, …: this rewrites a statement once (the result is cached per
 * statement text) while skipping string literals (`E'…'` with its
 * backslash escapes too), quoted identifiers, comments and dollar-quoted
 * strings (`$$…$$`, `$tag$…$tag$`), where a `?` means nothing.
 *
 * jsonb's own operators: `?|` and `?&` are always operators, and `??` is a
 * literal `?` (`data ?? 'key'` for jsonb's `?`). In a statement run with
 * no parameters (`placeholders: false`) a lone `?` is the operator as
 * written, so SQL pasted from elsewhere works unchanged.
 */
const cache = new Map<string, string>();
/** `$$` or `$tag$` at the start of the text. */
const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;
const CACHE_MAX = 1024;

export function toPositional(sql: string, placeholders = true): string {
  const key = placeholders ? sql : `\u0000${sql}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let out = "";
  let n = 0;
  const len = sql.length;
  for (let i = 0; i < len; i++) {
    const ch = sql[i]!;
    if ((ch === "E" || ch === "e") && sql[i + 1] === "'" && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? "")) {
      // E'…': backslash escapes as well as doubled quotes.
      let j = i + 2;
      while (j < len) {
        if (sql[j] === "\\") { j += 2; continue; }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j;
    } else if (ch === "'" || ch === '"') {
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
    } else if (ch === "$" && DOLLAR_TAG.test(sql.slice(i, i + 66))) {
      const tag = DOLLAR_TAG.exec(sql.slice(i, i + 66))![0];
      const j = sql.indexOf(tag, i + tag.length);
      const end = j < 0 ? len : j + tag.length;
      out += sql.slice(i, end);
      i = end - 1;
    } else if (ch === "?" && sql[i + 1] === "?") {
      out += "?";
      i++;
    } else if (ch === "?" && (sql[i + 1] === "&" || (sql[i + 1] === "|" && sql[i + 2] !== "|"))) {
      out += ch;
    } else if (ch === "?" && placeholders) {
      out += `$${++n}`;
    } else {
      out += ch;
    }
  }
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, out);
  return out;
}
