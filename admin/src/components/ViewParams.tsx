/**
 * Parameters on view collections (server: core/view-params.ts): the editor
 * under a view's query, and the value inputs for previews and the records page.
 */
import { VbBtn, VbCode, VbInput, VbSelect } from "./Vb.tsx";
import { queryParamNames, type ViewParamDraft, type ViewParamMode, type ViewParamType } from "../lib/view-params.ts";

export { appendViewParams, draftsFromJson, draftsToPayload, queryParamNames, type ViewParamDraft } from "../lib/view-params.ts";

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
