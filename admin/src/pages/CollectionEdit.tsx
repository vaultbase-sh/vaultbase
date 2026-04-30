import { useEffect, useMemo, useRef, useState } from "react";
import { Dropdown } from "primereact/dropdown";
import { Chips } from "primereact/chips";
import {
  api, AUTH_RESERVED_FIELD_NAMES, type ApiResponse, type Collection, type FieldDef, collColor, parseFields,
} from "../api.ts";
import { CodeEditor, type SqlSchema } from "../components/CodeEditor.tsx";
import { useNavigate, useParams } from "react-router-dom";
import { Topbar } from "../components/Shell.tsx";
import type { Crumb } from "../components/Shell.tsx";
import { FieldTypeChip, Toggle } from "../components/UI.tsx";
import { RuleEditor } from "../components/RuleEditor.tsx";
import Icon from "../components/Icon.tsx";
import { confirm } from "../components/Confirm.tsx";
import { toast } from "../stores/toast.ts";

const FIELD_TYPES: FieldDef["type"][] = [
  "text", "number", "bool", "email", "url", "date",
  "password", "editor", "geoPoint",
  "file", "relation", "select", "json", "autodate",
];

const FIELD_TYPE_DESC: Record<FieldDef["type"], string> = {
  text:     "Plain text. Min/max length, regex, unique.",
  number:   "Numeric value. Min/max bounds.",
  bool:     "True / false toggle.",
  email:    "Email address (validated format).",
  url:      "URL (validated format).",
  date:     "Unix timestamp.",
  file:     "File upload(s). Size + MIME limits, optional multi.",
  relation: "Reference to another collection's record.",
  select:   "Pick from a fixed list of values (single or multi).",
  json:     "Arbitrary JSON value.",
  autodate: "Auto-set on create / update.",
  password: "Bcrypt-hashed. Never returned in API responses.",
  editor:   "Rich text / HTML body.",
  geoPoint: "Latitude / longitude coordinates.",
};

interface Rules {
  list: string; view: string; create: string; update: string; delete: string;
}

type RuleOpId = keyof Rules;

interface RulePreset {
  id: "public" | "auth" | "admin" | "custom";
  label: string;
  desc: string;
  icon: string;
  color: string;
  /** Sentinel value that selects this preset. `null` = field-derived (custom). */
  value: string | null;
}

const RULE_PRESETS: RulePreset[] = [
  { id: "public", label: "Public",     desc: "Anyone, no auth",        icon: "globe",  color: "#22c55e", value: "" },
  { id: "auth",   label: "Auth only",  desc: "Any signed-in user",     icon: "user",   color: "#1f8af2", value: '@request.auth.id != ""' },
  { id: "admin",  label: "Admin only", desc: "Restrict to superusers", icon: "lock",   color: "#f59e0b", value: '@request.auth.type = "admin"' },
  { id: "custom", label: "Custom",     desc: "Write your own",         icon: "code",   color: "#a78bfa", value: null },
];

const RULE_OPS: Array<{ id: RuleOpId; label: string; verb: string }> = [
  { id: "list",   label: "List",   verb: "list records" },
  { id: "view",   label: "View",   verb: "view a record" },
  { id: "create", label: "Create", verb: "create records" },
  { id: "update", label: "Update", verb: "update records" },
  { id: "delete", label: "Delete", verb: "delete records" },
];

function inferPresetId(value: string): RulePreset["id"] {
  for (const p of RULE_PRESETS) {
    if (p.value !== null && p.value === value) return p.id;
  }
  return "custom";
}

function presetById(id: RulePreset["id"]): RulePreset {
  return RULE_PRESETS.find((p) => p.id === id) ?? RULE_PRESETS[0]!;
}

type Tab = "fields" | "rules" | "indexes";

export default function CollectionEdit() {
  const params = useParams();
  const navigate = useNavigate();
  const collId = params["id"] ?? "";
  const [collection, setCollection] = useState<Collection | null>(null);
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [rules, setRules] = useState<Rules>({ list: "", view: "", create: "", update: "", delete: "" });
  const [saving, setSaving] = useState(false);
  const [allCollections, setAllCollections] = useState<Collection[]>([]);
  const [viewQuery, setViewQuery] = useState("");
  const [viewError, setViewError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [tab, setTab] = useState<Tab>("fields");
  const [expandedRule, setExpandedRule] = useState<RuleOpId | null>(null);
  const isView = collection?.type === "view";

  const sqlSchema: SqlSchema = useMemo(() => ({
    tables: allCollections
      .filter((c) => c.id !== collId)
      .map((c) => {
        const cols = ["id", "created_at", "updated_at"];
        for (const f of parseFields(c.fields)) {
          if (f.implicit && c.type === "auth") continue;
          if (f.system) continue;
          cols.push(f.name);
        }
        return { name: `vb_${c.name}`, collectionName: c.name, columns: cols };
      }),
  }), [allCollections, collId]);

  const [previewRows, setPreviewRows] = useState<{ columns: string[]; rows: Array<Record<string, unknown>> } | null>(null);
  const [previewing, setPreviewing] = useState(false);

  async function validateView() {
    if (!viewQuery.trim()) { setViewError("Empty query"); return; }
    setValidating(true);
    const res = await api.post<ApiResponse<{ columns: string[]; fields: FieldDef[] }>>(
      "/api/admin/collections/preview-view",
      { view_query: viewQuery.trim() }
    );
    setValidating(false);
    if (res.error) {
      setViewError(res.error);
      toast(res.error, "info");
      return;
    }
    setViewError(null);
    if (res.data?.fields) {
      const oldByName = new Map(fields.map((f) => [f.name, f]));
      const merged = res.data.fields.map((f) => oldByName.get(f.name) ?? f);
      setFields(merged);
    }
    toast("Query validated", "check");
  }

  async function previewViewRowsHandler() {
    if (!viewQuery.trim()) { setViewError("Empty query"); return; }
    setPreviewing(true);
    const res = await api.post<ApiResponse<{ columns: string[]; rows: Array<Record<string, unknown>> }>>(
      "/api/admin/collections/preview-view-rows",
      { view_query: viewQuery.trim(), limit: 5 }
    );
    setPreviewing(false);
    if (res.error) {
      setViewError(res.error);
      setPreviewRows(null);
      toast(res.error, "info");
      return;
    }
    setViewError(null);
    setPreviewRows(res.data ?? null);
  }

  useEffect(() => {
    api.get<ApiResponse<Collection[]>>("/api/collections").then((res) => {
      if (res.data) setAllCollections(res.data);
    });
  }, []);

  useEffect(() => {
    api.get<ApiResponse<Collection>>(`/api/collections/${collId}`).then((res) => {
      if (!res.data) return;
      setCollection(res.data);
      setFields(parseFields(res.data.fields));
      setViewQuery(res.data.view_query ?? "");
      setRules({
        list: res.data.list_rule ?? "",
        view: res.data.view_rule ?? "",
        create: res.data.create_rule ?? "",
        update: res.data.update_rule ?? "",
        delete: res.data.delete_rule ?? "",
      });
    });
  }, [collId]);

  const sel = selectedIdx !== null ? fields[selectedIdx] ?? null : null;

  function updateSel(patch: Partial<FieldDef>) {
    if (selectedIdx === null) return;
    setFields((fs) => fs.map((f, i) => (i === selectedIdx ? { ...f, ...patch } : f)));
  }

  function updateSelOptions(patch: Record<string, unknown>) {
    if (selectedIdx === null) return;
    setFields((fs) =>
      fs.map((f, i) =>
        i === selectedIdx ? { ...f, options: { ...(f.options ?? {}), ...patch } } : f
      )
    );
  }

  function numOrUndef(v: string): number | undefined {
    if (v === "") return undefined;
    const n = Number(v);
    return isNaN(n) ? undefined : n;
  }

  function addField(type: FieldDef["type"]) {
    const newField: FieldDef = { name: "", type, required: false };
    setFields((fs) => [...fs, newField]);
    setSelectedIdx(fields.length);
  }

  function removeField(i: number) {
    setFields((fs) => fs.filter((_, xi) => xi !== i));
    if (selectedIdx === i) setSelectedIdx(null);
    else if (selectedIdx !== null && selectedIdx > i) setSelectedIdx(selectedIdx - 1);
  }

  async function handleSave() {
    if (!collection) return;

    if (isView) {
      if (!viewQuery.trim()) { toast("View collections need a SELECT query"); return; }
      setSaving(true);
      const queryChanged = viewQuery.trim() !== (collection.view_query ?? "");
      const payload: Record<string, unknown> = {
        view_query: viewQuery.trim(),
        list_rule: rules.list || null,
        view_rule: rules.view || null,
        create_rule: rules.create || null,
        update_rule: rules.update || null,
        delete_rule: rules.delete || null,
      };
      if (!queryChanged) payload["fields"] = fields.filter((f) => !f.system);
      const res = await api.patch<ApiResponse<Collection>>(`/api/collections/${collId}`, payload);
      setSaving(false);
      if (res.error) { toast(res.error, "info"); return; }
      toast("Changes saved");
      navigate(`/_/collections/${collId}/records`);
      return;
    }

    const userFields = fields.filter((f) => !f.system);
    const unnamed = userFields.filter((f) => !f.name);
    if (unnamed.length > 0) { toast("All fields must have a name."); return; }
    const badSelect = userFields.find(
      (f) => f.type === "select" && (!Array.isArray(f.options?.values) || (f.options?.values as string[]).length === 0)
    );
    if (badSelect) { toast(`Select field '${badSelect.name}' must have at least one allowed value`); return; }
    const badRelation = userFields.find((f) => f.type === "relation" && !f.collection);
    if (badRelation) { toast(`Relation field '${badRelation.name}' must have a target collection`); return; }
    if (collection.type === "auth") {
      const reserved = new Set<string>(AUTH_RESERVED_FIELD_NAMES);
      const clash = userFields.find((f) => !f.implicit && reserved.has(f.name));
      if (clash) {
        toast(`'${clash.name}' is reserved on auth collections — managed by the implicit auth schema`);
        return;
      }
    }
    setSaving(true);
    await api.patch<ApiResponse<Collection>>(`/api/collections/${collId}`, {
      fields: userFields,
      list_rule: rules.list || null,
      view_rule: rules.view || null,
      create_rule: rules.create || null,
      update_rule: rules.update || null,
      delete_rule: rules.delete || null,
    });
    setSaving(false);
    toast("Changes saved");
    navigate(`/_/collections/${collId}/records`);
  }

  async function handleDelete() {
    if (!collection) return;
    const ok = await confirm({
      title: "Delete collection",
      message: `Delete collection "${collection.name}" and ALL its records?\n\nThis drops the underlying table and cannot be undone.`,
      danger: true,
    });
    if (!ok) return;
    await api.delete(`/api/collections/${collId}`);
    toast(`Collection deleted`, "trash");
    navigate("/_/collections");
  }

  if (!collection) return <div className="empty">Loading…</div>;

  const color = collColor(0);
  const visibleOps: RuleOpId[] = isView ? ["list", "view"] : ["list", "view", "create", "update", "delete"];
  const showIndexesTab = !isView;

  const crumbs: Crumb[] = [
    { label: "Collections", to: "/_/collections" },
    {
      label: (
        <span className="row" style={{ gap: 8 }}>
          <span className={`coll-icon ${color}`} style={{ width: 18, height: 18, fontSize: 10 }}>
            {collection.name[0]!.toUpperCase()}
          </span>
          <span className="mono" style={{ fontSize: 12.5 }}>{collection.name}</span>
        </span>
      ),
      to: `/_/collections/${collId}/records`,
    },
    { label: <span className="mono" style={{ fontSize: 12.5 }}>schema</span> },
  ];

  return (
    <>
      <Topbar
        crumbs={crumbs}
        onBack={() => navigate(`/_/collections/${collId}/records`)}
        actions={
          <>
            <button className="btn btn-ghost" onClick={() => navigate(`/_/collections/${collId}/records`)}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              <Icon name="check" size={12} />
              {saving ? "Saving…" : "Save changes"}
            </button>
            <span style={{ width: 12, borderLeft: "1px solid var(--border-subtle)", height: 18, marginLeft: 4 }} />
            <button className="btn btn-danger" onClick={handleDelete}>
              <Icon name="trash" size={12} /> Delete collection
            </button>
          </>
        }
      />
      <div className="tabs" style={{ paddingLeft: 20 }}>
        <div className={`tab ${tab === "fields" ? "active" : ""}`} onClick={() => setTab("fields")}>
          <Icon name="database" size={12} /> Fields
          <span className="ct">{fields.length}</span>
        </div>
        <div className={`tab ${tab === "rules" ? "active" : ""}`} onClick={() => setTab("rules")}>
          <Icon name="shield" size={12} /> API Rules
        </div>
        {showIndexesTab && (
          <div className={`tab ${tab === "indexes" ? "active" : ""}`} onClick={() => setTab("indexes")}>
            <Icon name="zap" size={12} /> Indexes
          </div>
        )}
      </div>

      <div className="app-body">
        <div className="schema-tab-body">
          {tab === "fields" && (
            <FieldsTab
              isView={isView}
              collection={collection}
              fields={fields}
              setFields={setFields}
              selectedIdx={selectedIdx}
              setSelectedIdx={setSelectedIdx}
              sel={sel}
              updateSel={updateSel}
              updateSelOptions={updateSelOptions}
              numOrUndef={numOrUndef}
              addField={addField}
              removeField={removeField}
              allCollections={allCollections}
              collId={collId}
              viewQuery={viewQuery}
              setViewQuery={setViewQuery}
              viewError={viewError}
              setViewError={setViewError}
              validating={validating}
              validateView={validateView}
              previewRows={previewRows}
              setPreviewRows={setPreviewRows}
              previewing={previewing}
              previewViewRowsHandler={previewViewRowsHandler}
              sqlSchema={sqlSchema}
            />
          )}
          {tab === "rules" && (
            <div className="schema-tab-narrow">
              <div className="rule-callout">
                <Icon name="info" size={14} />
                <div>
                  Rules use a <code>filter expression</code>. Pick a preset or write your own —
                  empty maps to <code>null</code> on save (public access).
                </div>
              </div>
              {visibleOps.map((opId) => {
                const op = RULE_OPS.find((o) => o.id === opId)!;
                const value = rules[opId];
                const presetId = inferPresetId(value);
                const preset = presetById(presetId);
                const expanded = expandedRule === opId;
                return (
                  <RuleCard
                    key={opId}
                    op={op}
                    value={value}
                    preset={preset}
                    expanded={expanded}
                    onToggle={() => setExpandedRule(expanded ? null : opId)}
                    onPreset={(p) => {
                      if (p.value !== null) {
                        setRules((prev) => ({ ...prev, [opId]: p.value as string }));
                      } else if (presetId !== "custom") {
                        // Switching to custom — keep existing value as starting point
                        setRules((prev) => ({ ...prev, [opId]: prev[opId] }));
                      }
                    }}
                    onChange={(v) => setRules((prev) => ({ ...prev, [opId]: v }))}
                    schemaFields={fields}
                  />
                );
              })}
            </div>
          )}
          {tab === "indexes" && showIndexesTab && (
            <div className="schema-tab-narrow">
              <div className="rule-callout green">
                <Icon name="zap" size={14} />
                <div>
                  Indexes speed up filter &amp; sort queries. Add one for any field you query
                  frequently.
                </div>
              </div>
              <IndexesSection collectionName={collection.name} fields={fields} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ── Fields tab ──────────────────────────────────────────────────────────────
interface FieldsTabProps {
  isView: boolean;
  collection: Collection;
  fields: FieldDef[];
  setFields: React.Dispatch<React.SetStateAction<FieldDef[]>>;
  selectedIdx: number | null;
  setSelectedIdx: React.Dispatch<React.SetStateAction<number | null>>;
  sel: FieldDef | null;
  updateSel: (patch: Partial<FieldDef>) => void;
  updateSelOptions: (patch: Record<string, unknown>) => void;
  numOrUndef: (v: string) => number | undefined;
  addField: (type: FieldDef["type"]) => void;
  removeField: (i: number) => void;
  allCollections: Collection[];
  collId: string;
  viewQuery: string;
  setViewQuery: (v: string) => void;
  viewError: string | null;
  setViewError: (v: string | null) => void;
  validating: boolean;
  validateView: () => Promise<void>;
  previewRows: { columns: string[]; rows: Array<Record<string, unknown>> } | null;
  setPreviewRows: (v: { columns: string[]; rows: Array<Record<string, unknown>> } | null) => void;
  previewing: boolean;
  previewViewRowsHandler: () => Promise<void>;
  sqlSchema: SqlSchema;
}

function FieldsTab(props: FieldsTabProps) {
  const {
    isView, collection, fields, setFields, selectedIdx, setSelectedIdx, sel,
    updateSel, updateSelOptions, numOrUndef, addField, removeField,
    allCollections, collId, viewQuery, setViewQuery, viewError, setViewError,
    validating, validateView, previewRows, setPreviewRows, previewing,
    previewViewRowsHandler, sqlSchema,
  } = props;
  const showPanel = sel !== null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {isView && (
        <div className="editor-card">
          <div className="editor-card-head">
            <h3>SELECT query</h3>
            <span className="meta">backed by SQLite VIEW <span className="mono">vb_{collection.name}</span></span>
          </div>
          <div style={{ padding: 14 }}>
            <CodeEditor
              language="sql"
              value={viewQuery}
              onChange={(v) => { setViewQuery(v); setViewError(null); }}
              sqlSchema={sqlSchema}
              markers={viewError ? [{ message: viewError, line: 1, severity: "error" }] : []}
              height={220}
            />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, gap: 10 }}>
              <div className="muted" style={{ fontSize: 11 }}>
                Single SELECT only — no semicolons, no DML/DDL. Autocompletes <span className="mono">vb_*</span> tables and columns.
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn btn-ghost" onClick={previewViewRowsHandler} disabled={previewing}>
                  <Icon name="eye" size={11} />
                  {previewing ? "Loading…" : "Preview 5 rows"}
                </button>
                <button className="btn btn-ghost" onClick={validateView} disabled={validating}>
                  <Icon name="play" size={11} />
                  {validating ? "Validating…" : "Validate & refresh columns"}
                </button>
              </div>
            </div>
            {previewRows && (
              <div style={{ marginTop: 12, border: "0.5px solid var(--border-default)", borderRadius: 7, overflow: "hidden" }}>
                <div style={{ padding: "8px 10px", background: "rgba(255,255,255,0.03)", fontSize: 11, color: "var(--text-secondary)", display: "flex", justifyContent: "space-between" }}>
                  <span>Preview ({previewRows.rows.length} {previewRows.rows.length === 1 ? "row" : "rows"})</span>
                  <button className="btn-icon" onClick={() => setPreviewRows(null)} title="Close">
                    <Icon name="x" size={11} />
                  </button>
                </div>
                {previewRows.rows.length === 0 ? (
                  <div className="empty" style={{ padding: 16, fontSize: 12 }}>Query returned no rows.</div>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table className="table" style={{ fontSize: 11 }}>
                      <thead>
                        <tr>
                          {previewRows.columns.map((c) => (
                            <th key={c}>{c}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {previewRows.rows.map((row, i) => (
                          <tr key={i}>
                            {previewRows.columns.map((c) => {
                              const v = row[c];
                              const display = v === null || v === undefined ? <span className="muted">null</span>
                                : typeof v === "object" ? <code className="mono">{JSON.stringify(v)}</code>
                                : String(v);
                              return <td key={c} className="mono-cell" style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{display}</td>;
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {!isView && (
        <div className={`schema-fields-grid ${showPanel ? "with-panel" : "no-panel"}`}>
          <div className="editor-card" style={{ overflow: "hidden" }}>
            <div className="fields-table-head">
              <span />
              <span>Name</span>
              <span>Type</span>
              <span>Constraints</span>
              <span style={{ textAlign: "right" }}>Flags</span>
              <span />
            </div>
            <div>
              {fields.map((f, i) => (
                <FieldRow
                  key={i}
                  field={f}
                  index={i}
                  selected={selectedIdx === i}
                  onSelect={() => setSelectedIdx(selectedIdx === i ? null : i)}
                  onRename={(name) =>
                    setFields((fs) => fs.map((x, xi) => xi === i ? { ...x, name } : x))
                  }
                  onRemove={() => removeField(i)}
                />
              ))}
            </div>
            <div className="fields-add-bar">
              <FieldTypePicker onPick={addField} />
            </div>
          </div>

          {showPanel && (
            <div className="editor-card field-options-panel">
              <div className="field-options-panel-head">
                <span className="title">Field options</span>
                {sel && <FieldTypeChip type={sel.type} />}
                <button
                  className="btn-icon"
                  onClick={() => setSelectedIdx(null)}
                  title="Close panel"
                  style={{ marginLeft: "auto" }}
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
              {sel ? (
                <div className="field-options-panel-body">
                  <FieldOptionsBody
                    sel={sel}
                    updateSel={updateSel}
                    updateSelOptions={updateSelOptions}
                    numOrUndef={numOrUndef}
                    allCollections={allCollections}
                    collId={collId}
                  />
                </div>
              ) : (
                <div className="field-options-empty">
                  <div className="icon"><Icon name="info" size={20} /></div>
                  <div className="text">Select a field to edit its options</div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Field row ───────────────────────────────────────────────────────────────
function FieldRow({
  field, index, selected, onSelect, onRename, onRemove,
}: {
  field: FieldDef;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const nameLocked = field.system || field.implicit;
  const summary = describeField(field);
  return (
    <div
      className={`fields-table-row${selected ? " selected" : ""}`}
      onClick={onSelect}
      data-idx={index}
    >
      <span className="grip"><Icon name="grip" size={12} /></span>
      {nameLocked ? (
        <span className="name">{field.name}</span>
      ) : (
        <input
          className="input mono"
          style={{ height: 26, fontSize: 12, padding: "0 8px", maxWidth: "100%" }}
          value={field.name}
          onChange={(e) => onRename(e.target.value.replace(/[^a-z0-9_]/g, ""))}
          onClick={(e) => e.stopPropagation()}
          placeholder="field_name"
        />
      )}
      <FieldTypeChip type={field.type} />
      <span className="summary" title={summary}>{summary}</span>
      <span className="fields-flags">
        <span className={`flag req${field.required ? " on" : ""}`} title="required">
          <Icon name="check" size={10} /> req
        </span>
        <span className={`flag uniq${field.options?.["unique"] ? " on" : ""}`} title="unique">
          <Icon name="star" size={10} /> uniq
        </span>
      </span>
      {!nameLocked ? (
        <button
          className="btn-icon"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          title="Remove field"
        >
          <Icon name="x" size={12} />
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

function describeField(f: FieldDef): string {
  if (f.system) return "system";
  const opts = f.options ?? {};
  const bits: string[] = [];
  if (f.implicit) bits.push("implicit");
  if (f.type === "text" || f.type === "email" || f.type === "url") {
    if (opts["min"] !== undefined || opts["max"] !== undefined) {
      bits.push(`${opts["min"] ?? 0}–${opts["max"] ?? "∞"}`);
    }
    if (opts["pattern"]) bits.push(`/${opts["pattern"]}/`);
  }
  if (f.type === "number") {
    if (opts["min"] !== undefined || opts["max"] !== undefined) {
      bits.push(`${opts["min"] ?? "−∞"}–${opts["max"] ?? "∞"}`);
    }
  }
  if (f.type === "relation") {
    bits.push(`→ ${f.collection ?? "?"}`);
  }
  if (f.type === "select") {
    const vals = (opts["values"] as string[] | undefined) ?? [];
    bits.push(`${vals.length} ${opts["multiple"] ? "multi" : "single"}`);
  }
  if (f.type === "file") {
    if (opts["maxSize"]) bits.push(`max ${humanBytes(opts["maxSize"] as number)}`);
    if (Array.isArray(opts["mimeTypes"]) && (opts["mimeTypes"] as string[]).length) {
      bits.push((opts["mimeTypes"] as string[]).join(", "));
    }
  }
  if (opts["unique"]) bits.push("unique");
  if (opts["encrypted"]) bits.push("encrypted");
  return bits.join(" · ") || "—";
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${Math.round(n / 1024 / 1024)}MB`;
}

// ── Field options body (right panel content) ────────────────────────────────
function FieldOptionsBody({
  sel, updateSel, updateSelOptions, numOrUndef, allCollections, collId,
}: {
  sel: FieldDef;
  updateSel: (patch: Partial<FieldDef>) => void;
  updateSelOptions: (patch: Record<string, unknown>) => void;
  numOrUndef: (v: string) => number | undefined;
  allCollections: Collection[];
  collId: string;
}) {
  const locked = sel.system || sel.implicit;
  return (
    <>
      <div>
        <label className="label">Name</label>
        <input
          className="input mono"
          value={sel.name}
          onChange={(e) => updateSel({ name: e.target.value.replace(/[^a-z0-9_]/g, "") })}
          disabled={locked}
        />
        {locked && (
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            {sel.implicit ? "Implicit auth field — name and type are locked, options are editable below" : "System field — name is locked"}
          </div>
        )}
      </div>

      <div>
        <label className="label">Type</label>
        <div className="row" style={{ flexWrap: "wrap", gap: 4 }}>
          {FIELD_TYPES.map((t) => (
            <span
              key={t}
              className="add-chip"
              style={
                t === sel.type
                  ? { borderColor: "var(--accent)", color: "var(--accent-light)", background: "var(--accent-glow)", borderStyle: "solid" }
                  : undefined
              }
              onClick={() => !locked && updateSel({ type: t })}
            >
              {t}
            </span>
          ))}
        </div>
      </div>

      <div
        className="row"
        style={{ justifyContent: "space-between", padding: "10px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 7 }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 500 }}>Required</div>
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>Reject records without this field</div>
        </div>
        <Toggle on={sel.required ?? false} onChange={(v) => updateSel({ required: v })} />
      </div>

      {(sel.type === "text" || sel.type === "email" || sel.type === "url") && (
        <>
          <div>
            <label className="label">Min / Max length</label>
            <div className="row">
              <input
                className="input mono"
                type="number"
                min={0}
                value={(sel.options?.["min"] as number | undefined) ?? ""}
                onChange={(e) => updateSelOptions({ min: numOrUndef(e.target.value) })}
                placeholder="0"
              />
              <input
                className="input mono"
                type="number"
                min={0}
                value={(sel.options?.["max"] as number | undefined) ?? ""}
                onChange={(e) => updateSelOptions({ max: numOrUndef(e.target.value) })}
                placeholder="—"
              />
            </div>
          </div>
          {sel.type === "text" && (
            <div>
              <label className="label">Regex pattern</label>
              <input
                className="input mono"
                value={(sel.options?.["pattern"] as string | undefined) ?? ""}
                onChange={(e) => updateSelOptions({ pattern: e.target.value || undefined })}
                placeholder="^[a-z0-9-]+$"
              />
            </div>
          )}
          <div className="row" style={{ justifyContent: "space-between", padding: "10px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 7 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>Unique</div>
              <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>Disallow duplicate values</div>
            </div>
            <Toggle
              on={!!sel.options?.["unique"]}
              onChange={(v) => updateSelOptions({ unique: v })}
            />
          </div>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", padding: "10px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 7, gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>Encrypt at rest</div>
              <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                AES-GCM. Disables filtering &amp; uniqueness on this field. Requires <span className="mono">VAULTBASE_ENCRYPTION_KEY</span>.
              </div>
            </div>
            <Toggle
              on={!!sel.options?.["encrypted"]}
              onChange={(v) => updateSelOptions({ encrypted: v })}
            />
          </div>
        </>
      )}
      {sel.type === "json" && (
        <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", padding: "10px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 7, gap: 12 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Encrypt at rest</div>
            <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
              AES-GCM. Requires <span className="mono">VAULTBASE_ENCRYPTION_KEY</span>.
            </div>
          </div>
          <Toggle
            on={!!sel.options?.["encrypted"]}
            onChange={(v) => updateSelOptions({ encrypted: v })}
          />
        </div>
      )}
      {sel.type === "password" && (
        <div>
          <label className="label">Min / Max length</label>
          <div className="row">
            <input
              className="input mono"
              type="number"
              min={0}
              value={(sel.options?.["min"] as number | undefined) ?? ""}
              onChange={(e) => updateSelOptions({ min: numOrUndef(e.target.value) })}
              placeholder="min (e.g. 8)"
            />
            <input
              className="input mono"
              type="number"
              min={0}
              value={(sel.options?.["max"] as number | undefined) ?? ""}
              onChange={(e) => updateSelOptions({ max: numOrUndef(e.target.value) })}
              placeholder="max"
            />
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            Stored as a bcrypt hash. Never returned by the API. To clear a password, send an empty string.
          </div>
        </div>
      )}
      {sel.type === "editor" && (
        <div>
          <label className="label">Max length</label>
          <input
            className="input mono"
            type="number"
            min={0}
            value={(sel.options?.["max"] as number | undefined) ?? ""}
            onChange={(e) => updateSelOptions({ max: numOrUndef(e.target.value) })}
            placeholder="—"
          />
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            Stored as raw HTML. Sanitize on the client before rendering untrusted input.
          </div>
        </div>
      )}
      {sel.type === "geoPoint" && (
        <div className="muted" style={{ fontSize: 11, padding: "10px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 7 }}>
          Stored as <span className="mono">{`{ lat, lng }`}</span> JSON. Latitude in [-90, 90], longitude in [-180, 180].
        </div>
      )}
      {sel.type === "number" && (
        <>
          <div>
            <label className="label">Min / Max value</label>
            <div className="row">
              <input
                className="input mono"
                type="number"
                value={(sel.options?.["min"] as number | undefined) ?? ""}
                onChange={(e) => updateSelOptions({ min: numOrUndef(e.target.value) })}
                placeholder="—"
              />
              <input
                className="input mono"
                type="number"
                value={(sel.options?.["max"] as number | undefined) ?? ""}
                onChange={(e) => updateSelOptions({ max: numOrUndef(e.target.value) })}
                placeholder="—"
              />
            </div>
          </div>
          <div className="row" style={{ justifyContent: "space-between", padding: "10px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 7 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>Unique</div>
              <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>Disallow duplicate values</div>
            </div>
            <Toggle
              on={!!sel.options?.["unique"]}
              onChange={(v) => updateSelOptions({ unique: v })}
            />
          </div>
        </>
      )}
      {sel.type === "relation" && (
        <>
          <div>
            <label className="label">Target collection</label>
            {allCollections.filter((c) => c.id !== collId).length === 0 ? (
              <div className="muted" style={{ fontSize: 11 }}>
                No other collections to link to.
              </div>
            ) : (
              <Dropdown
                value={sel.collection ?? null}
                options={allCollections
                  .filter((c) => c.id !== collId)
                  .map((c) => c.name)}
                onChange={(e) => updateSel({ collection: e.value })}
                placeholder="Select a collection…"
                filter
                showClear
                style={{ width: "100%", height: 34 }}
                panelStyle={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
              />
            )}
          </div>
          <div>
            <label className="label">On target delete</label>
            <Dropdown
              value={(sel.options?.["cascade"] as string | undefined) ?? "setNull"}
              options={[
                { label: "Set to null (default)", value: "setNull" },
                { label: "Cascade delete",        value: "cascade" },
                { label: "Restrict (block)",      value: "restrict" },
              ]}
              onChange={(e) => updateSelOptions({ cascade: e.value })}
              style={{ width: "100%", height: 34 }}
              panelStyle={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
            />
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              What to do with this record when the referenced record is deleted.
            </div>
          </div>
        </>
      )}
      {sel.type === "select" && (
        <>
          <div>
            <label className="label">Allowed values</label>
            <Chips
              value={Array.isArray(sel.options?.["values"]) ? (sel.options?.["values"] as string[]) : []}
              onChange={(e) => updateSelOptions({ values: e.value ?? [] })}
              placeholder="Type a value and press Enter"
              separator=","
              style={{ width: "100%" }}
            />
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              At least one value is required for select fields.
            </div>
          </div>
          <div className="row" style={{ justifyContent: "space-between", padding: "10px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 7 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>Allow multiple values</div>
            </div>
            <Toggle
              on={!!sel.options?.["multiple"]}
              onChange={(v) => updateSelOptions({ multiple: v })}
            />
          </div>
        </>
      )}
      {sel.type === "file" && (
        <>
          <div>
            <label className="label">Max size (bytes)</label>
            <input
              className="input mono"
              type="number"
              min={0}
              value={(sel.options?.["maxSize"] as number | undefined) ?? ""}
              onChange={(e) => updateSelOptions({ maxSize: numOrUndef(e.target.value) })}
              placeholder="5242880 = 5MB"
            />
          </div>
          <div>
            <label className="label">Allowed mime types</label>
            <Chips
              value={Array.isArray(sel.options?.["mimeTypes"]) ? (sel.options?.["mimeTypes"] as string[]) : []}
              onChange={(e) => updateSelOptions({ mimeTypes: e.value ?? [] })}
              placeholder="image/* — press Enter"
              separator=","
              style={{ width: "100%" }}
            />
          </div>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", padding: "10px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 7, gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>Multiple files</div>
              <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                Stores an array of filenames instead of a single one.
              </div>
            </div>
            <Toggle
              on={!!sel.options?.["multiple"]}
              onChange={(v) => updateSelOptions({ multiple: v })}
            />
          </div>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-start", padding: "10px 12px", background: "rgba(255,255,255,0.03)", borderRadius: 7, gap: 12 }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>Protected</div>
              <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                Public GETs return 401. Issue a 1h access token via{" "}
                <span className="mono">POST /api/files/.../token</span>, then pass <span className="mono">?token=</span>.
              </div>
            </div>
            <Toggle
              on={!!sel.options?.["protected"]}
              onChange={(v) => updateSelOptions({ protected: v })}
            />
          </div>
        </>
      )}
    </>
  );
}

// ── Rule card (V1) ──────────────────────────────────────────────────────────
function RuleCard({
  op, value, preset, expanded, onToggle, onPreset, onChange, schemaFields,
}: {
  op: { id: RuleOpId; label: string; verb: string };
  value: string;
  preset: RulePreset;
  expanded: boolean;
  onToggle: () => void;
  onPreset: (p: RulePreset) => void;
  onChange: (v: string) => void;
  schemaFields: FieldDef[];
}) {
  const isEmpty = value === "";
  return (
    <div className="rule-card-v1">
      <div
        className={`rule-card-v1-head${expanded ? " open" : ""}`}
        onClick={onToggle}
      >
        <span className="chev"><Icon name="chevronRight" size={12} /></span>
        <span className="op">{op.label}</span>
        <span
          className="rule-preset-pill"
          style={{
            background: `${preset.color}1c`,
            color: preset.color,
            borderColor: `${preset.color}55`,
          }}
        >
          <Icon name={preset.icon} size={10} /> {preset.label}
        </span>
        <span className={`summary${isEmpty ? " empty" : ""}`}>
          {isEmpty ? "// public — no rule" : value}
        </span>
      </div>
      {expanded && (
        <div className="rule-card-v1-body">
          <div className="prompt">Who can {op.verb}?</div>
          <div className="rule-presets-row">
            {RULE_PRESETS.map((p) => (
              <button
                key={p.id}
                className={`rule-preset-chip${p.id === preset.id ? " active" : ""}`}
                onClick={() => onPreset(p)}
                type="button"
              >
                <Icon name={p.icon} size={11} /> {p.label}
              </button>
            ))}
          </div>
          <label className="label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <Icon name="code" size={11} /> Custom rule expression
          </label>
          <RuleEditor
            value={value}
            onChange={onChange}
            schemaFields={schemaFields}
            placeholder={op.id === "list" ? '@request.auth.id != ""' : ""}
          />
        </div>
      )}
    </div>
  );
}

// ── Indexes section ─────────────────────────────────────────────────────────
interface IndexInfo { name: string; field: string; unique: boolean }

function IndexesSection({
  collectionName,
  fields,
}: {
  collectionName: string;
  fields: FieldDef[];
}) {
  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newField, setNewField] = useState<string | null>(null);
  const [newUnique, setNewUnique] = useState(false);

  async function load() {
    setLoading(true);
    const res = await api.get<ApiResponse<IndexInfo[]>>(`/api/admin/collections/${collectionName}/indexes`);
    if (res.data) setIndexes(res.data);
    setLoading(false);
  }
  useEffect(() => { load(); }, [collectionName]);

  async function handleAdd() {
    if (!newField) return;
    const res = await api.post<ApiResponse<IndexInfo>>(
      `/api/admin/collections/${collectionName}/indexes`,
      { field: newField, unique: newUnique }
    );
    if (res.error) { toast(res.error, "info"); return; }
    toast("Index created");
    setAdding(false); setNewField(null); setNewUnique(false);
    load();
  }

  async function handleDelete(idx: IndexInfo) {
    const ok = await confirm({
      title: "Drop index",
      message: `Drop the SQL index "${idx.name}"?\n\nQueries that depend on it will get slower.`,
      danger: true,
      confirmLabel: "Drop",
    });
    if (!ok) return;
    const res = await api.delete<ApiResponse<null>>(
      `/api/admin/collections/${collectionName}/indexes/${idx.name}`
    );
    if (res.error) { toast(res.error, "info"); return; }
    toast("Index dropped", "trash");
    load();
  }

  const indexable = fields.filter(
    (f) => !f.system && !f.implicit && f.type !== "autodate" && f.type !== "json" && f.type !== "file"
  );

  return (
    <div className="indexes-table">
      <div className="indexes-table-head">
        <span>Name</span>
        <span>Field</span>
        <span>Type</span>
        <span>Unique</span>
        <span />
      </div>

      {loading ? (
        <div className="empty-narrow">Loading…</div>
      ) : indexes.length === 0 ? (
        <div className="empty-narrow">
          No indexes yet. Add one to speed up filter/sort queries on a field.
        </div>
      ) : (
        indexes.map((idx) => (
          <div key={idx.name} className="indexes-table-row">
            <span className="name">{idx.name}</span>
            <span>
              <span className="vb-type-badge mono" style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: 999, background: "rgba(255,255,255,0.04)", border: "0.5px solid var(--border-default)", fontSize: 11, color: "var(--text-secondary)" }}>{idx.field}</span>
            </span>
            <span className="meta-cell">btree</span>
            <span style={{ fontSize: 12, color: idx.unique ? "#c4b5fd" : "var(--text-muted)" }}>
              {idx.unique ? "yes" : "no"}
            </span>
            <button
              className="btn-icon danger"
              onClick={() => handleDelete(idx)}
              title="Drop index"
            >
              <Icon name="trash" size={12} />
            </button>
          </div>
        ))
      )}

      {adding ? (
        <div style={{ padding: 12, borderTop: "0.5px solid var(--border-default)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", background: "rgba(255,255,255,0.01)" }}>
          <Dropdown
            value={newField}
            options={indexable.map((f) => ({ label: f.name, value: f.name }))}
            onChange={(e) => setNewField(e.value)}
            placeholder="Field"
            style={{ height: 32, minWidth: 160 }}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)" }}>
            <Toggle on={newUnique} onChange={setNewUnique} />
            <span>Unique</span>
          </label>
          <button className="btn btn-primary" disabled={!newField} onClick={handleAdd}>
            <Icon name="check" size={12} /> Create
          </button>
          <button className="btn btn-ghost" onClick={() => { setAdding(false); setNewField(null); setNewUnique(false); }}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="fields-add-bar" style={{ borderTop: "0.5px solid var(--border-default)" }}>
          <button className="btn" style={{ width: "100%", justifyContent: "center", borderStyle: "dashed" }} onClick={() => setAdding(true)}>
            <Icon name="plus" size={12} /> Add index
          </button>
        </div>
      )}
    </div>
  );
}

function FieldTypePicker({ onPick }: { onPick: (type: FieldDef["type"]) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { setOpen(false); setQuery(""); }
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const q = query.trim().toLowerCase();
  const filtered = FIELD_TYPES.filter(
    (t) => t.includes(q) || FIELD_TYPE_DESC[t].toLowerCase().includes(q)
  );

  function pick(type: FieldDef["type"]) {
    onPick(type);
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      {!open ? (
        <button className="btn" style={{ width: "100%", justifyContent: "center", borderStyle: "dashed" }} onClick={() => setOpen(true)}>
          <Icon name="plus" size={12} /> Add field
        </button>
      ) : (
        <div className="ftp-panel">
          <div className="ftp-search">
            <Icon name="search" size={12} />
            <input
              ref={inputRef}
              className="ftp-search-input"
              placeholder="Search field types…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && filtered[0]) pick(filtered[0]);
              }}
            />
            <kbd className="kbd">esc</kbd>
          </div>
          <div className="ftp-list">
            {filtered.length === 0 && (
              <div className="ftp-empty">No matches for "{query}"</div>
            )}
            {filtered.map((t) => (
              <div className="ftp-item" key={t} onClick={() => pick(t)}>
                <span className="ftp-name">{t}</span>
                <span className="ftp-desc">{FIELD_TYPE_DESC[t]}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
