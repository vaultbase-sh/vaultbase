import { useEffect, useRef } from "react";
import Editor, { useMonaco, type OnMount } from "@monaco-editor/react";
import type * as MonacoNs from "monaco-editor";
import type { IDisposable } from "monaco-editor";
import type { FieldDef } from "../api.ts";

type Monaco = typeof MonacoNs;

// ── Type declarations injected into Monaco ──────────────────────────────────

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
    case "select":
      return f.options?.multiple ? "string[]" : "string";
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
    return `  /** field type: ${f.type} */\n  ${JSON.stringify(f.name)}${opt}: ${tsTypeForField(f)};`;
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

// ── Theme ──────────────────────────────────────────────────────────────────

let themeRegistered = false;
function ensureTheme(monaco: Monaco) {
  if (themeRegistered) return;
  monaco.editor.defineTheme("vaultbase-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6b7280", fontStyle: "italic" },
      { token: "string", foreground: "87b47e" },
      { token: "number", foreground: "86b9bb" },
      { token: "keyword", foreground: "b3703d" },
      { token: "type", foreground: "1fd2ff" },
      { token: "type.identifier", foreground: "1fd2ff" },
      { token: "identifier", foreground: "e6e6e6" },
      { token: "delimiter", foreground: "8b8b8b" },
      { token: "operator", foreground: "d4d4d4" },
    ],
    colors: {
      "editor.background": "#1f1f1f",
      "editor.foreground": "#e6e6e6",
      "editorLineNumber.foreground": "#525252",
      "editorLineNumber.activeForeground": "#a3a3a3",
      "editor.selectionBackground": "#1fd2ff33",
      "editor.lineHighlightBackground": "#ffffff05",
      "editorCursor.foreground": "#1fd2ff",
      "editorIndentGuide.background1": "#2a2a2a",
      "editorWidget.background": "#262626",
      "editorWidget.border": "#3a3a3a",
      "editorSuggestWidget.background": "#262626",
      "editorSuggestWidget.border": "#3a3a3a",
      "editorSuggestWidget.foreground": "#e6e6e6",
      "editorSuggestWidget.selectedBackground": "#1fd2ff22",
      "editorSuggestWidget.highlightForeground": "#1fd2ff",
      "editorHoverWidget.background": "#262626",
      "editorHoverWidget.border": "#3a3a3a",
      "scrollbarSlider.background": "#ffffff15",
      "scrollbarSlider.hoverBackground": "#ffffff22",
      "scrollbarSlider.activeBackground": "#ffffff33",
      "editorBracketMatch.background": "#1fd2ff22",
      "editorBracketMatch.border": "#1fd2ff",
    },
  });
  themeRegistered = true;
}

// Monaco's TS service types were removed from monaco-editor's public d.ts.
// The runtime API still works — cast at the call site.
type TsLanguageService = {
  javascriptDefaults: {
    setCompilerOptions(opts: Record<string, unknown>): void;
    setDiagnosticsOptions(opts: { noSemanticValidation: boolean; noSyntaxValidation: boolean }): void;
    addExtraLib(content: string, filename: string): IDisposable;
  };
  ScriptTarget: { ES2022: number };
  ModuleResolutionKind: { NodeJs: number };
};

function tsApi(monaco: Monaco): TsLanguageService {
  return (monaco.languages.typescript as unknown) as TsLanguageService;
}

let compilerOptionsSet = false;
function ensureCompilerOptions(monaco: Monaco) {
  if (compilerOptionsSet) return;
  const ts = tsApi(monaco);
  ts.javascriptDefaults.setCompilerOptions({
    target: ts.ScriptTarget.ES2022,
    allowJs: true,
    checkJs: false,
    noLib: false,
    lib: ["es2022", "dom"],
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
  });
  ts.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  });
  compilerOptionsSet = true;
}

// ── Component ──────────────────────────────────────────────────────────────

export interface CodeEditorProps {
  value: string;
  onChange: (v: string) => void;
  language?: "javascript" | "typescript" | "json";
  height?: number | string;
  /** Inject hook ctx ambient types for autocomplete */
  hookContext?: boolean;
  /** When set, generates a typed record interface for ctx.record */
  hookCollectionName?: string | null;
  /** Schema fields for the collection — used to type ctx.record */
  hookFields?: FieldDef[];
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
  readOnly = false,
}: CodeEditorProps) {
  const monaco = useMonaco();
  const disposableRef = useRef<IDisposable | null>(null);

  // Re-inject types whenever collection / fields change
  useEffect(() => {
    if (!monaco || !hookContext) return;
    ensureCompilerOptions(monaco);
    // Dispose previous declaration
    disposableRef.current?.dispose();
    const decl = buildCtxDecl(hookCollectionName, hookFields);
    disposableRef.current = tsApi(monaco).javascriptDefaults.addExtraLib(
      decl,
      "vaultbase-ctx.d.ts"
    );
    return () => {
      disposableRef.current?.dispose();
      disposableRef.current = null;
    };
  }, [monaco, hookContext, hookCollectionName, JSON.stringify(hookFields)]);

  const handleMount: OnMount = (_editor, monacoInstance) => {
    ensureTheme(monacoInstance);
  };

  return (
    <div
      style={{
        border: "0.5px solid var(--border-default)",
        borderRadius: 7,
        overflow: "hidden",
        background: "#1f1f1f",
        height: typeof height === "number" ? `${height}px` : height,
      }}
    >
      <Editor
        height="100%"
        defaultLanguage={language}
        language={language}
        value={value}
        onChange={(v) => onChange(v ?? "")}
        onMount={handleMount}
        theme="vaultbase-dark"
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
