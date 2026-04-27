import { useEffect, useRef } from "react";
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

function buildRouteCtxDecl(): string {
  return `
${HOOK_BASE_DECL}

interface RouteContext {
  /** Raw Request object */
  req: Request;
  /** HTTP method (GET, POST, …) */
  method: string;
  /** Inner path (after the /api/custom prefix) */
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

// ── Component ──────────────────────────────────────────────────────────────

export interface CodeEditorProps {
  value: string;
  onChange: (v: string) => void;
  language?: "javascript" | "typescript" | "json";
  height?: number | string;
  hookContext?: boolean;
  hookCollectionName?: string | null;
  hookFields?: FieldDef[];
  routeContext?: boolean;
  jobContext?: boolean;
  readOnly?: boolean;
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
  readOnly = false,
}: CodeEditorProps) {
  const disposableRef = useRef<monaco.IDisposable | null>(null);

  // Re-inject ctx types when context changes
  useEffect(() => {
    if (!hookContext && !routeContext && !jobContext) return;
    disposableRef.current?.dispose();
    const decl = jobContext
      ? buildJobCtxDecl()
      : routeContext
      ? buildRouteCtxDecl()
      : buildCtxDecl(hookCollectionName, hookFields);
    disposableRef.current = ts.javascriptDefaults.addExtraLib(decl, "vaultbase-ctx.d.ts");
    return () => {
      disposableRef.current?.dispose();
      disposableRef.current = null;
    };
  }, [hookContext, routeContext, jobContext, hookCollectionName, JSON.stringify(hookFields)]);

  const handleBeforeMount: BeforeMount = (m) => {
    // Make sure the bundled monaco's theme is applied even if the editor instance
    // somehow ended up using the loader-fetched one.
    m.editor.setTheme("vaultbase-dark");
  };

  const handleMount: OnMount = (_editor, m) => {
    m.editor.setTheme("vaultbase-dark");
  };

  return (
    <div
      style={{
        border: "0.5px solid var(--border-default)",
        borderRadius: 7,
        overflow: "hidden",
        background: "#1f1f1f",
        height: typeof height === "number" ? `${height}px` : height,
        minHeight: 200,
      }}
    >
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
  );
}
