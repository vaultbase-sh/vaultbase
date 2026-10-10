import { lazy, Suspense } from "react";
import type { CodeEditorProps } from "./CodeEditor.tsx";

// Monaco is ~4 MB. Components reachable from the eagerly loaded pages (the
// new-collection modal on Collections) render this wrapper so Monaco is only
// fetched when an editor actually mounts, not on login / dashboard.
const Editor = lazy(() => import("./CodeEditor.tsx").then((m) => ({ default: m.CodeEditor })));

export type { CodeEditorProps, SqlSchema } from "./CodeEditor.tsx";

export function CodeEditor(props: CodeEditorProps) {
  const height = props.height ?? 320;
  return (
    <Suspense
      fallback={
        <div
          style={{
            height: typeof height === "number" ? `${height}px` : height,
            border: "1px solid var(--vb-border)",
            background: "var(--vb-bg-2)",
          }}
          aria-busy="true"
        />
      }
    >
      <Editor {...props} />
    </Suspense>
  );
}
