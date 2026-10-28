/**
 * Turns the code behind a hook, route, cron job or queue worker into a
 * function. Each row says where its code comes from (`origin`); a loader per
 * origin compiles it. Built in: "inline" (the function body typed into the
 * admin UI) and "runtime" (the same, from helpers.cron.add). "file" is
 * registered by code-files.ts.
 */

import { db, driverOpen } from "../db/index.ts";

export interface CodeRow {
  id: string;
  code: string;
  /** Where the code comes from. Default "inline". */
  origin?: string | null;
  /** For origin "file": its path inside the hooks folder. */
  file_path?: string | null;
}

export type CompiledCode<C> = (ctx: C) => Promise<unknown>;
export type CodeLoader = (row: CodeRow) => CompiledCode<unknown>;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => CompiledCode<unknown>;

const loaders = new Map<string, CodeLoader>([
  // An async function body with `ctx` in scope.
  ["inline", (row) => new AsyncFunction("ctx", row.code)],
  ["runtime", (row) => new AsyncFunction("ctx", row.code)],
]);

export function registerCodeLoader(origin: string, loader: CodeLoader): () => void {
  if (loaders.has(origin)) throw new Error(`code loader '${origin}' is already registered`);
  loaders.set(origin, loader);
  return () => {
    if (loaders.get(origin) === loader) loaders.delete(origin);
  };
}

/**
 * Why inline code (an async function body with `ctx` in scope) doesn't
 * compile, or null when it does. Checked when inline code is saved, so a
 * hook, route, job or worker can't be stored in a state it can't run in.
 */
export function inlineCompileError(code: string): string | null {
  try {
    new AsyncFunction("ctx", code);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const transpiler = new Bun.Transpiler({ loader: "js" });

/**
 * Where code reaches `helpers.db`: `helpers.db`, `helpers?.db`,
 * `helpers["db"]`, `{ db } = ctx.helpers` and `{ helpers: { db } }`.
 */
const HELPERS_DB = [
  /\bhelpers\s*\??\.\s*db\b/,
  /\bhelpers\s*(\?\.)?\s*\[\s*["'`]db["'`]\s*\]/,
  /\{[^{}]*\bdb\b[^{}]*\}\s*=\s*[\w$.?]*\bhelpers\b/,
  /\bhelpers\s*:\s*\{[^{}]*\bdb\b/,
];

const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|case|in|of|void|yield|await|delete|throw|new|instanceof|else|do)$/;

/**
 * `code` with the contents of its string, template and regular-expression
 * literals and its comments blanked, so a search reads only code: a message
 * that mentions helpers.db isn't a use of it. Template substitutions stay
 * code. A string right after `[` stays too (`helpers["db"]`). A `/` starts a
 * regular expression where an operand is expected, as JavaScript reads it.
 */
export function codeOnly(code: string): string {
  let out = "";
  let prev = ""; // the last character of code outside literals and spaces
  let depth = 0;
  const templates: number[] = []; // brace depth at each open ${
  let i = 0;
  const skip = (from: number, to: number) => " ".repeat(Math.max(0, to - from));
  while (i < code.length) {
    const c = code[i]!;
    const n = code[i + 1];
    if (c === "/" && n === "/") {
      const end = code.indexOf("\n", i);
      i = end < 0 ? code.length : end;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = code.indexOf("*/", i + 2);
      i = end < 0 ? code.length : end + 2;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < code.length && code[j] !== c && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1;
      out += prev === "[" ? code.slice(i, j + 1) : c + skip(i + 1, j) + c;
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === "`" || (c === "}" && templates.length > 0 && templates[templates.length - 1] === depth)) {
      if (c === "}") templates.pop();
      let j = i + 1;
      while (j < code.length && code[j] !== "`" && !(code[j] === "$" && code[j + 1] === "{")) j += code[j] === "\\" ? 2 : 1;
      out += c + skip(i + 1, j);
      if (code[j] === "$") {
        out += "${";
        templates.push(depth);
        i = j + 2;
        prev = "{";
      } else {
        out += "`";
        i = j + 1;
        prev = "`";
      }
      continue;
    }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || REGEX_AFTER_WORD.test(out.trimEnd()))) {
      let j = i + 1;
      let inClass = false;
      while (j < code.length && code[j] !== "\n" && (inClass || code[j] !== "/")) {
        if (code[j] === "[") inClass = true;
        else if (code[j] === "]") inClass = false;
        j += code[j] === "\\" ? 2 : 1;
      }
      out += "/" + skip(i + 1, j) + "/";
      i = j + 1;
      prev = "/";
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/**
 * Why code can't run on the open database, or null. `helpers.db` is
 * synchronous and SQLite-only: on Postgres it throws when called, so code
 * that uses it is refused when saved or enabled there, naming `helpers.sql`.
 * A text search over the code without its comments and literals, not a
 * proof: code that reaches `helpers.db` another way still fails when it
 * runs. `module` is true for an ES module (a hooks-folder file), false for
 * an inline body.
 */
export function databaseCodeError(code: string, module = false): string | null {
  if (!driverOpen() || db.name !== "postgres" || !code.includes("db")) return null;
  let text = code;
  try {
    text = transpiler.transformSync(module ? code : `async function __vb(ctx) {\n${code}\n}`);
  } catch { /* searched with its comments */ }
  text = codeOnly(text);
  if (!HELPERS_DB.some((re) => re.test(text))) return null;
  return "helpers.db is not available on Postgres: it is synchronous and SQLite-only. "
    + "Use helpers.sql, which works on every database: `await helpers.sql.query(sql, [params])`, "
    + "`queryOne`, `exec` and `transaction`, with ? placeholders and the parameters in an array.";
}

/** Compile a row's code. Throws when it doesn't compile or its origin has no loader. */
export function compileCode<C>(row: CodeRow): CompiledCode<C> {
  const origin = row.origin || "inline";
  const loader = loaders.get(origin);
  if (!loader) throw new Error(`no code loader for origin '${origin}'`);
  return loader(row) as CompiledCode<C>;
}
