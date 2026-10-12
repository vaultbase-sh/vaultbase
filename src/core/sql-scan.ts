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
export function scanSql(sql: string): { words: string[]; identifiers: string[]; statements: number } {
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
    } else if (c === "'" || c === '"' || c === "`" || c === "[") {
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
