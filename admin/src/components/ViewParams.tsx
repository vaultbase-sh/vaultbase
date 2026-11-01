/**
 * Parameters on view collections (server: core/view-params.ts): the editor
 * under a view's query, and the value inputs for previews and the records page.
 */
import { VbBtn, VbCode, VbInput, VbSelect } from "./Vb.tsx";

export type ViewParamType = "text" | "number" | "bool" | "date";
export type ViewParamMode = "default" | "required" | "auth";

/** One row of the editor. `default` is what was typed; the server converts it. */
export interface ViewParamDraft {
  name: string;
  type: ViewParamType;
  mode: ViewParamMode;
  default: string;
}

const TYPES = [
  { label: "text", value: "text" },
  { label: "number", value: "number" },
  { label: "bool", value: "bool" },
  { label: "date", value: "date" },
];
const MODES = [
  { label: "Optional, with a default", value: "default" },
  { label: "Required", value: "required" },
  { label: "The signed-in user's id", value: "auth" },
];

/** Drafts from a collection's stored `view_params` (JSON text). */
export function draftsFromJson(raw: string | null | undefined): ViewParamDraft[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as Array<{ name: string; type: ViewParamType; default?: string | number | null; required?: boolean; from?: string }>;
    return list.map((p) => ({
      name: p.name,
      type: p.type,
      mode: p.from ? "auth" : p.required ? "required" : "default",
      // A stored date default is Unix seconds; shown as a date.
      default: p.default === undefined || p.default === null ? ""
        : p.type === "date" && typeof p.default === "number" ? new Date(p.default * 1000).toISOString().slice(0, 10)
        : p.type === "bool" ? (p.default ? "true" : "false")
        : String(p.default),
    }));
  } catch {
    return [];
  }
}

/** What the API takes as `view_params`. */
export function draftsToPayload(drafts: ViewParamDraft[]): Array<Record<string, unknown>> {
  return drafts.map((d) => {
    if (d.mode === "auth") return { name: d.name, type: "text", from: "auth.id" };
    if (d.mode === "required") return { name: d.name, type: d.type, required: true };
    return { name: d.name, type: d.type, ...(d.default.trim() !== "" ? { default: d.default.trim() } : {}) };
  });
}

/**
 * The `:name`s in a query, first occurrence order, skipping strings, quoted
 * names, comments, `::` casts and array slices. The server checks the same.
 */
export function queryParamNames(query: string): string[] {
  const out: string[] = [];
  let i = 0;
  let brackets = 0;
  while (i < query.length) {
    const c = query[i]!;
    const next = query[i + 1];
    if (c === "-" && next === "-") { const e = query.indexOf("\n", i); i = e < 0 ? query.length : e + 1; continue; }
    if (c === "/" && next === "*") { const e = query.indexOf("*/", i + 2); i = e < 0 ? query.length : e + 2; continue; }
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      for (;;) {
        const k = query.indexOf(c, j);
        if (k < 0) { j = query.length; break; }
        if (query[k + 1] === c) { j = k + 2; continue; }
        j = k + 1; break;
      }
      i = j; continue;
    }
    if (c === "[") brackets++;
    if (c === "]") brackets = Math.max(0, brackets - 1);
    if (c === ":" && next === ":") { i += 2; continue; }
    if (c === ":" && next && /[A-Za-z_]/.test(next) && query[i - 1] !== ":" && brackets === 0) {
      let j = i + 2;
      while (j < query.length && /[A-Za-z0-9_]/.test(query[j]!)) j++;
      const name = query.slice(i + 1, j);
      if (!out.includes(name)) out.push(name);
      i = j; continue;
    }
    i++;
  }
  return out;
}

const cell: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };

/** The parameters table under a view's query. */
export function ViewParamsEditor({ query, drafts, onChange }: {
  query: string;
  drafts: ViewParamDraft[];
  onChange: (drafts: ViewParamDraft[]) => void;
}) {
  const used = queryParamNames(query);
  const declared = new Set(drafts.map((d) => d.name));
  const undeclared = used.filter((n) => !declared.has(n));
  const set = (i: number, patch: Partial<ViewParamDraft>) => onChange(drafts.map((d, x) => (x === i ? { ...d, ...patch } : d)));
  const add = (name: string) => onChange([...drafts, { name, type: "text", mode: "default", default: "" }]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {drafts.length === 0 && undeclared.length === 0 && (
        <div style={{ fontSize: 11.5, color: "var(--vb-fg-3)", lineHeight: 1.55 }}>
          Write <VbCode>:name</VbCode> in the query where a value goes (<VbCode>WHERE created_at &gt;= :since</VbCode>);
          clients pass it as <VbCode>?params[since]=…</VbCode>.
        </div>
      )}
      {drafts.map((d, i) => (
        <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(110px, 1fr) 110px minmax(170px, 1.3fr) minmax(130px, 1fr) 28px", gap: 8, alignItems: "center" }}>
          <div style={cell}>
            <span style={{ fontFamily: "var(--font-mono)", color: "var(--vb-fg-3)" }}>:</span>
            <VbInput mono value={d.name} placeholder="name" aria-label="Parameter name"
              onChange={(e) => set(i, { name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") })} />
          </div>
          <VbSelect value={d.mode === "auth" ? "text" : d.type} options={TYPES} disabled={d.mode === "auth"}
            onChange={(v) => set(i, { type: v as ViewParamType })} style={{ height: 32, fontSize: 12 }} aria-label="Type" />
          <VbSelect value={d.mode} options={MODES} onChange={(v) => set(i, { mode: v as ViewParamMode, ...(v === "auth" ? { type: "text" as const } : {}) })}
            style={{ height: 32, fontSize: 12 }} aria-label="Value" />
          {d.mode === "default" ? (
            <VbInput mono value={d.default} aria-label="Default"
              placeholder={d.type === "date" ? "2026-01-01" : d.type === "bool" ? "true / false" : "default (empty: NULL)"}
              onChange={(e) => set(i, { default: e.target.value })} />
          ) : (
            <span style={{ fontSize: 11.5, color: "var(--vb-fg-3)" }}>
              {d.mode === "auth" ? "Clients can't set it; empty for guests" : "Reads without it get 400"}
            </span>
          )}
          <VbBtn kind="ghost" size="sm" icon="trash" title={`Remove :${d.name}`} onClick={() => onChange(drafts.filter((_, x) => x !== i))} />
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {undeclared.map((n) => (
          <VbBtn key={n} kind="soft" size="sm" icon="plus" onClick={() => add(n)}>Declare :{n}</VbBtn>
        ))}
        <VbBtn kind="ghost" size="sm" icon="plus" onClick={() => add("")}>Add parameter</VbBtn>
      </div>
    </div>
  );
}

/** Inputs for the parameters a client sets (not the one from the signed-in user). */
export function ViewParamInputs({ drafts, values, onChange }: {
  drafts: ViewParamDraft[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}) {
  const settable = drafts.filter((d) => d.mode !== "auth" && d.name);
  if (settable.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
      {settable.map((d) => (
        <label key={d.name} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <span style={{ fontFamily: "var(--font-mono)", color: "var(--vb-fg-2)" }}>:{d.name}</span>
          <VbInput mono value={values[d.name] ?? ""} style={{ width: 150 }}
            type={d.type === "date" ? "date" : "text"}
            placeholder={d.mode === "required" ? "required" : d.default || "default"}
            onChange={(e) => onChange({ ...values, [d.name]: e.target.value })} />
        </label>
      ))}
    </div>
  );
}

/** `params[name]=value` for the values filled in. */
export function appendViewParams(search: URLSearchParams, values: Record<string, string>): void {
  for (const [k, v] of Object.entries(values)) if (v.trim() !== "") search.set(`params[${k}]`, v.trim());
}
