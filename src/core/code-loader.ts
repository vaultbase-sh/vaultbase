/**
 * Turns the code behind a hook, route, cron job or queue worker into a
 * function. Each row says where its code comes from (`origin`); a loader per
 * origin compiles it. "inline" — the function body typed into the admin UI —
 * is the only built-in origin.
 */

export interface CodeRow {
  id: string;
  code: string;
  /** Where the code comes from. Default "inline". */
  origin?: string | null;
}

export type CompiledCode<C> = (ctx: C) => Promise<unknown>;
export type CodeLoader = (row: CodeRow) => CompiledCode<unknown>;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => CompiledCode<unknown>;

const loaders = new Map<string, CodeLoader>([
  // An async function body with `ctx` in scope.
  ["inline", (row) => new AsyncFunction("ctx", row.code)],
]);

export function registerCodeLoader(origin: string, loader: CodeLoader): () => void {
  if (loaders.has(origin)) throw new Error(`code loader '${origin}' is already registered`);
  loaders.set(origin, loader);
  return () => {
    if (loaders.get(origin) === loader) loaders.delete(origin);
  };
}

/** Compile a row's code. Throws when it doesn't compile or its origin has no loader. */
export function compileCode<C>(row: CodeRow): CompiledCode<C> {
  const origin = row.origin || "inline";
  const loader = loaders.get(origin);
  if (!loader) throw new Error(`no code loader for origin '${origin}'`);
  return loader(row) as CompiledCode<C>;
}
