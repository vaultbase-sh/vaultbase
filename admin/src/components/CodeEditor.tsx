import { useEffect, useRef, useState } from "react";
import Editor, { loader, type BeforeMount, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import type { FieldDef } from "../api.ts";

// ── Bundle Monaco locally + workers ─────────────────────────────────────────
// Without this, Monaco loads from CDN, the TS service may never start, and
// the theme briefly flashes light. Bundling fixes loading + IntelliSense.

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker(workerId: string, label: string): Worker;
    };
  }
}

let bootstrapped = false;
function bootstrapMonaco() {
  if (bootstrapped) return;
  bootstrapped = true;

  window.MonacoEnvironment = {
    getWorker(_id, label) {
      if (label === "json") return new jsonWorker();
      if (label === "css" || label === "scss" || label === "less") return new cssWorker();
      if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
      if (label === "typescript" || label === "javascript") return new tsWorker();
      return new editorWorker();
    },
  };

  // Tell @monaco-editor/react to use the locally-imported monaco
  // (instead of fetching from cdn.jsdelivr.net at runtime)
  loader.config({ monaco });

  // Register theme + TS opts up front so the editor renders dark immediately
  defineTheme();
  setupTsLanguage();
}

function defineTheme() {
  monaco.editor.defineTheme("vaultbase-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6b7280", fontStyle: "italic" },
      { token: "string", foreground: "87b47e" },
      { token: "number", foreground: "86b9bb" },
      { token: "keyword", foreground: "b3703d" },
      { token: "type", foreground: "4d8ce8" },
      { token: "type.identifier", foreground: "4d8ce8" },
      { token: "identifier", foreground: "e6e6e6" },
      { token: "delimiter", foreground: "8b8b8b" },
      { token: "operator", foreground: "d4d4d4" },
    ],
    colors: {
      "editor.background": "#1f1f1f",
      "editor.foreground": "#e6e6e6",
      "editorLineNumber.foreground": "#525252",
      "editorLineNumber.activeForeground": "#a3a3a3",
      "editor.selectionBackground": "#1055C944",
      "editor.lineHighlightBackground": "#ffffff05",
      "editorCursor.foreground": "#4d8ce8",
      "editorIndentGuide.background1": "#2a2a2a",
      "editorWidget.background": "#262626",
      "editorWidget.border": "#3a3a3a",
      "editorSuggestWidget.background": "#262626",
      "editorSuggestWidget.border": "#3a3a3a",
      "editorSuggestWidget.foreground": "#e6e6e6",
      "editorSuggestWidget.selectedBackground": "#1055C933",
      "editorSuggestWidget.highlightForeground": "#4d8ce8",
      "editorHoverWidget.background": "#262626",
      "editorHoverWidget.border": "#3a3a3a",
      "scrollbarSlider.background": "#ffffff15",
      "scrollbarSlider.hoverBackground": "#ffffff22",
      "scrollbarSlider.activeBackground": "#ffffff33",
      "editorBracketMatch.background": "#1055C922",
      "editorBracketMatch.border": "#1055C9",
    },
  });
  // Make this the default theme so even briefly-shown editors are dark
  monaco.editor.setTheme("vaultbase-dark");
}

// Monaco's TS service runtime API works but its public d.ts marks it deprecated.
// Cast through `unknown` to access it without TS errors.
interface TsLanguageService {
  javascriptDefaults: {
    setCompilerOptions(opts: Record<string, unknown>): void;
    setDiagnosticsOptions(opts: { noSemanticValidation: boolean; noSyntaxValidation: boolean }): void;
    addExtraLib(content: string, filename: string): monaco.IDisposable;
  };
  ScriptTarget: { ES2022: number };
  ModuleResolutionKind: { NodeJs: number };
}
const ts = (monaco.languages as unknown as { typescript: TsLanguageService }).typescript;

function setupTsLanguage() {
  ts.javascriptDefaults.setCompilerOptions({
    target: ts.ScriptTarget.ES2022,
    allowJs: true,
    checkJs: false,
    noLib: false,
    lib: ["es2022", "dom"],
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
  });
  ts.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  });
}

bootstrapMonaco();

// ── Hook ctx type generation ────────────────────────────────────────────────

const HOOK_BASE_DECL = `
interface AuthContext {
  /** Authenticated user/admin id */
  id: string;
  /** "user" or "admin" */
  type: "user" | "admin";
  /** email if present in token */
  email?: string;
}

interface HookHelpers {
  /** Slugify a string: 'Hello World' -> 'hello-world' */
  slug(s: string): string;
  /** Throw a 422 error and abort the operation */
  abort(message: string): never;
  /** Look up a single record by id */
  find<T = Record<string, any>>(collection: string, id: string): Promise<T | null>;
  /** Query records in a collection */
  query<T = Record<string, any>>(
    collection: string,
    opts?: { filter?: string; sort?: string; perPage?: number }
  ): Promise<{ data: T[]; totalItems: number }>;
  /** Outbound HTTP fetch (Web Fetch API) */
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
  /** Server-side log */
  log(...args: unknown[]): void;
  /** Send email (pending SMTP) */
  email(opts: { to: string; subject: string; body: string }): Promise<void>;
  /**
   * Enqueue a job onto a named queue. Returns the new job id, or the existing
   * one when \`uniqueKey\` matched a non-finished job (\`deduped: true\`).
   */
  enqueue(
    queue: string,
    payload: unknown,
    opts?: {
      delay?: number;
      uniqueKey?: string;
      retries?: number;
      backoff?: "exponential" | "fixed";
      retryDelayMs?: number;
    }
  ): Promise<{ jobId: string; deduped: boolean }>;
  /**
   * Record a custom policy decision on the active request log (records API).
   * No-op outside an HTTP request context (cron jobs, post-cascade hooks, etc.).
   * Multiple calls accumulate.
   */
  recordRule(opts: {
    /** Logical name of the rule (e.g. "custom-quota") */
    rule: string;
    /** Defaults to the active hook's collection */
    collection?: string;
    /** Optional human-readable expression text */
    expression?: string | null;
    outcome: "allow" | "deny" | "filter";
    reason: string;
  }): void;

  // ── Extra namespaces (phase 2: PocketBase JSVM parity) ────────────────────
  security: {
    /** Hex digest of \`data\`. */
    hash(alg: "sha256" | "sha384" | "sha512", data: string | Uint8Array): Promise<string>;
    /** Hex HMAC of \`data\` with \`key\`. */
    hmac(alg: "sha256" | "sha384" | "sha512", key: string | Uint8Array, data: string | Uint8Array): Promise<string>;
    /** Random hex (default) or base64url string. \`byteLen\` is the entropy in bytes. */
    randomString(byteLen: number, alphabet?: "hex" | "base64url"): string;
    randomBytes(len: number): Uint8Array;
    /** Sign a JWT (HS256). \`expiresIn\` accepts seconds or "1h", "7d", etc. */
    jwtSign(
      payload: Record<string, unknown>,
      secret: string,
      opts?: { expiresIn?: number | string; issuer?: string; audience?: string }
    ): Promise<string>;
    /** Verify a JWT (HS256). Throws on failure. */
    jwtVerify(
      token: string,
      secret: string,
      opts?: { issuer?: string; audience?: string }
    ): Promise<Record<string, unknown>>;
    /** AES-GCM encrypt with the server-configured key. */
    aesEncrypt(plaintext: string): Promise<string>;
    aesDecrypt(ciphertext: string): Promise<string>;
    constantTimeEqual(a: string, b: string): boolean;
  };
  path: {
    join(...parts: string[]): string;
    basename(p: string, ext?: string): string;
    dirname(p: string): string;
    /** Extension including the leading dot ("" if none). */
    ext(p: string): string;
    normalize(p: string): string;
  };
  template: {
    /** Render \`{{var}}\` and \`{{#if path}}...{{/if}}\` against \`vars\`. NOT html-escaped. */
    render(template: string, vars: Record<string, unknown>): string;
    escapeHtml(s: string): string;
  };
  http: {
    request(opts: {
      url: string;
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
      headers?: Record<string, string>;
      body?: string | Uint8Array | Record<string, unknown> | null;
      json?: boolean;
      retries?: number;
      retryDelayMs?: number;
      timeoutMs?: number;
    }): Promise<{
      status: number;
      ok: boolean;
      headers: Record<string, string>;
      text: string;
      json?: unknown;
    }>;
    getJson<T = unknown>(url: string, headers?: Record<string, string>): Promise<T>;
    postJson<T = unknown>(url: string, body: unknown, headers?: Record<string, string>): Promise<T>;
  };
  util: {
    sleep(ms: number): Promise<void>;
    /** Safe JSON.parse — returns null on invalid input. */
    unmarshal<T = unknown>(s: string): T | null;
    readerToString(input: ReadableStream<Uint8Array> | Response): Promise<string>;
  };
  db: {
    /** Run a SELECT and return rows. Bind params positionally (\`?\`) or named (\`:name\`). */
    query<T = Record<string, any>>(sql: string, ...params: any[]): T[];
    queryOne<T = Record<string, any>>(sql: string, ...params: any[]): T | null;
    /** Run INSERT / UPDATE / DELETE. */
    exec(sql: string, ...params: any[]): { changes: number; lastInsertRowid: number | bigint };
    /** Run multiple statements at once (no parameters). For migrations only. */
    execMulti(sql: string): void;
  };
  fs: {
    /** Read file as UTF-8 text. */
    read(path: string): Promise<string>;
    readBytes(path: string): Promise<Uint8Array>;
    /** Write file (overwrites). Creates parent dir if missing. */
    write(path: string, data: string | Uint8Array): Promise<void>;
    append(path: string, data: string | Uint8Array): Promise<void>;
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<{ size: number; isFile: boolean; isDirectory: boolean; mtime: number }>;
    list(dir: string): Promise<string[]>;
    mkdir(dir: string, opts?: { recursive?: boolean }): Promise<void>;
    remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
    copy(src: string, dst: string): Promise<void>;
    /** Best-effort MIME type guess from extension. */
    mimeOf(path: string): string;
  };
  os: {
    env(name: string): string;
    cwd(): string;
    platform(): string;
    arch(): string;
    hostname(): string;
  };
  mails: {
    send(opts: {
      to: string;
      cc?: string;
      bcc?: string;
      replyTo?: string;
      from?: string;
      subject: string;
      text?: string;
      html?: string;
      attachments?: Array<{
        filename: string;
        content: string | Uint8Array;
        contentType?: string;
      }>;
    }): Promise<{ messageId: string }>;
  };
  cron: {
    /** Add or replace a cron job by name. Schedule is standard 5-field UTC cron. */
    add(opts: {
      name: string;
      schedule: string;
      code: string;
      enabled?: boolean;
    }): Promise<{ id: string }>;
    /** Remove a cron job by name. */
    remove(name: string): Promise<boolean>;
    list(): Promise<{ id: string; name: string; schedule: string; enabled: boolean }[]>;
  };
}
`;

function tsTypeForField(f: FieldDef): string {
  switch (f.type) {
    case "number":           return "number";
    case "bool":             return "boolean";
    case "date":
    case "autodate":         return "number";
    case "select":           return f.options?.multiple ? "string[]" : "string";
    case "json":             return "any";
    case "file":
    case "relation":         return "string";
    default:                 return "string";
  }
}

function buildRecordType(collectionName: string, fields: FieldDef[]): string {
  const userFields = fields.filter((f) => !f.system);
  const propLines = userFields.map((f) => {
    const opt = f.required ? "" : "?";
    return `  /** ${f.type}${f.options?.unique ? " · unique" : ""} */\n  ${JSON.stringify(f.name)}${opt}: ${tsTypeForField(f)};`;
  });
  return `
interface ${collectionName}Record {
  id: string;
  created_at: number;
  updated_at: number;
${propLines.join("\n")}
  /** dynamic / unknown fields */
  [key: string]: any;
}
`;
}

function buildCtxDecl(collectionName: string | null, fields: FieldDef[]): string {
  let recordTypeName = "Record<string, any>";
  let extraInterface = "";
  if (collectionName && collectionName !== "" && fields.length > 0) {
    recordTypeName = `${collectionName}Record`;
    extraInterface = buildRecordType(collectionName, fields);
  }
  return `
${HOOK_BASE_DECL}
${extraInterface}

interface HookContext {
  /** Record being processed. Mutable in before* hooks. */
  record: ${recordTypeName};
  /** Existing record (only in beforeUpdate / beforeDelete) */
  existing: ${recordTypeName} | null;
  /** Authenticated user/admin or null */
  auth: AuthContext | null;
  /** Helper utilities */
  helpers: HookHelpers;
}

declare const ctx: HookContext;
`;
}

function buildJobCtxDecl(): string {
  return `
${HOOK_BASE_DECL}

interface JobContext {
  /** Helper utilities (same as hook helpers) */
  helpers: HookHelpers;
  /** Unix seconds when this run was scheduled */
  scheduledAt: number;
}

declare const ctx: JobContext;
`;
}

function buildWorkerCtxDecl(): string {
  return `
${HOOK_BASE_DECL}

interface WorkerContext {
  /** The enqueued payload, JSON-decoded */
  payload: any;
  /** 1-indexed attempt counter (incremented on each retry) */
  attempt: number;
  /** Queue name this job came from */
  queue: string;
  /** Job id (matches the row in vaultbase_jobs_log) */
  jobId: string;
  /** Helper utilities (same as hook helpers) */
  helpers: HookHelpers;
}

declare const ctx: WorkerContext;
`;
}

function buildRouteCtxDecl(): string {
  return `
${HOOK_BASE_DECL}

interface RouteContext {
  /** Raw Request object */
  req: Request;
  /** HTTP method (GET, POST, …) */
  method: string;
  /** Inner path (after the /api/v1/custom prefix) */
  path: string;
  /** Path params from :name segments */
  params: Record<string, string>;
  /** Query string params */
  query: Record<string, string>;
  /** Parsed JSON body (or text/null) */
  body: any;
  /** Authenticated user/admin or null */
  auth: AuthContext | null;
  /** Helper utilities (same as hook helpers) */
  helpers: HookHelpers;
  /** Mutate to set response status / headers */
  set: { status: number; headers: Record<string, string> };
}

declare const ctx: RouteContext;
`;
}

// ── SQL completion + hover providers ────────────────────────────────────────

import { analyzeContext, buildAliasMap } from "../../../src/sql/sql-context.ts";
import { meaningful, tokenize } from "../../../src/sql/sql-tokenizer.ts";
import { SQL_FUNCTIONS, type SqlFunction } from "../../../src/sql/sql-functions.ts";
import { SQL_KEYWORDS, SQL_SNIPPETS } from "../../../src/sql/sql-keywords.ts";

export interface SqlColumn {
  name: string;
  /** SQLite affinity / declared type (e.g. "TEXT", "INTEGER"). */
  type?: string;
  /** True when NOT NULL. */
  notnull?: boolean;
  /** True when this column participates in the primary key. */
  pk?: boolean;
  /** True when at least one index covers this column. */
  indexed?: boolean;
  /** Default value SQL fragment (or null for none). */
  dflt?: string | null;
}

export interface SqlSchemaIndex {
  name: string;
  cols: string[];
  unique?: boolean;
  partial?: boolean;
}

export interface SqlSchemaForeignKey {
  col: string;
  refTable: string;
  refCol: string;
}

export interface SqlSchemaTable {
  /** Real table/view name (e.g. "vb_posts"). */
  name: string;
  /** What kind of object this is. */
  type?: "table" | "view";
  /** Source category — drives icon + hover-label tone. */
  kind?: "collection" | "system" | "user" | "sqlite";
  /** User-facing collection name shown in completion details. */
  collectionName?: string;
  /** Accepts simple string list (legacy) OR rich SqlColumn list. */
  columns: ReadonlyArray<string | SqlColumn>;
  indexes?: SqlSchemaIndex[];
  foreignKeys?: SqlSchemaForeignKey[];
  rowCount?: number;
}

export interface SqlSchema {
  tables: SqlSchemaTable[];
}

interface NormalisedTable {
  name: string;
  type: "table" | "view";
  kind: "collection" | "system" | "user" | "sqlite";
  collectionName?: string;
  columns: SqlColumn[];
  indexes: SqlSchemaIndex[];
  foreignKeys: SqlSchemaForeignKey[];
  rowCount?: number;
}

let sqlCompletionDisposable: monaco.IDisposable | null = null;
let sqlHoverDisposable: monaco.IDisposable | null = null;
let activeTables: NormalisedTable[] = [];

function normaliseTable(t: SqlSchemaTable): NormalisedTable {
  const cols: SqlColumn[] = t.columns.map((c) => typeof c === "string" ? { name: c } : c);
  const out: NormalisedTable = {
    name: t.name,
    type: t.type ?? "table",
    kind: t.kind ?? (t.collectionName ? "collection" : "user"),
    columns: cols,
    indexes: t.indexes ?? [],
    foreignKeys: t.foreignKeys ?? [],
  };
  if (t.collectionName !== undefined) out.collectionName = t.collectionName;
  if (t.rowCount !== undefined) out.rowCount = t.rowCount;
  return out;
}

function findTable(ref: string): NormalisedTable | null {
  const lower = ref.toLowerCase();
  // Exact name match first, then collection name, then vb_<collection>.
  return activeTables.find((t) => t.name.toLowerCase() === lower) ??
         activeTables.find((t) => (t.collectionName ?? "").toLowerCase() === lower) ??
         activeTables.find((t) => `vb_${(t.collectionName ?? "").toLowerCase()}` === lower) ??
         null;
}

function tableIcon(kind: NormalisedTable["kind"]): monaco.languages.CompletionItemKind {
  if (kind === "collection") return monaco.languages.CompletionItemKind.Class;
  if (kind === "system" || kind === "sqlite") return monaco.languages.CompletionItemKind.Module;
  return monaco.languages.CompletionItemKind.Struct;
}

function columnDetail(t: NormalisedTable, col: SqlColumn): string {
  const parts: string[] = [`${t.name}.${col.name}`];
  const tags: string[] = [];
  if (col.type) tags.push(col.type);
  if (col.pk) tags.push("PK");
  if (col.notnull && !col.pk) tags.push("NOT NULL");
  if (col.indexed && !col.pk) tags.push("indexed");
  if (tags.length) parts.push(tags.join(" "));
  return parts.join("  ·  ");
}

function tableDetail(t: NormalisedTable): string {
  const tags: string[] = [t.type];
  if (t.kind === "collection") tags.push("collection");
  else if (t.kind === "system") tags.push("vaultbase");
  else if (t.kind === "sqlite") tags.push("sqlite");
  if (typeof t.rowCount === "number") tags.push(`${t.rowCount} rows`);
  return tags.join(" · ");
}

function tableHoverMd(t: NormalisedTable): string {
  const lines: string[] = [];
  const tags: string[] = [t.type];
  if (t.kind === "collection" && t.collectionName) tags.push(`collection \`${t.collectionName}\``);
  else if (t.kind === "system") tags.push("vaultbase system");
  else if (t.kind === "sqlite") tags.push("sqlite internal");
  lines.push(`**${t.name}** — ${tags.join(" · ")}`);
  if (typeof t.rowCount === "number") lines.push(`\n${t.rowCount} row${t.rowCount === 1 ? "" : "s"}\n`);
  if (t.columns.length > 0) {
    lines.push("");
    lines.push("| Column | Type | |");
    lines.push("|---|---|---|");
    for (const c of t.columns) {
      const tags: string[] = [];
      if (c.pk) tags.push("PK");
      if (c.notnull && !c.pk) tags.push("NOT NULL");
      if (c.indexed && !c.pk) tags.push("indexed");
      lines.push(`| \`${c.name}\` | ${c.type ?? ""} | ${tags.join(" · ")} |`);
    }
  }
  if (t.foreignKeys.length > 0) {
    lines.push("");
    lines.push("**Foreign keys**");
    for (const fk of t.foreignKeys) {
      lines.push(`- \`${fk.col}\` → \`${fk.refTable}.${fk.refCol}\``);
    }
  }
  if (t.indexes.length > 0) {
    lines.push("");
    lines.push("**Indexes**");
    for (const i of t.indexes) {
      lines.push(`- \`${i.name}\`(${i.cols.join(", ")})${i.unique ? " · unique" : ""}${i.partial ? " · partial" : ""}`);
    }
  }
  return lines.join("\n");
}

function columnHoverMd(t: NormalisedTable, c: SqlColumn): string {
  const tags: string[] = [];
  if (c.pk) tags.push("PRIMARY KEY");
  if (c.notnull && !c.pk) tags.push("NOT NULL");
  if (c.indexed && !c.pk) tags.push("indexed");
  if (c.dflt !== null && c.dflt !== undefined) tags.push(`default ${c.dflt}`);
  const fk = t.foreignKeys.find((f) => f.col === c.name);
  if (fk) tags.push(`FK → \`${fk.refTable}.${fk.refCol}\``);
  return [
    `**${t.name}.${c.name}** — \`${c.type ?? "ANY"}\``,
    "",
    tags.length ? tags.map((s) => `- ${s}`).join("\n") : "_no extra metadata_",
    "",
    `Part of \`${t.name}\` ${t.kind === "collection" ? `(collection: \`${t.collectionName ?? ""}\`)` : ""}`,
  ].join("\n");
}

function functionHoverMd(fn: SqlFunction): string {
  return [
    `**${fn.name}** — \`${fn.signature}\``,
    "",
    fn.description,
    "",
    `_${fn.category}${fn.returns ? ` · returns ${fn.returns}` : ""}_`,
  ].join("\n");
}

function setSqlSchema(schema: SqlSchema): void {
  activeTables = schema.tables.map(normaliseTable);
  if (sqlCompletionDisposable) return; // providers close over activeTables; nothing to re-bind

  sqlCompletionDisposable = monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: [".", " ", "(", ","],
    provideCompletionItems(model, position) {
      const offset = model.getOffsetAt(position);
      const src = model.getValue();
      const tokens = meaningful(tokenize(src));
      const { context, prefix, prefixStart } = analyzeContext({ src, offset, tokens });
      const aliases = buildAliasMap(src, tokens);

      // Suppress completions inside string literals — analyzeContext doesn't
      // strip them but we can quickly check token type at offset.
      // (cheap heuristic; not perfect)

      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      void prefix; void prefixStart; // Monaco filters on its own

      const suggestions: monaco.languages.CompletionItem[] = [];

      const pushTable = (t: NormalisedTable, sortPrefix: string) => {
        suggestions.push({
          label: { label: t.name, description: tableDetail(t) },
          kind: tableIcon(t.kind),
          insertText: t.name,
          range,
          detail: tableDetail(t),
          documentation: { value: tableHoverMd(t), isTrusted: false },
          sortText: `${sortPrefix}${t.name}`,
        });
      };

      const pushColumn = (t: NormalisedTable, c: SqlColumn, sortPrefix: string) => {
        suggestions.push({
          label: { label: c.name, description: columnDetail(t, c) },
          kind: monaco.languages.CompletionItemKind.Field,
          insertText: c.name,
          range,
          detail: columnDetail(t, c),
          documentation: { value: columnHoverMd(t, c), isTrusted: false },
          sortText: `${sortPrefix}${c.name}`,
        });
      };

      const pushFunctions = (sortPrefix: string) => {
        for (const fn of SQL_FUNCTIONS) {
          suggestions.push({
            label: { label: fn.name, description: fn.signature },
            kind: monaco.languages.CompletionItemKind.Function,
            insertText: `${fn.name}($1)`,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
            detail: `${fn.signature}${fn.returns ? ` → ${fn.returns}` : ""}`,
            documentation: { value: functionHoverMd(fn), isTrusted: false },
            sortText: `${sortPrefix}${fn.name}`,
          });
        }
      };

      const pushKeywords = (sortPrefix: string) => {
        for (const kw of SQL_KEYWORDS) {
          suggestions.push({
            label: kw,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: kw,
            range,
            sortText: `${sortPrefix}${kw}`,
          });
        }
      };

      const pushSnippets = (sortPrefix: string) => {
        for (const sn of SQL_SNIPPETS) {
          suggestions.push({
            label: { label: sn.label, description: sn.detail },
            kind: monaco.languages.CompletionItemKind.Snippet,
            insertText: sn.insertText,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
            detail: sn.detail,
            documentation: sn.documentation,
            sortText: `${sortPrefix}${sn.label}`,
          });
        }
      };

      // Tables currently in scope — those referenced by FROM/JOIN/etc.
      const inScope = new Set<NormalisedTable>();
      for (const ref of aliases.values()) {
        const t = findTable(ref);
        if (t) inScope.add(t);
      }

      switch (context.kind) {
        case "afterDot": {
          const realName = aliases.get(context.base) ?? context.base;
          const t = findTable(realName);
          if (!t) return { suggestions: [] };
          for (const c of t.columns) pushColumn(t, c, "0");
          return { suggestions };
        }

        case "expectTable": {
          for (const t of activeTables) {
            // Order: collection → user → system → sqlite
            const order = t.kind === "collection" ? "0" : t.kind === "user" ? "1" : t.kind === "system" ? "2" : "3";
            pushTable(t, order);
          }
          // CTE names (WITH …) are alias-style — useful too.
          for (const a of aliases.keys()) {
            if (!findTable(a)) {
              suggestions.push({
                label: { label: a, description: "alias" },
                kind: monaco.languages.CompletionItemKind.Reference,
                insertText: a,
                range,
                detail: "alias",
                sortText: `0_${a}`,
              });
            }
          }
          return { suggestions };
        }

        case "expectColumn": {
          // Columns of every in-scope table; collisions rendered as
          // `alias.col` so the user can disambiguate.
          if (inScope.size === 0) {
            // No FROM yet — fall back to all columns. Useful for ad-hoc
            // exploration when the user starts typing column names first.
            for (const t of activeTables) {
              for (const c of t.columns) pushColumn(t, c, "1");
            }
          } else {
            const seen = new Map<string, NormalisedTable[]>();
            for (const t of inScope) {
              for (const c of t.columns) {
                const arr = seen.get(c.name) ?? [];
                arr.push(t);
                seen.set(c.name, arr);
              }
            }
            for (const t of inScope) {
              for (const c of t.columns) {
                const dupes = seen.get(c.name);
                if (dupes && dupes.length > 1) {
                  // Disambiguate: insert as `<alias>.<col>` if user has an alias
                  // for this table; otherwise full table name.
                  let alias = t.name;
                  for (const [a, target] of aliases) {
                    if (target === t.name && a !== t.name) { alias = a; break; }
                  }
                  suggestions.push({
                    label: { label: c.name, description: `${alias}.${c.name} (${c.type ?? ""})` },
                    kind: monaco.languages.CompletionItemKind.Field,
                    insertText: `${alias}.${c.name}`,
                    range,
                    detail: columnDetail(t, c),
                    documentation: { value: columnHoverMd(t, c), isTrusted: false },
                    sortText: `0_${alias}.${c.name}`,
                  });
                } else {
                  pushColumn(t, c, "0");
                }
              }
            }
          }
          pushFunctions("3");
          pushKeywords("4");
          return { suggestions };
        }

        case "expectAny":
        default: {
          // Broad set — tables, keywords, functions, snippets.
          for (const t of activeTables) {
            const order = t.kind === "collection" ? "0" : t.kind === "user" ? "1" : t.kind === "system" ? "3" : "4";
            pushTable(t, order);
          }
          pushKeywords("2");
          pushFunctions("5");
          pushSnippets("0_");
          return { suggestions };
        }
      }
    },
  });

  sqlHoverDisposable = monaco.languages.registerHoverProvider("sql", {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const offset = model.getOffsetAt({ lineNumber: position.lineNumber, column: word.startColumn });
      const src = model.getValue();
      const tokens = meaningful(tokenize(src));
      const aliases = buildAliasMap(src, tokens);

      // Quoted-ident case: peek char right before the word, may be `.`
      const before = position.column > 1
        ? model.getValueInRange({
            startLineNumber: position.lineNumber, startColumn: 1,
            endLineNumber: position.lineNumber, endColumn: word.startColumn,
          })
        : "";
      const dotMatch = before.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*$/);
      void offset; // analyzeContext not called for hover; we only need word + dot

      // <table|alias>.<column>
      if (dotMatch) {
        const baseRaw = dotMatch[1]!;
        const realName = aliases.get(baseRaw) ?? baseRaw;
        const t = findTable(realName);
        if (t) {
          const col = t.columns.find((c) => c.name.toLowerCase() === word.word.toLowerCase());
          if (col) {
            return {
              range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
              contents: [{ value: columnHoverMd(t, col) }],
            };
          }
        }
      }

      // Bare identifier — try table, then column-from-any-in-scope table, then function.
      const directTable = findTable(word.word);
      if (directTable) {
        return {
          range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
          contents: [{ value: tableHoverMd(directTable) }],
        };
      }
      // Column lookup across in-scope tables.
      const inScope = new Set<NormalisedTable>();
      for (const ref of aliases.values()) {
        const t = findTable(ref);
        if (t) inScope.add(t);
      }
      for (const t of inScope) {
        const col = t.columns.find((c) => c.name.toLowerCase() === word.word.toLowerCase());
        if (col) {
          return {
            range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
            contents: [{ value: columnHoverMd(t, col) }],
          };
        }
      }
      // Function?
      const fn = SQL_FUNCTIONS.find((f) => f.name.toLowerCase() === word.word.toLowerCase());
      if (fn) {
        return {
          range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
          contents: [{ value: functionHoverMd(fn) }],
        };
      }
      return null;
    },
  });
  void sqlHoverDisposable;
}

// ── Component ──────────────────────────────────────────────────────────────

export interface CodeEditorProps {
  value: string;
  onChange: (v: string) => void;
  language?: "javascript" | "typescript" | "json" | "sql";
  height?: number | string;
  hookContext?: boolean;
  hookCollectionName?: string | null;
  hookFields?: FieldDef[];
  routeContext?: boolean;
  jobContext?: boolean;
  workerContext?: boolean;
  /** Schema for SQL autocomplete — tables + columns. */
  sqlSchema?: SqlSchema;
  /** Diagnostic markers to publish on the model (e.g. SQL parse errors from server). */
  markers?: Array<{
    message: string;
    line?: number;
    column?: number;
    severity?: "error" | "warning" | "info";
  }>;
  readOnly?: boolean;
  /** Render a status strip below the editor (cursor pos, lang, ok/error count). */
  statusStrip?: boolean;
  /** File-name shown in the optional toolbar tab strip. */
  fileName?: string;
}

export function CodeEditor({
  value,
  onChange,
  language = "javascript",
  height = 320,
  hookContext = false,
  hookCollectionName = null,
  hookFields = [],
  routeContext = false,
  jobContext = false,
  workerContext = false,
  sqlSchema,
  markers,
  readOnly = false,
  statusStrip = false,
  fileName,
}: CodeEditorProps) {
  const disposableRef = useRef<monaco.IDisposable | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const [cursor, setCursor] = useState<{ line: number; col: number }>({ line: 1, col: 1 });
  const [problems, setProblems] = useState<{ errors: number; warnings: number }>({ errors: 0, warnings: 0 });

  // Re-inject ctx types when context changes
  useEffect(() => {
    if (!hookContext && !routeContext && !jobContext && !workerContext) return;
    disposableRef.current?.dispose();
    const decl = workerContext
      ? buildWorkerCtxDecl()
      : jobContext
      ? buildJobCtxDecl()
      : routeContext
      ? buildRouteCtxDecl()
      : buildCtxDecl(hookCollectionName, hookFields);
    disposableRef.current = ts.javascriptDefaults.addExtraLib(decl, "vaultbase-ctx.d.ts");
    return () => {
      disposableRef.current?.dispose();
      disposableRef.current = null;
    };
  }, [hookContext, routeContext, jobContext, workerContext, hookCollectionName, JSON.stringify(hookFields)]);

  // Refresh SQL schema for the global completion provider whenever it changes.
  useEffect(() => {
    if (language !== "sql" || !sqlSchema) return;
    setSqlSchema(sqlSchema);
  }, [language, JSON.stringify(sqlSchema)]);

  // Publish error markers on the active model.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    const owner = "vaultbase-sql";
    if (!markers || markers.length === 0) {
      monaco.editor.setModelMarkers(model, owner, []);
      return;
    }
    const sev = (s: "error" | "warning" | "info" | undefined) =>
      s === "warning" ? monaco.MarkerSeverity.Warning
      : s === "info"  ? monaco.MarkerSeverity.Info
      : monaco.MarkerSeverity.Error;
    monaco.editor.setModelMarkers(
      model,
      owner,
      markers.map((m) => {
        const line = Math.max(1, m.line ?? 1);
        const lineLen = model.getLineMaxColumn(Math.min(line, model.getLineCount()));
        return {
          message: m.message,
          severity: sev(m.severity),
          startLineNumber: line,
          startColumn: m.column ?? 1,
          endLineNumber: line,
          endColumn: lineLen,
        };
      })
    );
  }, [JSON.stringify(markers)]);

  const handleBeforeMount: BeforeMount = (m) => {
    // Make sure the bundled monaco's theme is applied even if the editor instance
    // somehow ended up using the loader-fetched one.
    m.editor.setTheme("vaultbase-dark");
  };

  const handleMount: OnMount = (editor, m) => {
    editorRef.current = editor;
    m.editor.setTheme("vaultbase-dark");
    if (!statusStrip) return;
    editor.onDidChangeCursorPosition((e) => {
      setCursor({ line: e.position.lineNumber, col: e.position.column });
    });
    const updateProblems = () => {
      const model = editor.getModel();
      if (!model) return;
      const all = m.editor.getModelMarkers({ resource: model.uri });
      let errors = 0, warnings = 0;
      for (const mk of all) {
        if (mk.severity === m.MarkerSeverity.Error) errors++;
        else if (mk.severity === m.MarkerSeverity.Warning) warnings++;
      }
      setProblems({ errors, warnings });
    };
    updateProblems();
    m.editor.onDidChangeMarkers(updateProblems);
  };

  const wrapperHeight = typeof height === "number" ? `${height}px` : height;

  return (
    <div
      className="vb-editor"
      style={{
        height: wrapperHeight,
        minHeight: 200,
      }}
    >
      {fileName !== undefined && (
        <div className="vb-editor-bar">
          <span className="vb-editor-tab on">{fileName}</span>
        </div>
      )}
      <div className="vb-editor-body">
      <Editor
        height="100%"
        defaultLanguage={language}
        language={language}
        value={value}
        onChange={(v) => onChange(v ?? "")}
        beforeMount={handleBeforeMount}
        onMount={handleMount}
        theme="vaultbase-dark"
        loading={
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-muted)", fontSize: 12, background: "#1f1f1f" }}>
            Loading editor…
          </div>
        }
        options={{
          fontFamily: "JetBrains Mono, SF Mono, ui-monospace, monospace",
          fontSize: 13,
          lineHeight: 1.6,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          cursorBlinking: "smooth",
          renderLineHighlight: "line",
          tabSize: 2,
          wordWrap: "on",
          padding: { top: 12, bottom: 12 },
          quickSuggestions: { other: true, comments: false, strings: true },
          suggestOnTriggerCharacters: true,
          acceptSuggestionOnEnter: "on",
          acceptSuggestionOnCommitCharacter: true,
          parameterHints: { enabled: true, cycle: true },
          formatOnPaste: true,
          formatOnType: true,
          bracketPairColorization: { enabled: true },
          guides: { bracketPairs: true, indentation: true },
          readOnly,
        }}
      />
      </div>
      {statusStrip && (
        <div className="vb-editor-status">
          <span className="ok-dot" data-ok={problems.errors === 0 ? "true" : "false"} />
          <span>
            {problems.errors === 0 && problems.warnings === 0
              ? "ok"
              : `${problems.errors} error${problems.errors === 1 ? "" : "s"}` +
                (problems.warnings ? ` · ${problems.warnings} warning${problems.warnings === 1 ? "" : "s"}` : "")}
          </span>
          <span className="sep">·</span>
          <span>{language}</span>
          <span className="spacer" />
          <span>Ln {cursor.line}, Col {cursor.col}</span>
        </div>
      )}
    </div>
  );
}
