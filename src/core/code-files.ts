/**
 * Hooks, routes, cron jobs and queue workers as files.
 *
 * When a hooks folder is set up (`vb_hooks/` next to the data directory, or
 * VAULTBASE_HOOKS_DIR), the files in it are the code: each file defines one
 * hook, route, job or worker with `defineHook()` / `defineRoute()` /
 * `defineJob()` / `defineWorker()` from "vaultbase", and the admin UI edits
 * those same files. Files can import each other (shared code goes in
 * `lib/`) and npm packages installed in the folder.
 *
 * Each file has a row in its kind's table (origin "file") so everything that
 * reads those tables — the admin UI, the cron scheduler, cluster workers —
 * keeps working; the row mirrors the file's settings and source. The folder
 * is polled for changes and changed files are reloaded within a second. A
 * file that fails to load keeps its previous version running, with the error
 * on its row.
 *
 * On the first start with a folder, hooks typed into the admin UI are
 * written out as files. Jobs created at runtime by helpers.cron.add stay in
 * the database.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, extname, join, relative, resolve, sep } from "path";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { hooks, jobs, routes, workers } from "../db/schema.ts";
import { databaseCodeError, registerCodeLoader, type CompiledCode } from "./code-loader.ts";
import { HOOK_EVENTS, invalidateHookCache } from "./hooks.ts";
import { ROUTE_METHODS, invalidateRoutesCache, validatePath } from "./routes.ts";
import { invalidateJobsCache, nextRunFromCron, validateCron, validateMode } from "./jobs.ts";
import { VALID_BACKOFF, invalidateWorkerCache, validateQueueName } from "./queues.ts";

export type CodeKind = "hook" | "route" | "job" | "worker";

// ── Kinds ───────────────────────────────────────────────────────────────────

interface Prop {
  /** Key in the define*() object. */
  prop: string;
  /** Column in the kind's table. */
  column: string;
  default: string | number | boolean;
  /** File value → column value. */
  toColumn(v: unknown): unknown;
  /** Column value → file value. */
  fromColumn(v: unknown): string | number | boolean;
}

const str = (prop: string, column: string, def = ""): Prop => ({
  prop, column, default: def, toColumn: (v) => (v === undefined ? def : String(v)), fromColumn: (v) => String(v ?? def),
});
const bool = (prop: string, column: string, def: boolean): Prop => ({
  prop, column, default: def, toColumn: (v) => ((v === undefined ? def : v === true) ? 1 : 0), fromColumn: (v) => v === 1 || v === true,
});
const int = (prop: string, column: string, def: number): Prop => ({
  prop, column, default: def, toColumn: (v) => (v === undefined ? def : Math.trunc(Number(v))), fromColumn: (v) => Number(v ?? def),
});

interface KindSpec {
  kind: CodeKind;
  define: string;
  folder: string;
  fnKey: "run" | "handle";
  table: typeof hooks | typeof routes | typeof jobs | typeof workers;
  props: Prop[];
  /** Check settings already mapped to columns. */
  validate(cols: Record<string, unknown>): string | null;
  invalidate(): void;
}

const SPECS: Record<CodeKind, KindSpec> = {
  hook: {
    kind: "hook", define: "defineHook", folder: "hooks", fnKey: "run", table: hooks,
    props: [str("name", "name"), str("collection", "collection_name"), str("event", "event"), bool("enabled", "enabled", true)],
    validate: (c) => (HOOK_EVENTS.includes(c["event"] as never) ? null : `event must be one of ${HOOK_EVENTS.join(", ")}`),
    invalidate: invalidateHookCache,
  },
  route: {
    kind: "route", define: "defineRoute", folder: "routes", fnKey: "handle", table: routes,
    props: [
      str("name", "name"),
      { ...str("method", "method", "GET"), toColumn: (v) => String(v ?? "GET").toUpperCase() },
      str("path", "path"),
      bool("requireAuth", "require_auth", false),
      bool("enabled", "enabled", true),
    ],
    validate: (c) => (ROUTE_METHODS.includes(c["method"] as never) ? validatePath(String(c["path"])) : `method must be one of ${ROUTE_METHODS.join(", ")}`),
    invalidate: invalidateRoutesCache,
  },
  job: {
    kind: "job", define: "defineJob", folder: "jobs", fnKey: "run", table: jobs,
    props: [str("name", "name"), str("cron", "cron"), str("mode", "mode", "inline"), bool("enabled", "enabled", true)],
    validate: (c) => {
      const e = validateCron(String(c["cron"]));
      return e ? `invalid cron: ${e}` : validateMode(String(c["mode"]));
    },
    invalidate: invalidateJobsCache,
  },
  worker: {
    kind: "worker", define: "defineWorker", folder: "workers", fnKey: "run", table: workers,
    props: [
      str("name", "name"), str("queue", "queue"), int("concurrency", "concurrency", 1), int("retries", "retry_max", 3),
      str("backoff", "retry_backoff", "exponential"), int("retryDelayMs", "retry_delay_ms", 1000), bool("enabled", "enabled", true),
    ],
    validate: (c) => {
      const q = validateQueueName(String(c["queue"]));
      if (q) return q;
      if (!VALID_BACKOFF.has(String(c["retry_backoff"]))) return "backoff must be exponential or fixed";
      if (!(Number(c["concurrency"]) >= 1)) return "concurrency must be at least 1";
      return null;
    },
    invalidate: invalidateWorkerCache,
  },
};

export const CODE_KINDS = Object.keys(SPECS) as CodeKind[];

// ── Loading a file ──────────────────────────────────────────────────────────

const KIND = Symbol.for("vaultbase.codeKind");

(globalThis as Record<string, unknown>)["__vaultbaseDefine"] = Object.fromEntries(
  CODE_KINDS.map((k) => [k, (def: object) => ({ ...def, [KIND]: k })]),
);

// `import { defineHook } from "vaultbase"` inside a hook file resolves to
// these, wherever the server runs (including the compiled binary).
const VAULTBASE_MODULE = CODE_KINDS
  .map((k) => `export const ${SPECS[k].define} = globalThis.__vaultbaseDefine.${k};`)
  .join("\n");

const vaultbasePlugin = {
  name: "vaultbase-module",
  setup(b: { onResolve: Function; onLoad: Function }) {
    b.onResolve({ filter: /^vaultbase$/ }, () => ({ path: "vaultbase", namespace: "vaultbase-module" }));
    b.onLoad({ filter: /.*/, namespace: "vaultbase-module" }, () => ({ contents: VAULTBASE_MODULE, loader: "js" }));
  },
};

interface Loaded {
  kind: CodeKind;
  /** Settings mapped to columns. */
  columns: Record<string, unknown>;
  fn: CompiledCode<unknown>;
  /** Hash of the bundle: changes when the file or anything it imports does. */
  hash: string;
}

export class CodeFileError extends Error {}

function formatBuildLog(log: unknown, root: string): string {
  const l = log as { message?: string; position?: { file?: string; line?: number; column?: number } | null };
  const pos = l.position;
  const where = pos?.file ? ` (${relative(root, pos.file)}:${pos.line}:${pos.column})` : "";
  return `${l.message ?? String(log)}${where}`;
}

async function loadFile(abs: string, root: string): Promise<Loaded> {
  const out = await Bun.build({
    entrypoints: [abs], target: "bun", format: "esm", plugins: [vaultbasePlugin as never], throw: false,
  } as Parameters<typeof Bun.build>[0]);
  if (!out.success || !out.outputs[0]) {
    throw new CodeFileError(out.logs.map((l) => formatBuildLog(l, root)).join("\n") || "build failed");
  }
  const code = await out.outputs[0].text();
  const unsupported = databaseCodeError(code, true);
  if (unsupported) throw new CodeFileError(unsupported);
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  let mod: { default?: Record<string | symbol, unknown> };
  try {
    mod = await import(url);
  } catch (e) {
    throw new CodeFileError(`failed to load: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    URL.revokeObjectURL(url);
  }
  const def = mod.default;
  const kind = def?.[KIND] as CodeKind | undefined;
  if (!def || !kind) {
    throw new CodeFileError(`export default defineHook(...), defineRoute(...), defineJob(...) or defineWorker(...) from "vaultbase"`);
  }
  const spec = SPECS[kind];
  const fn = def[spec.fnKey];
  if (typeof fn !== "function") throw new CodeFileError(`${spec.define}() needs a ${spec.fnKey}(ctx) function`);
  const columns: Record<string, unknown> = {};
  for (const p of spec.props) columns[p.column] = p.toColumn(def[p.prop]);
  const err = spec.validate(columns);
  if (err) throw new CodeFileError(err);
  const bound = fn.bind(def) as (ctx: unknown) => unknown;
  return {
    kind, columns, fn: async (ctx) => bound(ctx),
    hash: new Bun.CryptoHasher("sha256").update(code).digest("hex"),
  };
}

// ── State ───────────────────────────────────────────────────────────────────

let root: string | null = null;
let writer = true;
/** file path (relative, `/`-separated) → its loaded code. */
const compiled = new Map<string, Loaded>();
/** file path → why its latest version didn't load. */
const errors = new Map<string, string>();
let signature = "";
let poller: ReturnType<typeof setInterval> | null = null;

registerCodeLoader("file", (row) => {
  const c = row.file_path ? compiled.get(row.file_path) : undefined;
  if (!c) throw new Error(root ? `hook file '${row.file_path}' isn't loaded` : `'${row.file_path}' is in the hooks folder, which isn't set up`);
  return c.fn;
});

/** The hooks folder when files mode is on, else null. */
export function codeFilesDir(): string | null {
  return root;
}

export function codeFileErrors(): Array<{ path: string; error: string }> {
  return [...errors].map(([path, error]) => ({ path, error }));
}

/**
 * Pick the hooks folder: VAULTBASE_HOOKS_DIR ("off" disables, created if
 * missing), else `vb_hooks/` next to the data directory if it exists.
 */
export function resolveCodeFilesDir(dataDir: string, env: Record<string, string | undefined> = process.env): string | null {
  const set = env["VAULTBASE_HOOKS_DIR"];
  if (set === "off") return null;
  if (set) return resolve(set);
  const dflt = join(dirname(resolve(dataDir)), "vb_hooks");
  return existsSync(dflt) ? dflt : null;
}

const CODE_EXT = new Set([".ts", ".js", ".mts", ".mjs", ".tsx", ".jsx"]);

function toRel(abs: string): string {
  return relative(root!, abs).split(sep).join("/");
}

/** Every file in the folder (for change detection) and the entry files among them. */
function walk(): { all: string[]; entries: string[] } {
  const all: string[] = [];
  const entries: string[] = [];
  const visit = (dir: string, inLib: boolean) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names.sort()) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const abs = join(dir, name);
      let st;
      try { st = statSync(abs); } catch { continue; }
      if (st.isDirectory()) {
        visit(abs, inLib || (dir === root && name === "lib"));
        continue;
      }
      all.push(`${toRel(abs)}:${st.mtimeMs}:${st.size}`);
      if (!inLib && CODE_EXT.has(extname(name)) && !name.endsWith(".d.ts")) entries.push(toRel(abs));
    }
  };
  visit(root!, false);
  return { all, entries };
}

// ── Sync: files → compiled code + rows ──────────────────────────────────────

let chain: Promise<unknown> = Promise.resolve();

/** Run `fn` after any sync or write in progress; they never overlap. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

/** Reload the folder now. Resolves when rows and caches are up to date. */
export function syncCodeFiles(): Promise<void> {
  return serial(syncNow);
}

async function syncNow(): Promise<void> {
  if (!root) return;
  const { all, entries } = walk();
  signature = all.join("|");

  const changedKinds = new Set<CodeKind>();
  const present = new Set(entries);
  for (const rel of [...compiled.keys()]) {
    if (!present.has(rel)) { changedKinds.add(compiled.get(rel)!.kind); compiled.delete(rel); }
  }
  for (const rel of [...errors.keys()]) if (!present.has(rel)) errors.delete(rel);

  const loaded = new Map<string, Loaded>();
  for (const rel of entries) {
    try {
      const l = await loadFile(join(root, rel), root);
      loaded.set(rel, l);
      errors.delete(rel);
      const prev = compiled.get(rel);
      if (!prev || prev.hash !== l.hash) {
        if (prev) changedKinds.add(prev.kind);
        changedKinds.add(l.kind);
        compiled.set(rel, l);
      }
    } catch (e) {
      errors.set(rel, e instanceof Error ? e.message : String(e));
    }
  }

  if (writer) for (const k of await reconcileRows(entries, loaded)) changedKinds.add(k);
  for (const k of changedKinds) SPECS[k].invalidate();
}

type Row = Record<string, unknown> & { id: string; file_path: string | null };

async function fileRows(kind: CodeKind): Promise<Row[]> {
  const t = SPECS[kind].table;
  return await getDb().select().from(t).where(eq(t.origin, "file")) as unknown as Row[];
}

/** Bring the file rows in line with the folder. Returns the kinds whose rows changed. */
async function reconcileRows(entries: string[], loaded: Map<string, Loaded>): Promise<Set<CodeKind>> {
  const db = getDb();
  const changed = new Set<CodeKind>();
  const now = Math.floor(Date.now() / 1000);
  const rowsByPath = new Map<string, { kind: CodeKind; row: Row }>();
  for (const kind of CODE_KINDS) for (const row of await fileRows(kind)) if (row.file_path) rowsByPath.set(row.file_path, { kind, row });

  for (const rel of entries) {
    const l = loaded.get(rel);
    const existing = rowsByPath.get(rel);
    if (!l) {
      // Didn't load: keep the row (and the code already running), note why.
      const error = errors.get(rel) ?? "failed to load";
      if (existing && existing.row["file_error"] !== error) {
        const t = SPECS[existing.kind].table;
        await db.update(t).set({ file_error: error } as never).where(eq(t.id, existing.row.id));
        changed.add(existing.kind);
      }
      continue;
    }
    const spec = SPECS[l.kind];
    let source = "";
    try { source = readFileSync(join(root!, rel), "utf8"); } catch { /* removed meanwhile; next sync drops it */ }
    const values: Record<string, unknown> = { ...l.columns, code: source, file_error: null };

    if (existing && existing.kind !== l.kind) {
      // The file now defines a different kind: move its row.
      const t = SPECS[existing.kind].table;
      await db.delete(t).where(eq(t.id, existing.row.id));
      changed.add(existing.kind);
    }
    if (existing && existing.kind === l.kind) {
      const diff = Object.entries(values).some(([k, v]) => existing.row[k] !== v);
      if (!diff) continue;
      if (l.kind === "job" && existing.row["cron"] !== values["cron"]) values["next_run_at"] = nextRunFromCron(String(values["cron"]), now);
      await db.update(spec.table).set({ ...values, updated_at: now } as never).where(eq(spec.table.id, existing.row.id));
    } else {
      if (l.kind === "job") values["next_run_at"] = nextRunFromCron(String(values["cron"]), now);
      await db.insert(spec.table).values({
        id: crypto.randomUUID(), ...values, origin: "file", file_path: rel, created_at: now, updated_at: now,
      } as never);
    }
    changed.add(l.kind);
  }

  const present = new Set(entries);
  for (const [rel, { kind, row }] of rowsByPath) {
    if (present.has(rel)) continue;
    const t = SPECS[kind].table;
    await db.delete(t).where(eq(t.id, row.id));
    changed.add(kind);
  }
  return changed;
}

// ── Writing files (the admin UI and API) ────────────────────────────────────

function quoteValue(v: string | number | boolean): string {
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}

/** A new file for `kind` with these settings (columns) and function body. */
export function renderCodeFile(kind: CodeKind, columns: Record<string, unknown>, body: string): string {
  const spec = SPECS[kind];
  const props = spec.props.map((p) => `  ${p.prop}: ${quoteValue(p.fromColumn(columns[p.column] ?? p.toColumn(undefined)))},`);
  const trimmed = body.trim() ? body.replace(/\s+$/, "") : "// ...";
  // Indent the body unless that would change a multi-line template string.
  const inner = trimmed.includes("`") ? trimmed : trimmed.split("\n").map((l) => (l ? `    ${l}` : l)).join("\n");
  return [
    `import { ${spec.define} } from "vaultbase";`,
    "",
    `export default ${spec.define}({`,
    ...props,
    `  async ${spec.fnKey}(ctx) {`,
    inner,
    "  },",
    "});",
    "",
  ].join("\n");
}

const LITERAL = String.raw`("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|true|false|-?\d+(?:\.\d+)?)`;

/**
 * Change settings in a file's define*() object, leaving the rest of the file
 * as it is. Each setting must be written as a plain value (string, number,
 * boolean) in the file, or be absent; one set to an expression has to be
 * edited in the file.
 */
export function setCodeFileProps(source: string, kind: CodeKind, values: Record<string, string | number | boolean>): string {
  const spec = SPECS[kind];
  const open = new RegExp(String.raw`\b${spec.define}\s*\(\s*\{`).exec(source);
  if (!open) throw new CodeFileError(`can't find ${spec.define}({ ... }) in the file`);
  let out = source;
  for (const [prop, value] of Object.entries(values)) {
    const start = open.index + open[0].length;
    // Settings come before the function; don't look inside it.
    const fnAt = new RegExp(String.raw`\n\s*(async\s+)?${spec.fnKey}\s*[(:]`).exec(out.slice(start));
    const region = out.slice(start, fnAt ? start + fnAt.index : out.length);
    const literal = new RegExp(String.raw`(\b${prop}\s*:\s*)${LITERAL}`).exec(region);
    if (literal) {
      const at = start + literal.index + literal[1]!.length;
      out = out.slice(0, at) + quoteValue(value) + out.slice(at + literal[2]!.length);
    } else if (new RegExp(String.raw`\b${prop}\s*:`).test(region)) {
      throw new CodeFileError(`'${prop}' is set to an expression in the file; change it there`);
    } else {
      out = out.slice(0, start) + `\n  ${prop}: ${quoteValue(value)},` + out.slice(start);
    }
  }
  return out;
}

function hashText(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex");
}

/** Fingerprint of a file's content, for "changed on disk since you opened it" checks. */
export function codeFileVersion(source: string): string {
  return hashText(source).slice(0, 16);
}

export class CodeFileConflictError extends Error {}

function safePath(rel: string): string {
  const abs = resolve(root!, rel);
  if (abs !== root && !abs.startsWith(root! + sep)) throw new CodeFileError("path escapes the hooks folder");
  return abs;
}

/** Check `source` builds and defines `kind`, by loading it next to where it will live. */
async function check(rel: string, kind: CodeKind, source: string): Promise<void> {
  const abs = safePath(rel);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = join(dirname(abs), `.vb-check-${crypto.randomUUID()}${extname(abs) || ".ts"}`);
  writeFileSync(tmp, source);
  try {
    const l = await loadFile(tmp, root!);
    if (l.kind !== kind) throw new CodeFileError(`the file must use ${SPECS[kind].define}(), not ${SPECS[l.kind].define}()`);
  } finally {
    try { unlinkSync(tmp); } catch { /* gone */ }
  }
}

function writeAtomic(rel: string, source: string): void {
  const abs = safePath(rel);
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = join(dirname(abs), `.vb-write-${crypto.randomUUID()}`);
  writeFileSync(tmp, source);
  renameSync(tmp, abs);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

/** A free file name in the kind's folder. */
function newPath(kind: CodeKind, columns: Record<string, unknown>): string {
  const spec = SPECS[kind];
  const base = slug(String(columns["name"] ?? "")) || slug(
    kind === "hook" ? `${columns["collection_name"] || "all"} ${columns["event"]}`
      : kind === "route" ? `${columns["method"]} ${columns["path"]}`
        : kind === "job" ? "job" : `${columns["queue"]}`,
  ) || kind;
  for (let i = 1; ; i++) {
    const rel = `${spec.folder}/${base}${i === 1 ? "" : `-${i}`}.ts`;
    if (!existsSync(join(root!, rel))) return rel;
  }
}

async function rowByPath(kind: CodeKind, rel: string): Promise<Row | null> {
  const t = SPECS[kind].table;
  const r = await getDb().select().from(t).where(and(eq(t.origin, "file"), eq(t.file_path, rel))).limit(1);
  return (r[0] as unknown as Row) ?? null;
}

/**
 * Create a file for a new hook / route / job / worker from admin-UI style
 * input (columns + function body). Returns its row.
 */
export function createCodeFile(kind: CodeKind, columns: Record<string, unknown>, body: string): Promise<Row> {
  return serial(async () => {
    const rel = newPath(kind, columns);
    const source = renderCodeFile(kind, columns, body);
    await check(rel, kind, source);
    writeAtomic(rel, source);
    await syncNow();
    const row = await rowByPath(kind, rel);
    if (!row) throw new CodeFileError(errors.get(rel) ?? "the new file didn't load");
    return row;
  });
}

/**
 * Change a file-backed row. `code` replaces the whole file; settings
 * (columns) are written into the file's define*() call. `expectVersion` is
 * the version the caller last saw; a file changed since then is refused.
 */
export function updateCodeFile(
  kind: CodeKind, row: Row, columns: Record<string, unknown>, code: string | undefined, expectVersion?: string | null,
): Promise<Row> {
  return serial(async () => {
    const rel = row.file_path!;
    const abs = safePath(rel);
    const current = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    if (current === null) throw new CodeFileConflictError(`${rel} no longer exists`);
    if (expectVersion && expectVersion !== codeFileVersion(current)) {
      throw new CodeFileConflictError(`${rel} changed on disk since you opened it`);
    }
    let source = code ?? current;
    // Only settings that change: the admin UI sends the whole form, and a
    // setting written as an expression in the file is fine left alone.
    const props: Record<string, string | number | boolean> = {};
    for (const p of SPECS[kind].props) {
      const v = columns[p.column];
      if (v === undefined) continue;
      const normalized = p.toColumn(p.fromColumn(v));
      if (normalized !== row[p.column]) props[p.prop] = p.fromColumn(v);
    }
    if (Object.keys(props).length > 0) source = setCodeFileProps(source, kind, props);
    if (source !== current) {
      await check(rel, kind, source);
      writeAtomic(rel, source);
    }
    await syncNow();
    const updated = await rowByPath(kind, rel);
    if (!updated) throw new CodeFileError(errors.get(rel) ?? "the file didn't load");
    return updated;
  });
}

/** Delete a file-backed row's file (and so the row). */
export function deleteCodeFile(row: Row): Promise<void> {
  return serial(async () => {
    try { unlinkSync(safePath(row.file_path!)); } catch { /* already gone */ }
    await syncNow();
  });
}

// ── Start ───────────────────────────────────────────────────────────────────

const TYPES_FILE = "vaultbase.d.ts";
const TYPES = `// Types for hook files. Written by Vaultbase; safe to commit, regenerated if deleted.
declare module "vaultbase" {
  type Rec = Record<string, any>;
  export interface Auth { id: string; type: "user" | "admin"; email?: string; collection?: string; anonymous?: boolean }
  /** helpers.find, query, enqueue, notify, email, http, db, ... (see the docs). */
  export type Helpers = Rec;
  export interface HookContext { record: Rec; existing: Rec | null; auth: Auth | null; helpers: Helpers }
  export interface RouteContext {
    req: Request; method: string; path: string; params: Record<string, string>; query: Record<string, string>;
    body: unknown; auth: Auth | null; helpers: Helpers; set: { status: number; headers: Record<string, string> };
  }
  export interface JobContext { helpers: Helpers; scheduledAt: number }
  export interface WorkerContext { payload: any; attempt: number; queue: string; jobId: string; helpers: Helpers }
  type HookEvent = "beforeCreate" | "afterCreate" | "beforeUpdate" | "afterUpdate" | "beforeDelete" | "afterDelete";
  export function defineHook(def: { name?: string; collection?: string; event: HookEvent; enabled?: boolean; run(ctx: HookContext): unknown }): unknown;
  export function defineRoute(def: { name?: string; method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; path: string; requireAuth?: boolean; enabled?: boolean; handle(ctx: RouteContext): unknown }): unknown;
  export function defineJob(def: { name?: string; cron: string; mode?: string; enabled?: boolean; run(ctx: JobContext): unknown }): unknown;
  export function defineWorker(def: { name?: string; queue: string; concurrency?: number; retries?: number; backoff?: "exponential" | "fixed"; retryDelayMs?: number; enabled?: boolean; run(ctx: WorkerContext): unknown }): unknown;
}
`;

/** Write inline (admin UI) rows out as files and point the rows at them. */
async function exportInlineRows(): Promise<number> {
  const db = getDb();
  let n = 0;
  for (const kind of CODE_KINDS) {
    const t = SPECS[kind].table;
    const rows = await db.select().from(t).where(eq(t.origin, "inline")) as unknown as Row[];
    for (const row of rows) {
      const rel = newPath(kind, row);
      const source = renderCodeFile(kind, row, String(row["code"] ?? ""));
      try {
        await check(rel, kind, source);
      } catch (e) {
        // Leave it in the database, where it works, rather than swap it for
        // a file that doesn't load.
        console.warn(`[hooks] kept ${kind} '${String(row["name"]) || row.id}' in the database: as a file it fails with ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      writeAtomic(rel, source);
      await db.update(t).set({ origin: "file", file_path: rel } as never).where(eq(t.id, row.id));
      n++;
    }
  }
  return n;
}

/**
 * Turn files mode on for `dir` (or leave it off for null). `isWriter` is
 * false on cluster workers other than the first: they load the files but
 * leave the rows to the first worker.
 */
export async function startCodeFiles(dir: string | null, opts: { isWriter?: boolean; pollMs?: number } = {}): Promise<void> {
  stopCodeFiles();
  root = dir;
  writer = opts.isWriter !== false;
  compiled.clear();
  errors.clear();
  signature = "";
  if (!root) return;
  mkdirSync(root, { recursive: true });
  if (writer) {
    if (!existsSync(join(root, TYPES_FILE))) writeFileSync(join(root, TYPES_FILE), TYPES);
    const n = await serial(exportInlineRows);
    if (n > 0) console.log(`[hooks] wrote ${n} hook(s), route(s), job(s) or worker(s) from the admin UI to ${root}`);
  }
  await syncCodeFiles();
  const pollMs = opts.pollMs ?? 1000;
  if (pollMs > 0) {
    poller = setInterval(() => {
      if (!root) return;
      if (walk().all.join("|") !== signature) void syncCodeFiles().catch((e) => console.error("[hooks] sync failed:", e));
    }, pollMs);
    poller.unref?.();
  }
}

export function stopCodeFiles(): void {
  if (poller) clearInterval(poller);
  poller = null;
}

/** Test hook: turn files mode off and forget loaded files. */
export function _resetCodeFiles(): void {
  stopCodeFiles();
  root = null;
  compiled.clear();
  errors.clear();
  signature = "";
}
