/**
 * A small SQL scanner shared by everything that has to reason about SQL text
 * before SQLite runs it: the admin SQL runner, MCP run_sql and view-query
 * validation.
 */

/**
 * Split SQL into the words SQLite will see, in one left-to-right pass that
 * knows which characters start a string, a quoted identifier or a comment.
 * Stripping each kind with its own regex, one after another, got the order
 * wrong for some input: `'--'` inside a string was taken for a comment
 * start, which hid every keyword after it on the line while SQLite still ran
 * them. Also counts statements (`;` outside literals and comments).
 */
/** Postgres dollar-quote opener at the start of `s`: `$$` or `$tag$`. */
const DOLLAR_TAG_RE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * With `pg`, Postgres's own lexical forms are read as Postgres reads them,
 * so a quote inside one can't open a string that hides the words after it:
 * `E'…'` (backslash escapes), `$tag$…$tag$` dollar quotes, and `[` as an
 * array subscript rather than a quoted identifier. (`U&'…'` lexes as a plain
 * string: its escapes are Unicode code points, never a quote.)
 */
export function scanSql(sql: string, opts: { pg?: boolean } = {}): { words: string[]; identifiers: string[]; statements: number } {
  const pg = opts.pg === true;
  const words: string[] = [];
  /** Quoted identifiers ("…", `…`, […]), unquoted and upper-cased. */
  const identifiers: string[] = [];
  let statements = 0;
  let pending = false; // anything since the last `;`
  // A trigger body holds its own `;`-separated statements between BEGIN and
  // END (and CASE … END may nest inside), so inside CREATE TRIGGER a `;` only
  // ends the statement at depth 0.
  let inTrigger = false;
  let depth = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? n : end + 1;
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (pg && (c === "E" || c === "e") && next === "'" && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? "")) {
      // E'…': a backslash escapes the next character, `\'` included.
      let j = i + 2;
      while (j < n) {
        if (sql[j] === "\\") { j += 2; continue; }
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } break; }
        j++;
      }
      i = Math.min(n, j + 1);
      pending = true;
    } else if (pg && c === "$" && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? "") && DOLLAR_TAG_RE.test(sql.slice(i, i + 130))) {
      const tag = DOLLAR_TAG_RE.exec(sql.slice(i, i + 130))![0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end < 0 ? n : end + tag.length;
      pending = true;
    } else if (c === "'" || c === '"' || c === "`" || (c === "[" && !pg)) {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      for (;;) {
        const k = sql.indexOf(close, j);
        if (k < 0) { j = n; break; }
        // A doubled quote is an escaped quote, not the end ([…] has no escape).
        if (close !== "]" && sql[k + 1] === close) { j = k + 2; continue; }
        j = k + 1;
        break;
      }
      if (c !== "'") identifiers.push(sql.slice(i + 1, j - 1).replaceAll(close + close, close).toUpperCase());
      i = j;
      pending = true;
    } else if (c === ";") {
      if (!(inTrigger && depth > 0)) {
        if (pending) statements++;
        pending = false;
        inTrigger = false;
      }
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j]!)) j++;
      const word = sql.slice(i, j).toUpperCase();
      words.push(word);
      if (word === "TRIGGER") inTrigger = true;
      if (inTrigger && (word === "BEGIN" || word === "CASE")) depth++;
      if (inTrigger && word === "END" && depth > 0) depth--;
      pending = true;
      i = j;
    } else {
      if (!/\s/.test(c)) pending = true;
      i++;
    }
  }
  if (pending) statements++;
  return { words, identifiers, statements };
}

/**
 * Rewrite a view query's `:name` parameters (view-params.ts): each becomes
 * what `replace` returns, and the names come back in the order they appear.
 * Strings, quoted identifiers and comments are copied as they are, so a
 * `':x'` or `-- :x` isn't a parameter, and neither is Postgres's `::type`.
 *
 * `pg` also reads Postgres's own literals (`E'…'` with backslash escapes,
 * `$tag$…$tag$`). With `bound` (Postgres, a query that runs with bound
 * values) a lone `?`, jsonb's key operator, is doubled: there `?` is a
 * placeholder and `??` the literal (db/placeholders.ts).
 */
export function rewriteSqlParams(
  sql: string,
  replace: (name: string) => string,
  opts: { pg: boolean; bound: boolean },
): { sql: string; names: string[] } {
  const { pg } = opts;
  const bound = pg && opts.bound;
  const names: string[] = [];
  let out = "";
  let i = 0;
  const n = sql.length;
  // Postgres: inside [...] a `:` is an array slice (arr[1:n]), not a parameter.
  let brackets = 0;
  const copyUntil = (j: number) => { out += sql.slice(i, j); i = j; };
  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      copyUntil(end < 0 ? n : end + 1);
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      copyUntil(end < 0 ? n : end + 2);
    } else if (pg && (c === "E" || c === "e") && next === "'" && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? "")) {
      let j = i + 2;
      while (j < n) {
        if (sql[j] === "\\") { j += 2; continue; }
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } break; }
        j++;
      }
      copyUntil(Math.min(n, j + 1));
    } else if (pg && c === "$" && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(i)) && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? "")) {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))![0];
      const end = sql.indexOf(tag, i + tag.length);
      copyUntil(end < 0 ? n : end + tag.length);
    } else if (c === "'" || c === '"' || c === "`" || (!pg && c === "[")) {
      const close = c === "[" ? "]" : c;
      let j = i + 1;
      for (;;) {
        const k = sql.indexOf(close, j);
        if (k < 0) { j = n; break; }
        if (close !== "]" && sql[k + 1] === close) { j = k + 2; continue; }
        j = k + 1;
        break;
      }
      copyUntil(j);
    } else if (c === ":" && next === ":") {
      copyUntil(i + 2); // ::type
    } else if (pg && (c === "[" || c === "]")) {
      brackets = Math.max(0, brackets + (c === "[" ? 1 : -1));
      copyUntil(i + 1);
    } else if (c === ":" && next !== undefined && /[A-Za-z_]/.test(next) && sql[i - 1] !== ":" && brackets === 0) {
      let j = i + 2;
      while (j < n && /[A-Za-z0-9_]/.test(sql[j]!)) j++;
      const name = sql.slice(i + 1, j);
      names.push(name);
      out += replace(name);
      i = j;
    } else if (bound && c === "?") {
      // `?|`, `?&` are operators and `??` already the literal; a lone `?` is doubled.
      if (next === "|" || next === "&") copyUntil(i + 2);
      else if (next === "?") copyUntil(i + 2);
      else { out += "??"; i++; }
    } else {
      copyUntil(i + 1);
    }
  }
  return { sql: out, names };
}
