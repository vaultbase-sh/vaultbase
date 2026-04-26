import { useEffect, useRef } from "react";
import Editor, { useMonaco, type OnMount, type Monaco } from "@monaco-editor/react";

const HOOK_CTX_DECL = `
declare global {
  interface AuthContext {
    /** Authenticated user/admin id, or null when anonymous */
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
    find(collection: string, id: string): Promise<Record<string, unknown> | null>;
    /** Query records in a collection */
    query(
      collection: string,
      opts?: { filter?: string; sort?: string; perPage?: number }
    ): Promise<{ data: Record<string, unknown>[]; totalItems: number }>;
    /** Outbound HTTP fetch */
    fetch(input: string | URL, init?: RequestInit): Promise<Response>;
    /** Server-side log message */
    log(...args: unknown[]): void;
    /** Send email (pending SMTP) */
    email(opts: { to: string; subject: string; body: string }): Promise<void>;
  }

  interface HookContext {
    /** Record being processed. Mutable in before* hooks. */
    record: Record<string, any>;
    /** Existing record (only in beforeUpdate / beforeDelete) */
    existing: Record<string, any> | null;
    /** Authenticated user/admin or null */
    auth: AuthContext | null;
    /** Helper utilities */
    helpers: HookHelpers;
  }

  /** Hook context — available inside every hook */
  const ctx: HookContext;
}
export {};
`;

let declAdded = false;

function attachHookTypes(monaco: Monaco) {
  if (declAdded) return;
  monaco.languages.typescript.javascriptDefaults.addExtraLib(HOOK_CTX_DECL, "vaultbase-ctx.d.ts");
  monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
    target: monaco.languages.typescript.ScriptTarget.ES2022,
    allowJs: true,
    checkJs: false,
    noLib: false,
    lib: ["es2022", "dom"],
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
  });
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
  });
  declAdded = true;
}

export interface CodeEditorProps {
  value: string;
  onChange: (v: string) => void;
  language?: "javascript" | "typescript" | "json";
  height?: number | string;
  /** Inject hook ctx ambient types for autocomplete */
  hookContext?: boolean;
  readOnly?: boolean;
}

export function CodeEditor({
  value,
  onChange,
  language = "javascript",
  height = 320,
  hookContext = false,
  readOnly = false,
}: CodeEditorProps) {
  const monaco = useMonaco();
  const mountedRef = useRef(false);

  useEffect(() => {
    if (monaco && hookContext) attachHookTypes(monaco);
  }, [monaco, hookContext]);

  const handleMount: OnMount = (_editor, monacoInstance) => {
    if (hookContext) attachHookTypes(monacoInstance);
    // Define vaultbase-dark theme matching our colors
    monacoInstance.editor.defineTheme("vaultbase-dark", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "6b7280", fontStyle: "italic" },
        { token: "string", foreground: "87b47e" },
        { token: "number", foreground: "86b9bb" },
        { token: "keyword", foreground: "b3703d" },
        { token: "type", foreground: "1fd2ff" },
        { token: "identifier", foreground: "e6e6e6" },
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
        "editorSuggestWidget.selectedBackground": "#1fd2ff22",
      },
    });
    mountedRef.current = true;
  };

  return (
    <div
      style={{
        border: "0.5px solid var(--border-default)",
        borderRadius: 7,
        overflow: "hidden",
        background: "#1f1f1f",
      }}
    >
      <Editor
        height={typeof height === "number" ? `${height}px` : height}
        defaultLanguage={language}
        language={language}
        value={value}
        onChange={(v) => onChange(v ?? "")}
        onMount={handleMount}
        theme="vaultbase-dark"
        options={{
          fontFamily: "JetBrains Mono, SF Mono, ui-monospace, monospace",
          fontSize: 12.5,
          lineHeight: 1.6,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          cursorBlinking: "smooth",
          renderLineHighlight: "line",
          tabSize: 2,
          wordWrap: "on",
          padding: { top: 10, bottom: 10 },
          quickSuggestions: { other: true, comments: false, strings: true },
          suggestOnTriggerCharacters: true,
          acceptSuggestionOnEnter: "on",
          parameterHints: { enabled: true },
          formatOnPaste: true,
          readOnly,
        }}
      />
    </div>
  );
}
