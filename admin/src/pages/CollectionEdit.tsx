import { useEffect, useMemo, useRef, useState } from "react";
import { Dropdown } from "primereact/dropdown";
import { Chips } from "primereact/chips";
import {
  api, AUTH_RESERVED_FIELD_NAMES, type ApiResponse, type Collection, type FieldDef, parseFields,
} from "../api.ts";
import { CodeEditor, type SqlSchema } from "../components/CodeEditor.tsx";
import { useNavigate, useParams } from "react-router-dom";
import {
  CollectionAvatar,
  FieldTypePill,
  VbBtn,
  VbField,
  VbInput,
  VbPill,
  VbSubHeader,
  VbTabs,
  type VbTab,
} from "../components/Vb.tsx";
import { Toggle } from "../components/UI.tsx";
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
      "/api/v1/admin/collections/preview-view",
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
      "/api/v1/admin/collections/preview-view-rows",
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
    api.get<ApiResponse<Collection[]>>("/api/v1/collections").then((res) => {
      if (res.data) setAllCollections(res.data);
    });
  }, []);

  useEffect(() => {
    api.get<ApiResponse<Collection>>(`/api/v1/collections/${collId}`).then((res) => {
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
      const res = await api.patch<ApiResponse<Collection>>(`/api/v1/collections/${collId}`, payload);
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
    await api.patch<ApiResponse<Collection>>(`/api/v1/collections/${collId}`, {
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
    await api.delete(`/api/v1/collections/${collId}`);
    toast(`Collection deleted`, "trash");
    navigate("/_/collections");
  }

  if (!collection) return <div className="empty">Loading…</div>;

  const visibleOps: RuleOpId[] = isView ? ["list", "view"] : ["list", "view", "create", "update", "delete"];
  const showIndexesTab = !isView;

  const subTabs: VbTab<"fields" | "rules" | "indexes">[] = [
    { id: "fields",  label: "Fields",    icon: "stack",    count: fields.length },
    { id: "rules",   label: "API rules", icon: "shield" },
    ...(showIndexesTab ? [{ id: "indexes" as const, label: "Indexes", icon: "zap" }] : []),
  ];

  return (
    <>
      <VbSubHeader
        onBack={() => navigate(`/_/collections/${collId}/records`)}
        crumbs={[
          <span key="c" style={{ color: "var(--vb-fg-3)" }}>Collections</span>,
          <span
            key="n"
            style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}
            onClick={() => navigate(`/_/collections/${collId}/records`)}
          >
            <CollectionAvatar letter={collection.name[0] ?? "?"} size={18} />
            <span style={{ color: "var(--vb-fg-2)", fontFamily: "var(--font-mono)", fontSize: 12.5 }}>
              {collection.name}
            </span>
          </span>,
          <span key="t" style={{ color: "var(--vb-fg)", fontFamily: "var(--font-mono)", fontSize: 12.5 }}>
            {tab === "fields" ? "schema" : tab === "rules" ? "rules" : "indexes"}
          </span>,
        ]}
        right={
          <>
            <VbBtn
              kind="ghost"
              size="sm"
              onClick={() => navigate(`/_/collections/${collId}/records`)}
            >
              Cancel
            </VbBtn>
            <VbBtn
              kind="primary"
              size="sm"
              icon="check"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save changes"}
            </VbBtn>
            <span style={{ width: 1, height: 20, background: "var(--vb-border)", margin: "0 4px" }} />
            <VbBtn kind="danger" size="sm" icon="trash" onClick={handleDelete}>
              Delete collection
            </VbBtn>
          </>
        }
      />

      <VbTabs tabs={subTabs} active={tab} onChange={(id) => setTab(id)} />

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
              <div style={{
                display: "flex", alignItems: "flex-start", justifyContent: "space-between",
                marginBottom: 14, gap: 16,
              }}>
                <div style={{ maxWidth: 540 }}>
                  <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--vb-fg)", marginBottom: 4 }}>
                    Access rules
                  </h2>
                  <p style={{ margin: 0, fontSize: 12, color: "var(--vb-fg-2)", lineHeight: 1.55 }}>
                    Filter expressions evaluated server-side per request. Pick a preset or write a custom rule. An empty rule means{" "}
                    <code style={{
                      fontFamily: "var(--font-mono)", fontSize: "0.86em",
                      padding: "1px 5px", borderRadius: 4,
                      background: "var(--vb-code-bg)", color: "var(--vb-code-fg)",
                    }}>null</code>{" "}
                    on save — i.e. <strong style={{ color: "var(--vb-fg)" }}>public</strong>.
                  </p>
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
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
                          setRules((prev) => ({ ...prev, [opId]: prev[opId] }));
                        }
                      }}
                      onChange={(v) => setRules((prev) => ({ ...prev, [opId]: v }))}
                      schemaFields={fields}
                    />
                  );
                })}
              </div>

              <div style={{
                marginTop: 16, padding: "12px 14px",
                background: "var(--vb-bg-1)",
                border: "1px dashed var(--vb-border-2)",
                borderRadius: 6,
                fontSize: 11.5, color: "var(--vb-fg-2)",
                display: "flex", alignItems: "center", gap: 10,
              }}>
                <Icon name="sparkle" size={13} />
                <span>
                  Available in expressions:{" "}
                  <code style={{
                    fontFamily: "var(--font-mono)", fontSize: "0.86em",
                    padding: "1px 5px", borderRadius: 4,
                    background: "var(--vb-code-bg)", color: "var(--vb-code-fg)",
                  }}>@request.auth.*</code>,{" "}
                  <code style={{
                    fontFamily: "var(--font-mono)", fontSize: "0.86em",
                    padding: "1px 5px", borderRadius: 4,
                    background: "var(--vb-code-bg)", color: "var(--vb-code-fg)",
                  }}>@request.data.*</code>,{" "}
                  <code style={{
                    fontFamily: "var(--font-mono)", fontSize: "0.86em",
                    padding: "1px 5px", borderRadius: 4,
                    background: "var(--vb-code-bg)", color: "var(--vb-code-fg)",
                  }}>@collection.*</code>
                  , plus all field paths on the record.
                </span>
              </div>
            </div>
          )}
          {tab === "indexes" && showIndexesTab && (
            <div className="schema-tab-narrow">
              <div style={{
                display: "flex", alignItems: "flex-start", justifyContent: "space-between",
                marginBottom: 14, gap: 16,
              }}>
                <div style={{ maxWidth: 540 }}>
                  <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--vb-fg)", marginBottom: 4 }}>
                    Indexes
                  </h2>
                  <p style={{ margin: 0, fontSize: 12, color: "var(--vb-fg-2)", lineHeight: 1.55 }}>
                    SQL indexes speed up filter &amp; sort queries on this collection. Add one
                    for any field you query frequently.
                  </p>
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
        <SchemaCard
          title="SELECT query"
          meta={<>backed by SQLite VIEW <SchemaCode>vb_{collection.name}</SchemaCode></>}
          right={
            <>
              <VbBtn kind="ghost" size="sm" icon="eye" onClick={previewViewRowsHandler} disabled={previewing}>
                {previewing ? "Loading…" : "Preview 5 rows"}
              </VbBtn>
              <VbBtn kind="ghost" size="sm" icon="play" onClick={validateView} disabled={validating}>
                {validating ? "Validating…" : "Validate & refresh"}
              </VbBtn>
            </>
          }
        >
          <div style={{
            border: "1px solid var(--vb-border-2)",
            borderRadius: 6,
            overflow: "hidden",
            background: "var(--vb-bg-3)",
          }}>
            <CodeEditor
              language="sql"
              value={viewQuery}
              onChange={(v) => { setViewQuery(v); setViewError(null); }}
              sqlSchema={sqlSchema}
              markers={viewError ? [{ message: viewError, line: 1, severity: "error" }] : []}
              height={220}
            />
          </div>
          <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--vb-fg-3)", lineHeight: 1.55 }}>
            Single SELECT only — no semicolons, no DML/DDL. Autocompletes <SchemaCode>vb_*</SchemaCode> tables and columns.
          </div>
          {previewRows && (
            <div style={{
              marginTop: 14,
              border: "1px solid var(--vb-border)",
              borderRadius: 7,
              overflow: "hidden",
              background: "var(--vb-bg-1)",
            }}>
              <div style={{
                padding: "9px 12px",
                background: "var(--vb-bg-2)",
                borderBottom: "1px solid var(--vb-border)",
                fontFamily: "var(--font-mono)",
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: 1.2,
                textTransform: "uppercase",
                color: "var(--vb-fg-3)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}>
                <span>Preview · {previewRows.rows.length} {previewRows.rows.length === 1 ? "row" : "rows"}</span>
                <VbBtn kind="ghost" size="sm" icon="x" onClick={() => setPreviewRows(null)} title="Close" />
              </div>
              {previewRows.rows.length === 0 ? (
                <div style={{ padding: 18, fontSize: 12, color: "var(--vb-fg-3)", textAlign: "center" }}>
                  Query returned no rows.
                </div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "var(--vb-fg)",
                  }}>
                    <thead>
                      <tr>
                        {previewRows.columns.map((c) => (
                          <th key={c} style={{
                            textAlign: "left",
                            padding: "8px 12px",
                            background: "var(--vb-bg-1)",
                            borderBottom: "1px solid var(--vb-border)",
                            color: "var(--vb-fg-3)",
                            fontWeight: 600,
                            letterSpacing: 0.6,
                            textTransform: "uppercase",
                            fontSize: 10.5,
                          }}>{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {previewRows.rows.map((row, i) => (
                        <tr key={i} style={{ borderBottom: i === previewRows.rows.length - 1 ? "none" : "1px solid var(--vb-border)" }}>
                          {previewRows.columns.map((c) => {
                            const v = row[c];
                            const display = v === null || v === undefined ? <span style={{ color: "var(--vb-fg-3)" }}>null</span>
                              : typeof v === "object" ? <span style={{ color: "var(--vb-fg-2)" }}>{JSON.stringify(v)}</span>
                              : String(v);
                            return (
                              <td key={c} style={{
                                padding: "7px 12px",
                                maxWidth: 240,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}>{display}</td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </SchemaCard>
      )}

      {!isView && (
        <div style={{
          display: "grid",
          gridTemplateColumns: showPanel ? "1fr 400px" : "1fr",
          gap: 16,
          alignItems: "start",
        }}>
          <div style={{
            background: "var(--vb-bg-2)",
            border: "1px solid var(--vb-border)",
            borderRadius: 8,
            overflow: "hidden",
            minWidth: 0,
          }}>
            <SchemaTableHeader />
            <div>
              {fields.map((f, i) => (
                <FieldRow
                  key={i}
                  field={f}
                  index={i}
                  selected={selectedIdx === i}
                  isLast={i === fields.length - 1}
                  onSelect={() => setSelectedIdx(selectedIdx === i ? null : i)}
                  onRename={(name) =>
                    setFields((fs) => fs.map((x, xi) => xi === i ? { ...x, name } : x))
                  }
                  onRemove={() => removeField(i)}
                />
              ))}
            </div>
            <div style={{
              padding: 12,
              borderTop: "1px solid var(--vb-border)",
              background: "var(--vb-bg-1)",
            }}>
              <FieldTypePicker onPick={addField} />
            </div>
          </div>

          {showPanel && sel && (
            <div style={{
              background: "var(--vb-bg-2)",
              border: "1px solid var(--vb-border)",
              borderRadius: 8,
              overflow: "hidden",
              position: "sticky",
              top: 16,
            }}>
              <div style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "12px 14px",
                background: "var(--vb-bg-1)",
                borderBottom: "1px solid var(--vb-border)",
              }}>
                <span style={{
                  fontSize: 10.5,
                  fontWeight: 600,
                  letterSpacing: 1.2,
                  textTransform: "uppercase",
                  color: "var(--vb-fg-3)",
                  fontFamily: "var(--font-mono)",
                }}>Field options</span>
                <FieldTypePill type={sel.type} />
                <span style={{ flex: 1 }} />
                <VbBtn kind="ghost" size="sm" icon="x" onClick={() => setSelectedIdx(null)} title="Close panel" />
              </div>
              <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14, maxHeight: "calc(100vh - 240px)", overflowY: "auto" }}>
                <FieldOptionsBody
                  sel={sel}
                  updateSel={updateSel}
                  updateSelOptions={updateSelOptions}
                  numOrUndef={numOrUndef}
                  allCollections={allCollections}
                  collId={collId}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SchemaCard({
  title, meta, right, children,
}: { title: string; meta?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{
      background: "var(--vb-bg-2)",
      border: "1px solid var(--vb-border)",
      borderRadius: 8,
      overflow: "hidden",
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 16px",
        borderBottom: "1px solid var(--vb-border)",
        background: "var(--vb-bg-1)",
        gap: 12,
      }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--vb-fg)" }}>{title}</h3>
          {meta && (
            <span style={{ fontSize: 11.5, color: "var(--vb-fg-3)" }}>{meta}</span>
          )}
        </div>
        {right && <div style={{ display: "flex", gap: 8 }}>{right}</div>}
      </div>
      <div style={{ padding: 16 }}>{children}</div>
    </div>
  );
}

function SchemaCode({ children }: { children: React.ReactNode }) {
  return (
    <code style={{
      fontFamily: "var(--font-mono)",
      fontSize: "0.86em",
      padding: "1px 5px",
      borderRadius: 4,
      background: "var(--vb-bg-3)",
      color: "var(--vb-fg)",
    }}>{children}</code>
  );
}

function SchemaTableHeader() {
  const labelStyle: React.CSSProperties = {
    fontSize: 10.5,
    fontWeight: 600,
    letterSpacing: 1.2,
    textTransform: "uppercase",
    color: "var(--vb-fg-3)",
    fontFamily: "var(--font-mono)",
  };
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "20px minmax(140px, 1fr) auto minmax(160px, 2fr) auto 28px",
      gap: 12,
      padding: "9px 14px",
      alignItems: "center",
      background: "var(--vb-bg-1)",
      borderBottom: "1px solid var(--vb-border)",
    }}>
      <span />
      <span style={labelStyle}>Name</span>
      <span style={labelStyle}>Type</span>
      <span style={labelStyle}>Constraints</span>
      <span style={{ ...labelStyle, textAlign: "right" }}>Flags</span>
      <span />
    </div>
  );
}

// ── Field row ───────────────────────────────────────────────────────────────
function FieldRow({
  field, index, selected, isLast, onSelect, onRename, onRemove,
}: {
  field: FieldDef;
  index: number;
  selected: boolean;
  isLast: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const nameLocked = field.system || field.implicit;
  const summary = describeField(field);
  return (
    <div
      onClick={onSelect}
      data-idx={index}
      style={{
        display: "grid",
        gridTemplateColumns: "20px minmax(140px, 1fr) auto minmax(160px, 2fr) auto 28px",
        gap: 12,
        padding: "10px 14px",
        alignItems: "center",
        borderBottom: isLast ? "none" : "1px solid var(--vb-border)",
        borderLeft: selected ? "2px solid var(--vb-accent)" : "2px solid transparent",
        marginLeft: selected ? -2 : 0,
        background: selected ? "var(--vb-accent-soft)" : "transparent",
        cursor: "pointer",
        transition: "background 100ms",
        opacity: nameLocked ? 0.85 : 1,
        minWidth: 0,
      }}
      onMouseEnter={(e) => {
        if (!selected) e.currentTarget.style.background = "var(--vb-bg-3)";
      }}
      onMouseLeave={(e) => {
        if (!selected) e.currentTarget.style.background = "transparent";
      }}
    >
      <span style={{ color: "var(--vb-fg-3)", display: "inline-flex", cursor: "grab" }}>
        <Icon name="grip" size={12} />
      </span>
      {nameLocked ? (
        <span style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12.5,
          color: selected ? "var(--vb-accent)" : "var(--vb-fg)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}>{field.name}</span>
      ) : (
        <input
          value={field.name}
          onChange={(e) => onRename(e.target.value.replace(/[^a-z0-9_]/g, ""))}
          onClick={(e) => e.stopPropagation()}
          placeholder="field_name"
          style={{
            width: "100%",
            height: 28,
            padding: "0 8px",
            background: "var(--vb-bg-1)",
            border: "1px solid var(--vb-border-2)",
            borderRadius: 4,
            color: "var(--vb-fg)",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            outline: "none",
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = "var(--vb-accent)"; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = "var(--vb-border-2)"; }}
        />
      )}
      <FieldTypePill type={field.type} />
      <span
        title={summary}
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11.5,
          color: "var(--vb-fg-3)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >{summary}</span>
      <span style={{ display: "inline-flex", gap: 5, justifyContent: "flex-end" }}>
        <FlagPill on={!!field.required} label="req" tone="warning" />
        <FlagPill on={!!field.options?.["unique"]} label="uniq" tone="accent" />
      </span>
      {!nameLocked ? (
        <span onClick={(e) => e.stopPropagation()} style={{ display: "inline-flex", justifyContent: "flex-end" }}>
          <VbBtn kind="danger" size="sm" icon="x" onClick={onRemove} title="Remove field" />
        </span>
      ) : (
        <span style={{
          fontFamily: "var(--font-mono)",
          fontSize: 9.5,
          color: "var(--vb-fg-3)",
          textTransform: "uppercase",
          letterSpacing: 0.6,
          textAlign: "right",
        }}>{field.implicit ? "impl" : "sys"}</span>
      )}
    </div>
  );
}

function FlagPill({ on, label, tone }: { on: boolean; label: string; tone: "warning" | "accent" }) {
  const onColor = tone === "warning" ? "var(--vb-status-warning)" : "var(--vb-accent)";
  const onBg = tone === "warning" ? "var(--vb-status-warning-bg)" : "var(--vb-accent-soft)";
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      padding: "2px 6px",
      borderRadius: 4,
      fontFamily: "var(--font-mono)",
      fontSize: 9.5,
      fontWeight: 600,
      letterSpacing: 0.4,
      textTransform: "uppercase",
      background: on ? onBg : "transparent",
      color: on ? onColor : "var(--vb-fg-3)",
      border: on ? "1px solid transparent" : "1px solid var(--vb-border-2)",
      opacity: on ? 1 : 0.55,
    }}>
      <Icon name={tone === "warning" ? "check" : "star"} size={9} /> {label}
    </span>
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
      <VbField
        label="Name"
        hint={locked ? (
          sel.implicit
            ? "Implicit auth field — name and type are locked, options are editable below"
            : "System field — name is locked"
        ) : undefined}
        right={locked ? <VbPill tone={sel.implicit ? "accent" : "neutral"}>{sel.implicit ? "implicit" : "system"}</VbPill> : undefined}
      >
        <VbInput
          mono
          value={sel.name}
          onChange={(e) => updateSel({ name: e.target.value.replace(/[^a-z0-9_]/g, "") })}
          disabled={locked}
        />
      </VbField>

      <VbField label="Type">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {FIELD_TYPES.map((t) => {
            const active = t === sel.type;
            return (
              <button
                key={t}
                type="button"
                onClick={() => !locked && updateSel({ type: t })}
                disabled={locked}
                style={{
                  appearance: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  padding: "4px 9px",
                  borderRadius: 4,
                  border: active ? "1px solid var(--vb-accent)" : "1px dashed var(--vb-border-2)",
                  background: active ? "var(--vb-accent-soft)" : "transparent",
                  color: active ? "var(--vb-accent)" : "var(--vb-fg-2)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  cursor: locked ? "not-allowed" : "pointer",
                  opacity: locked && !active ? 0.45 : 1,
                  transition: "background 100ms, border-color 100ms",
                }}
              >{t}</button>
            );
          })}
        </div>
      </VbField>

      <OptionRow
        title="Required"
        hint="Reject records without this field"
        on={sel.required ?? false}
        onChange={(v) => updateSel({ required: v })}
      />

      {(sel.type === "text" || sel.type === "email" || sel.type === "url") && (
        <>
          <VbField label="Min / Max length">
            <div style={{ display: "flex", gap: 8 }}>
              <VbInput
                mono
                type="number"
                min={0}
                value={(sel.options?.["min"] as number | undefined) ?? ""}
                onChange={(e) => updateSelOptions({ min: numOrUndef(e.target.value) })}
                placeholder="0"
              />
              <VbInput
                mono
                type="number"
                min={0}
                value={(sel.options?.["max"] as number | undefined) ?? ""}
                onChange={(e) => updateSelOptions({ max: numOrUndef(e.target.value) })}
                placeholder="—"
              />
            </div>
          </VbField>
          {sel.type === "text" && (
            <VbField label="Regex pattern">
              <VbInput
                mono
                value={(sel.options?.["pattern"] as string | undefined) ?? ""}
                onChange={(e) => updateSelOptions({ pattern: e.target.value || undefined })}
                placeholder="^[a-z0-9-]+$"
              />
            </VbField>
          )}
          <OptionRow
            title="Unique"
            hint="Disallow duplicate values"
            on={!!sel.options?.["unique"]}
            onChange={(v) => updateSelOptions({ unique: v })}
          />
          <OptionRow
            title="Encrypt at rest"
            hint={<>AES-GCM. Disables filtering &amp; uniqueness on this field. Requires <SchemaCode>VAULTBASE_ENCRYPTION_KEY</SchemaCode>.</>}
            on={!!sel.options?.["encrypted"]}
            onChange={(v) => updateSelOptions({ encrypted: v })}
          />
        </>
      )}
      {sel.type === "json" && (
        <OptionRow
          title="Encrypt at rest"
          hint={<>AES-GCM. Requires <SchemaCode>VAULTBASE_ENCRYPTION_KEY</SchemaCode>.</>}
          on={!!sel.options?.["encrypted"]}
          onChange={(v) => updateSelOptions({ encrypted: v })}
        />
      )}
      {sel.type === "password" && (
        <VbField
          label="Min / Max length"
          hint="Stored as a bcrypt hash. Never returned by the API. To clear a password, send an empty string."
        >
          <div style={{ display: "flex", gap: 8 }}>
            <VbInput
              mono
              type="number"
              min={0}
              value={(sel.options?.["min"] as number | undefined) ?? ""}
              onChange={(e) => updateSelOptions({ min: numOrUndef(e.target.value) })}
              placeholder="min (e.g. 8)"
            />
            <VbInput
              mono
              type="number"
              min={0}
              value={(sel.options?.["max"] as number | undefined) ?? ""}
              onChange={(e) => updateSelOptions({ max: numOrUndef(e.target.value) })}
              placeholder="max"
            />
          </div>
        </VbField>
      )}
      {sel.type === "editor" && (
        <VbField label="Max length" hint="Stored as raw HTML. Sanitize on the client before rendering untrusted input.">
          <VbInput
            mono
            type="number"
            min={0}
            value={(sel.options?.["max"] as number | undefined) ?? ""}
            onChange={(e) => updateSelOptions({ max: numOrUndef(e.target.value) })}
            placeholder="—"
          />
        </VbField>
      )}
      {sel.type === "geoPoint" && (
        <div style={{
          fontSize: 11.5,
          color: "var(--vb-fg-3)",
          padding: "10px 12px",
          background: "var(--vb-bg-1)",
          border: "1px solid var(--vb-border)",
          borderRadius: 6,
          lineHeight: 1.55,
        }}>
          Stored as <SchemaCode>{`{ lat, lng }`}</SchemaCode> JSON. Latitude in [-90, 90], longitude in [-180, 180].
        </div>
      )}
      {sel.type === "number" && (
        <>
          <VbField label="Min / Max value">
            <div style={{ display: "flex", gap: 8 }}>
              <VbInput
                mono
                type="number"
                value={(sel.options?.["min"] as number | undefined) ?? ""}
                onChange={(e) => updateSelOptions({ min: numOrUndef(e.target.value) })}
                placeholder="—"
              />
              <VbInput
                mono
                type="number"
                value={(sel.options?.["max"] as number | undefined) ?? ""}
                onChange={(e) => updateSelOptions({ max: numOrUndef(e.target.value) })}
                placeholder="—"
              />
            </div>
          </VbField>
          <OptionRow
            title="Unique"
            hint="Disallow duplicate values"
            on={!!sel.options?.["unique"]}
            onChange={(v) => updateSelOptions({ unique: v })}
          />
        </>
      )}
      {sel.type === "relation" && (
        <>
          <VbField label="Target collection">
            {allCollections.filter((c) => c.id !== collId).length === 0 ? (
              <div style={{ fontSize: 11.5, color: "var(--vb-fg-3)" }}>
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
                style={{ width: "100%", height: 32 }}
                panelStyle={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
              />
            )}
          </VbField>
          <VbField
            label="On target delete"
            hint="What to do with this record when the referenced record is deleted."
          >
            <Dropdown
              value={(sel.options?.["cascade"] as string | undefined) ?? "setNull"}
              options={[
                { label: "Set to null (default)", value: "setNull" },
                { label: "Cascade delete",        value: "cascade" },
                { label: "Restrict (block)",      value: "restrict" },
              ]}
              onChange={(e) => updateSelOptions({ cascade: e.value })}
              style={{ width: "100%", height: 32 }}
              panelStyle={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
            />
          </VbField>
        </>
      )}
      {sel.type === "select" && (
        <>
          <VbField label="Allowed values" hint="At least one value is required for select fields.">
            <Chips
              value={Array.isArray(sel.options?.["values"]) ? (sel.options?.["values"] as string[]) : []}
              onChange={(e) => updateSelOptions({ values: e.value ?? [] })}
              placeholder="Type a value and press Enter"
              separator=","
              style={{ width: "100%" }}
            />
          </VbField>
          <OptionRow
            title="Allow multiple values"
            on={!!sel.options?.["multiple"]}
            onChange={(v) => updateSelOptions({ multiple: v })}
          />
        </>
      )}
      {sel.type === "file" && (
        <>
          <VbField label="Max size (bytes)">
            <VbInput
              mono
              type="number"
              min={0}
              value={(sel.options?.["maxSize"] as number | undefined) ?? ""}
              onChange={(e) => updateSelOptions({ maxSize: numOrUndef(e.target.value) })}
              placeholder="5242880 = 5MB"
            />
          </VbField>
          <VbField label="Allowed mime types">
            <Chips
              value={Array.isArray(sel.options?.["mimeTypes"]) ? (sel.options?.["mimeTypes"] as string[]) : []}
              onChange={(e) => updateSelOptions({ mimeTypes: e.value ?? [] })}
              placeholder="image/* — press Enter"
              separator=","
              style={{ width: "100%" }}
            />
          </VbField>
          <OptionRow
            title="Multiple files"
            hint="Stores an array of filenames instead of a single one."
            on={!!sel.options?.["multiple"]}
            onChange={(v) => updateSelOptions({ multiple: v })}
          />
          <OptionRow
            title="Protected"
            hint={<>Public GETs return 401. Issue a 1h access token via <SchemaCode>POST /api/v1/files/.../token</SchemaCode>, then pass <SchemaCode>?token=</SchemaCode>.</>}
            on={!!sel.options?.["protected"]}
            onChange={(v) => updateSelOptions({ protected: v })}
          />

          {/* ── Rule-based file protection ─────────────────────────────── */}
          <SectionDivider label="Download protection" />
          <VbField
            label="Download rule"
            hint={
              <>
                Per-field rule, AND-combined with the collection's view rule. Empty = inherit collection rule.
                Extra context: <SchemaCode>@request.headers.x_vb_ip</SchemaCode>, <SchemaCode>x_vb_file_size</SchemaCode>, <SchemaCode>x_vb_file_mime</SchemaCode>.
              </>
            }
          >
            <textarea
              rows={3}
              value={(sel.options?.["viewRule"] as string | undefined) ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                updateSelOptions({ viewRule: v === "" ? undefined : v });
              }}
              placeholder="@auth.id != '' && @auth.id = record.owner"
              style={{
                width: "100%",
                background: "var(--vb-bg-3)",
                border: "1px solid var(--vb-border-2)",
                borderRadius: 5,
                color: "var(--vb-fg)",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                padding: "8px 10px",
                resize: "vertical",
                outline: "none",
              }}
            />
          </VbField>
          <OptionRow
            title="Require authentication"
            hint="Reject anonymous downloads even when the collection's view rule is public."
            on={!!sel.options?.["requireAuth"]}
            onChange={(v) => updateSelOptions({ requireAuth: v || undefined })}
          />
          <OptionRow
            title="One-time download token"
            hint={<>Each token works for a single fetch. Replay returns <SchemaCode>410 Gone</SchemaCode>.</>}
            on={!!sel.options?.["oneTimeToken"]}
            onChange={(v) => updateSelOptions({ oneTimeToken: v || undefined })}
          />
          <OptionRow
            title="Bind token to IP"
            hint="Token rejects requests from a different IP. Incompatible with mobile NAT — opt-in."
            on={!!sel.options?.["bindTokenIp"]}
            onChange={(v) => updateSelOptions({ bindTokenIp: v || undefined })}
          />
          <OptionRow
            title="Audit downloads"
            hint={<>Append a <SchemaCode>files.download</SchemaCode> row to the audit log per fetch.</>}
            on={!!sel.options?.["auditDownloads"]}
            onChange={(v) => updateSelOptions({ auditDownloads: v || undefined })}
          />
        </>
      )}
    </>
  );
}

function OptionRow({
  title, hint, on, onChange,
}: { title: string; hint?: React.ReactNode; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "space-between",
      gap: 12,
      padding: "10px 12px",
      background: "var(--vb-bg-1)",
      border: "1px solid var(--vb-border)",
      borderRadius: 6,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 500, color: "var(--vb-fg)" }}>{title}</div>
        {hint && (
          <div style={{ fontSize: 11, color: "var(--vb-fg-3)", marginTop: 3, lineHeight: 1.5 }}>{hint}</div>
        )}
      </div>
      <Toggle on={on} onChange={onChange} />
    </div>
  );
}

function SectionDivider({ label }: { label: string }) {
  return (
    <div style={{
      marginTop: 6,
      paddingTop: 14,
      borderTop: "1px solid var(--vb-border)",
      fontSize: 10.5,
      fontWeight: 600,
      letterSpacing: 1.2,
      textTransform: "uppercase",
      color: "var(--vb-fg-3)",
      fontFamily: "var(--font-mono)",
    }}>{label}</div>
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
    const res = await api.get<ApiResponse<IndexInfo[]>>(`/api/v1/admin/collections/${collectionName}/indexes`);
    if (res.data) setIndexes(res.data);
    setLoading(false);
  }
  useEffect(() => { load(); }, [collectionName]);

  async function handleAdd() {
    if (!newField) return;
    const res = await api.post<ApiResponse<IndexInfo>>(
      `/api/v1/admin/collections/${collectionName}/indexes`,
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
      `/api/v1/admin/collections/${collectionName}/indexes/${idx.name}`
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
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setHighlight(0);
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
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{
            appearance: "none",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            width: "100%",
            height: 34,
            borderRadius: 6,
            border: "1px dashed var(--vb-border-2)",
            background: "transparent",
            color: "var(--vb-fg-2)",
            fontFamily: "inherit",
            fontSize: 12.5,
            fontWeight: 600,
            cursor: "pointer",
            transition: "background 100ms, border-color 100ms, color 100ms",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--vb-bg-3)";
            e.currentTarget.style.borderColor = "var(--vb-accent)";
            e.currentTarget.style.color = "var(--vb-accent)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.borderColor = "var(--vb-border-2)";
            e.currentTarget.style.color = "var(--vb-fg-2)";
          }}
        >
          <Icon name="plus" size={12} /> Add field
        </button>
      ) : (
        <div style={{
          background: "var(--vb-bg-2)",
          border: "1px solid var(--vb-border-2)",
          borderRadius: 6,
          overflow: "hidden",
          boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
        }}>
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 12px",
            borderBottom: "1px solid var(--vb-border)",
            background: "var(--vb-bg-1)",
          }}>
            <span style={{ color: "var(--vb-fg-3)", display: "inline-flex" }}>
              <Icon name="search" size={12} />
            </span>
            <input
              ref={inputRef}
              placeholder="Search field types…"
              value={query}
              onChange={(e) => { setQuery(e.target.value); setHighlight(0); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && filtered[highlight]) { pick(filtered[highlight]!); }
                else if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(filtered.length - 1, h + 1)); }
                else if (e.key === "ArrowUp")   { e.preventDefault(); setHighlight((h) => Math.max(0, h - 1)); }
              }}
              style={{
                flex: 1,
                background: "transparent",
                border: "none",
                color: "var(--vb-fg)",
                fontFamily: "var(--font-mono)",
                fontSize: 12.5,
                outline: "none",
              }}
            />
            <kbd style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              padding: "1px 5px",
              borderRadius: 3,
              background: "var(--vb-bg-3)",
              color: "var(--vb-fg-3)",
              border: "1px solid var(--vb-border-2)",
            }}>esc</kbd>
          </div>
          <div style={{ maxHeight: 320, overflowY: "auto" }}>
            {filtered.length === 0 && (
              <div style={{ padding: 18, fontSize: 12, color: "var(--vb-fg-3)", textAlign: "center" }}>
                No matches for "{query}"
              </div>
            )}
            {filtered.map((t, i) => {
              const active = i === highlight;
              return (
                <div
                  key={t}
                  onClick={() => pick(t)}
                  onMouseEnter={() => setHighlight(i)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "9px 12px",
                    borderBottom: i === filtered.length - 1 ? "none" : "1px solid var(--vb-border)",
                    background: active ? "var(--vb-accent-soft)" : "transparent",
                    cursor: "pointer",
                    transition: "background 80ms",
                  }}
                >
                  <FieldTypePill type={t} />
                  <span style={{
                    fontSize: 11.5,
                    color: active ? "var(--vb-fg)" : "var(--vb-fg-3)",
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}>{FIELD_TYPE_DESC[t]}</span>
                  {active && (
                    <kbd style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 10,
                      padding: "1px 5px",
                      borderRadius: 3,
                      background: "var(--vb-bg-3)",
                      color: "var(--vb-fg-3)",
                      border: "1px solid var(--vb-border-2)",
                    }}>↵</kbd>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
