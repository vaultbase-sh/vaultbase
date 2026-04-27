import { useEffect, useMemo, useRef, useState } from "react";
import { Dropdown } from "primereact/dropdown";
import { Chips } from "primereact/chips";
import {
  api, AUTH_RESERVED_FIELD_NAMES, type ApiResponse, type Collection, type FieldDef, collColor, parseFields,
} from "../api.ts";
import { CodeEditor, type SqlSchema } from "../components/CodeEditor.tsx";
import { useNavigate, useParams } from "react-router-dom";
import { Topbar } from "../components/Shell.tsx";
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

export default function CollectionEdit() {
  const params = useParams();
  const navigate = useNavigate();
  const collId = params["id"] ?? "";
  const [collection, setCollection] = useState<Collection | null>(null);
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [rules, setRules] = useState<Rules>({ list: "", view: "", create: "", update: "", delete: "" });
  const [saving, setSaving] = useState(false);
  const [allCollections, setAllCollections] = useState<Collection[]>([]);
  const [viewQuery, setViewQuery] = useState("");
  const [viewError, setViewError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const isView = collection?.type === "view";

  const sqlSchema: SqlSchema = useMemo(() => ({
    tables: allCollections
      .filter((c) => c.id !== collId) // exclude self while editing
      .map((c) => {
        const cols = ["id", "created_at", "updated_at"];
        for (const f of parseFields(c.fields)) {
          if (f.implicit && c.type === "auth") continue; // implicit fields don't have real columns
          if (f.system) continue;
          cols.push(f.name);
        }
        return { name: `vb_${c.name}`, collectionName: c.name, columns: cols };
      }),
  }), [allCollections, collId]);

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
      // Preserve any user-customized field types where the column name still exists.
      const oldByName = new Map(fields.map((f) => [f.name, f]));
      const merged = res.data.fields.map((f) => oldByName.get(f.name) ?? f);
      setFields(merged);
    }
    toast("Query validated", "check");
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

  const sel = fields[selectedIdx];

  function updateSel(patch: Partial<FieldDef>) {
    setFields((fs) => fs.map((f, i) => (i === selectedIdx ? { ...f, ...patch } : f)));
  }

  function updateSelOptions(patch: Record<string, unknown>) {
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
    if (selectedIdx >= i) setSelectedIdx(Math.max(0, selectedIdx - 1));
  }

  async function handleSave() {
    if (!collection) return;

    if (isView) {
      if (!viewQuery.trim()) { toast("View collections need a SELECT query"); return; }
      setSaving(true);
      // Backend re-infers fields when view_query changes; we only send field defs
      // when caller hasn't changed the query so user-tweaked field types persist.
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

  return (
    <>
      <Topbar
        title={
          <span className="row" style={{ gap: 10 }}>
            <span className={`coll-icon ${color}`} style={{ width: 22, height: 22, fontSize: 11 }}>
              {collection.name[0]!.toUpperCase()}
            </span>
            <span className="mono" style={{ fontSize: 14 }}>{collection.name}</span>
          </span>
        }
        subtitle={`schema editor · ${fields.length} fields`}
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
            <span style={{ width: 12, borderLeft: "0.5px solid var(--border-default)", height: 18, marginLeft: 4 }} />
            <button className="btn btn-danger" onClick={handleDelete}>
              <Icon name="trash" size={12} /> Delete collection
            </button>
          </>
        }
      />
      <div className="app-body">
        <div className="editor-layout">
          <div className="col" style={{ gap: 16 }}>
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
                    <button className="btn btn-ghost" onClick={validateView} disabled={validating}>
                      <Icon name="play" size={11} />
                      {validating ? "Validating…" : "Validate & refresh columns"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Field list — hidden for view collections (auto-derived from SQL) */}
            {!isView && (
            <div className="editor-card">
              <div className="editor-card-head">
                <h3>Schema fields</h3>
                <span className="meta">{fields.length} fields</span>
              </div>
              <div>
                {fields.map((f, i) => {
                  const nameLocked = f.system || f.implicit;
                  return (
                  <div
                    key={i}
                    className={`field-row-edit${selectedIdx === i ? " selected" : ""}`}
                    onClick={() => setSelectedIdx(i)}
                  >
                    <span className="grip"><Icon name="grip" size={12} /></span>
                    {nameLocked ? (
                      <span className="name">{f.name}</span>
                    ) : (
                      <input
                        className="input mono"
                        style={{ height: 26, fontSize: 12, minWidth: 130, maxWidth: 160 }}
                        value={f.name}
                        onChange={(e) => setFields((fs) => fs.map((x, xi) => xi === i
                          ? { ...x, name: e.target.value.replace(/[^a-z0-9_]/g, "") }
                          : x))}
                        onClick={(e) => e.stopPropagation()}
                        placeholder="field_name"
                      />
                    )}
                    <FieldTypeChip type={f.type} />
                    {f.required && <span className="req">required</span>}
                    {f.system && <span className="system">system</span>}
                    {f.implicit && <span className="system" title="Implicit auth field — managed schema, options editable">implicit</span>}
                    {!nameLocked && (
                      <button
                        className="btn-icon"
                        onClick={(e) => { e.stopPropagation(); removeField(i); }}
                      >
                        <Icon name="x" size={12} />
                      </button>
                    )}
                    {f.implicit && (
                      <Toggle
                        on={f.required ?? false}
                        onChange={(v) => setFields((fs) => fs.map((x, xi) => xi === i ? { ...x, required: v } : x))}
                      />
                    )}
                    {!f.system && !f.implicit && (
                      <Toggle
                        on={f.required ?? false}
                        onChange={(v) => setFields((fs) => fs.map((x, xi) => xi === i ? { ...x, required: v } : x))}
                      />
                    )}
                  </div>
                  );
                })}
              </div>
              <FieldTypePicker onPick={addField} />
            </div>
            )}

            {/* API rules */}
            <div className="editor-card">
              <div className="editor-card-head">
                <h3>API rules</h3>
                <span className="meta">empty = admin only · null = public</span>
              </div>
              <div>
                {(isView
                  ? (["list", "view"] as const)
                  : (["list", "view", "create", "update", "delete"] as const)
                ).map((r) => (
                  <div className="rule-row" key={r}>
                    <span className="rule-name">{r} rule</span>
                    <RuleEditor
                      value={rules[r]}
                      onChange={(v) => setRules((prev) => ({ ...prev, [r]: v }))}
                      schemaFields={fields}
                      placeholder={r === "list" ? '@request.auth.id != ""' : ""}
                    />
                  </div>
                ))}
              </div>
            </div>

            {!isView && <IndexesSection collectionName={collection.name} fields={fields} />}
          </div>

          {/* Right: field options */}
          <div className="editor-card" style={{ position: "sticky", top: 0 }}>
            <div className="editor-card-head">
              <h3>Field options</h3>
              {sel && <FieldTypeChip type={sel.type} />}
            </div>
            {sel ? (
              <div style={{ padding: 14 }}>
                <div className="col" style={{ gap: 14 }}>
                  <div>
                    <label className="label">Name</label>
                    <input
                      className="input mono"
                      value={sel.name}
                      onChange={(e) => updateSel({ name: e.target.value.replace(/[^a-z0-9_]/g, "") })}
                      disabled={sel.system || sel.implicit}
                    />
                    {(sel.system || sel.implicit) && (
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
                          onClick={() => !(sel.system || sel.implicit) && updateSel({ type: t })}
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div
                    className="row"
                    style={{ justifyContent: "space-between", padding: "8px 10px", background: "rgba(255,255,255,0.03)", borderRadius: 7 }}
                  >
                    <div>
                      <div style={{ fontSize: 12 }}>Required</div>
                      <div className="muted" style={{ fontSize: 11 }}>Reject records without this field</div>
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
                      <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", background: "rgba(255,255,255,0.03)", borderRadius: 7 }}>
                        <span style={{ fontSize: 12 }}>Unique</span>
                        <Toggle
                          on={!!sel.options?.["unique"]}
                          onChange={(v) => updateSelOptions({ unique: v })}
                        />
                      </label>
                      <label style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "8px 10px", background: "rgba(255,255,255,0.03)", borderRadius: 7, gap: 12 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12 }}>Encrypt at rest</div>
                          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                            AES-GCM. Disables filtering &amp; uniqueness on this field. Requires <span className="mono">VAULTBASE_ENCRYPTION_KEY</span>.
                          </div>
                        </div>
                        <Toggle
                          on={!!sel.options?.["encrypted"]}
                          onChange={(v) => updateSelOptions({ encrypted: v })}
                        />
                      </label>
                    </>
                  )}
                  {sel.type === "json" && (
                    <label style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "8px 10px", background: "rgba(255,255,255,0.03)", borderRadius: 7, gap: 12 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 12 }}>Encrypt at rest</div>
                        <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                          AES-GCM. Requires <span className="mono">VAULTBASE_ENCRYPTION_KEY</span>.
                        </div>
                      </div>
                      <Toggle
                        on={!!sel.options?.["encrypted"]}
                        onChange={(v) => updateSelOptions({ encrypted: v })}
                      />
                    </label>
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
                    <div className="muted" style={{ fontSize: 11, padding: "8px 10px", background: "rgba(255,255,255,0.03)", borderRadius: 7 }}>
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
                      <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", background: "rgba(255,255,255,0.03)", borderRadius: 7 }}>
                        <span style={{ fontSize: 12 }}>Unique</span>
                        <Toggle
                          on={!!sel.options?.["unique"]}
                          onChange={(v) => updateSelOptions({ unique: v })}
                        />
                      </label>
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
                      <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", background: "rgba(255,255,255,0.03)", borderRadius: 7 }}>
                        <span style={{ fontSize: 12 }}>Allow multiple values</span>
                        <Toggle
                          on={!!sel.options?.["multiple"]}
                          onChange={(v) => updateSelOptions({ multiple: v })}
                        />
                      </label>
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
                      <label style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "8px 10px", background: "rgba(255,255,255,0.03)", borderRadius: 7, gap: 12 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12 }}>Multiple files</div>
                          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                            Stores an array of filenames instead of a single one.
                          </div>
                        </div>
                        <Toggle
                          on={!!sel.options?.["multiple"]}
                          onChange={(v) => updateSelOptions({ multiple: v })}
                        />
                      </label>
                      <label style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", padding: "8px 10px", background: "rgba(255,255,255,0.03)", borderRadius: 7, gap: 12 }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12 }}>Protected</div>
                          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                            Public GETs return 401. Issue a 1h access token via{" "}
                            <span className="mono">POST /api/files/.../token</span>, then pass <span className="mono">?token=</span>.
                          </div>
                        </div>
                        <Toggle
                          on={!!sel.options?.["protected"]}
                          onChange={(v) => updateSelOptions({ protected: v })}
                        />
                      </label>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="empty">Select a field to configure its options.</div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ── Indexes section ────────────────────────────────────────────────────────
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

  const indexable = fields.filter((f) => !f.system && !f.implicit && f.type !== "autodate" && f.type !== "json" && f.type !== "file");

  return (
    <div className="editor-card">
      <div className="editor-card-head">
        <h3>Indexes</h3>
        <span className="meta">{indexes.length} index{indexes.length === 1 ? "" : "es"}</span>
        <button
          className="btn btn-ghost"
          style={{ marginLeft: "auto" }}
          onClick={() => setAdding(!adding)}
        >
          <Icon name={adding ? "x" : "plus"} size={12} />
          {adding ? "Cancel" : "Add index"}
        </button>
      </div>

      {adding && (
        <div style={{ padding: 12, borderBottom: "0.5px solid var(--border-default)", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
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
        </div>
      )}

      {loading ? (
        <div className="empty">Loading…</div>
      ) : indexes.length === 0 ? (
        <div className="empty">
          No indexes. Add one to speed up filter/sort queries on a field.
        </div>
      ) : (
        <div>
          {indexes.map((idx) => (
            <div
              key={idx.name}
              className="field-row-edit"
              style={{ padding: "10px 12px", display: "flex", alignItems: "center", gap: 10 }}
            >
              <Icon name="layers" size={12} style={{ color: "var(--text-muted)" }} />
              <span className="mono" style={{ fontSize: 12 }}>{idx.name}</span>
              <span className="muted mono" style={{ fontSize: 11 }}>on {idx.field}</span>
              {idx.unique && (
                <span className="badge auth" style={{ fontSize: 10 }}>UNIQUE</span>
              )}
              <button
                className="btn-icon danger"
                style={{ marginLeft: "auto" }}
                onClick={() => handleDelete(idx)}
                title="Drop index"
              >
                <Icon name="trash" size={12} />
              </button>
            </div>
          ))}
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
    <div ref={containerRef} className="field-type-picker">
      {!open ? (
        <button className="btn btn-ghost" onClick={() => setOpen(true)}>
          <Icon name="plus" size={12} /> New field
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
