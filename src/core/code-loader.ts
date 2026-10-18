/**
 * Turns the code behind a hook, route, cron job or queue worker into a
 * function. Each row says where its code comes from (`origin`); a loader per
 * origin compiles it. Built in: "inline" (the function body typed into the
 * admin UI) and "runtime" (the same, from helpers.cron.add). "file" is
 * registered by code-files.ts.
 */

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

/** Compile a row's code. Throws when it doesn't compile or its origin has no loader. */
export function compileCode<C>(row: CodeRow): CompiledCode<C> {
  const origin = row.origin || "inline";
  const loader = loaders.get(origin);
  if (!loader) throw new Error(`no code loader for origin '${origin}'`);
  return loader(row) as CompiledCode<C>;
}
