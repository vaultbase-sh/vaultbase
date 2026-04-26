import { useEffect, useState } from "react";
import { Dropdown } from "primereact/dropdown";
import { Chips } from "primereact/chips";
import {
  api, type ApiResponse, type Collection, type FieldDef, collColor, parseFields,
} from "../api.ts";
import { Topbar } from "../components/Shell.tsx";
import type { Route } from "../components/Shell.tsx";
import { FieldTypeChip, Toggle } from "../components/UI.tsx";
import { RuleEditor } from "../components/RuleEditor.tsx";
import Icon from "../components/Icon.tsx";

const FIELD_TYPES: FieldDef["type"][] = [
  "text", "number", "bool", "email", "url", "date", "file", "relation", "select", "json", "autodate",
];

interface Rules {
  list: string; view: string; create: string; update: string; delete: string;
}

export default function CollectionEdit({
  setRoute,
  route,
  toast,
}: {
  setRoute: (r: Route) => void;
  route: Route;
  toast: (text: string, icon?: string) => void;
}) {
  const collId = route.coll ?? "";
  const [collection, setCollection] = useState<Collection | null>(null);
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [rules, setRules] = useState<Rules>({ list: "", view: "", create: "", update: "", delete: "" });
  const [saving, setSaving] = useState(false);
  const [allCollections, setAllCollections] = useState<Collection[]>([]);

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
    const userFields = fields.filter((f) => !f.system);
    const unnamed = userFields.filter((f) => !f.name);
    if (unnamed.length > 0) { toast("All fields must have a name."); return; }
    const badSelect = userFields.find(
      (f) => f.type === "select" && (!Array.isArray(f.options?.values) || (f.options?.values as string[]).length === 0)
    );
    if (badSelect) { toast(`Select field '${badSelect.name}' must have at least one allowed value`); return; }
    const badRelation = userFields.find((f) => f.type === "relation" && !f.collection);
    if (badRelation) { toast(`Relation field '${badRelation.name}' must have a target collection`); return; }
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
    setRoute({ page: "records", coll: collId });
  }

  async function handleDelete() {
    if (!collection || !confirm(`Delete collection "${collection.name}" and all its records? This cannot be undone.`)) return;
    await api.delete(`/api/collections/${collId}`);
    toast(`Collection deleted`, "trash");
    setRoute({ page: "collections" });
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
        onBack={() => setRoute({ page: "records", coll: collId })}
        actions={
          <>
            <button className="btn btn-ghost" onClick={() => setRoute({ page: "records", coll: collId })}>
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
            {/* Field list */}
            <div className="editor-card">
              <div className="editor-card-head">
                <h3>Schema fields</h3>
                <span className="meta">{fields.length} fields</span>
              </div>
              <div>
                {fields.map((f, i) => (
                  <div
                    key={i}
                    className={`field-row-edit${selectedIdx === i ? " selected" : ""}`}
                    onClick={() => setSelectedIdx(i)}
                  >
                    <span className="grip"><Icon name="grip" size={12} /></span>
                    {f.system ? (
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
                    {!f.system && (
                      <>
                        <Toggle
                          on={f.required ?? false}
                          onChange={(v) => setFields((fs) => fs.map((x, xi) => xi === i ? { ...x, required: v } : x))}
                        />
                        <button
                          className="btn-icon"
                          onClick={(e) => { e.stopPropagation(); removeField(i); }}
                        >
                          <Icon name="x" size={12} />
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
              <div className="add-field-bar">
                <span className="label-mini">Add field</span>
                {FIELD_TYPES.map((t) => (
                  <span className="add-chip" key={t} onClick={() => addField(t)}>
                    <Icon name="plus" size={10} />{t}
                  </span>
                ))}
              </div>
            </div>

            {/* API rules */}
            <div className="editor-card">
              <div className="editor-card-head">
                <h3>API rules</h3>
                <span className="meta">empty = admin only · null = public</span>
              </div>
              <div>
                {(["list", "view", "create", "update", "delete"] as const).map((r) => (
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

            <IndexesSection collectionName={collection.name} fields={fields} toast={toast} />
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
                      disabled={sel.system}
                    />
                    {sel.system && (
                      <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
                        System field — name is locked
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
                          onClick={() => !sel.system && updateSel({ type: t })}
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
                    </>
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
  toast,
}: {
  collectionName: string;
  fields: FieldDef[];
  toast: (text: string, icon?: string) => void;
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
    if (!confirm(`Drop index '${idx.name}'?`)) return;
    const res = await api.delete<ApiResponse<null>>(
      `/api/admin/collections/${collectionName}/indexes/${idx.name}`
    );
    if (res.error) { toast(res.error, "info"); return; }
    toast("Index dropped", "trash");
    load();
  }

  const indexable = fields.filter((f) => !f.system && f.type !== "autodate" && f.type !== "json" && f.type !== "file");

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
