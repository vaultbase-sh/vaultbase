import { useEffect, useRef, useState } from "react";
import {
  api, type ApiResponse, type Collection, type FieldDef, type ListResponse,
  type RecordRow, collColor, parseFields,
} from "../api.ts";
import { Topbar } from "../components/Shell.tsx";
import type { Route } from "../components/Shell.tsx";
import { Drawer, FieldTypeChip, Modal, Toggle } from "../components/UI.tsx";
import Icon from "../components/Icon.tsx";

// ── New Record Modal ────────────────────────────────────────────────────────
function NewRecordModal({
  open,
  onClose,
  fields,
  collectionName,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  fields: FieldDef[];
  collectionName: string;
  onCreated: () => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const editableFields = fields.filter(
    (f) => !f.system && f.type !== "autodate"
  );

  function setValue(name: string, val: unknown) {
    setValues((prev) => ({ ...prev, [name]: val }));
  }

  async function handleCreate() {
    setError("");
    setSaving(true);
    const res = await api.post<ApiResponse<RecordRow>>(
      `/api/${collectionName}`,
      values
    );
    setSaving(false);
    if (res.error) { setError(res.error); return; }
    setValues({});
    onCreated();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`New record · ${collectionName}`}
      width={520}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleCreate} disabled={saving}>
            <Icon name="check" size={12} />
            {saving ? "Creating…" : "Create record"}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        {error && (
          <div style={{ color: "var(--danger)", fontSize: 12, padding: "8px 12px", background: "rgba(248,113,113,0.1)", borderRadius: 6 }}>
            {error}
          </div>
        )}
        {editableFields.length === 0 ? (
          <div className="muted" style={{ fontSize: 12 }}>
            No user-defined fields. Add fields via the Schema editor first.
          </div>
        ) : (
          editableFields.map((f) => (
            <div className="field-row" key={f.name}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <span className="field-name">{f.name}</span>
                <div className="row" style={{ gap: 6 }}>
                  <FieldTypeChip type={f.type} />
                  {f.required && (
                    <span style={{ fontSize: 10, color: "var(--danger)" }}>required</span>
                  )}
                </div>
              </div>
              <FieldInput
                field={f}
                value={values[f.name]}
                onChange={(v) => setValue(f.name, v)}
              />
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}

// ── Shared field input renderer ──────────────────────────────────────────────
function FieldInput({
  field,
  value,
  onChange,
  readOnly,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  readOnly?: boolean;
}) {
  if (field.type === "bool") {
    return <Toggle on={!!value} onChange={onChange} />;
  }
  if (field.type === "file") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input className="input" value="—" disabled />
        <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
          File upload available in v2
        </span>
      </div>
    );
  }
  if (field.type === "select") {
    const opts = (field.options?.values as string[] | undefined) ?? [];
    if (opts.length > 0) {
      return (
        <select
          className="input"
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
          disabled={readOnly}
        >
          <option value="">— none —</option>
          {opts.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    }
  }
  if (field.type === "number") {
    return (
      <input
        className="input mono"
        type="number"
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.valueAsNumber)}
        readOnly={readOnly}
      />
    );
  }
  return (
    <input
      className={`input${["relation", "autodate"].includes(field.type) ? " mono" : ""}`}
      value={String(value ?? "")}
      onChange={(e) => onChange(e.target.value)}
      readOnly={readOnly}
    />
  );
}

// ── Main Records page ────────────────────────────────────────────────────────
export default function Records({
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
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("");
  const [appliedFilter, setAppliedFilter] = useState("");
  const [openRec, setOpenRec] = useState<RecordRow | null>(null);
  const [editData, setEditData] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);

  async function loadCollection() {
    const res = await api.get<ApiResponse<Collection>>(`/api/collections/${collId}`);
    if (res.data) setCollection(res.data);
  }

  async function loadRecords(p = 1, f = appliedFilter) {
    if (!collection) return;
    setLoading(true);
    const params = new URLSearchParams({ page: String(p), perPage: "30" });
    if (f) params.set("filter", f);
    const res = await api.get<ListResponse<RecordRow>>(
      `/api/${collection.name}?${params}`
    );
    if (res.data) { setRecords(res.data); setTotal(res.totalItems); }
    setLoading(false);
  }

  useEffect(() => { loadCollection(); }, [collId]);
  useEffect(() => { if (collection) loadRecords(page, appliedFilter); }, [collection, page, appliedFilter]);

  function openRecord(r: RecordRow) {
    setOpenRec(r);
    // seed edit data with current non-meta values
    const meta = new Set(["id", "collectionId", "collectionName", "created", "updated"]);
    const initial: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (!meta.has(k)) initial[k] = v;
    }
    setEditData(initial);
  }

  async function handleSave() {
    if (!collection || !openRec) return;
    setSaving(true);
    const res = await api.patch<ApiResponse<RecordRow>>(
      `/api/${collection.name}/${String(openRec.id)}`,
      editData
    );
    setSaving(false);
    if (res.error) { toast(res.error, "info"); return; }
    toast("Record saved");
    setOpenRec(null);
    loadRecords(page);
  }

  async function handleDelete(id: string) {
    if (!collection || !confirm("Delete this record?")) return;
    await api.delete(`/api/${collection.name}/${id}`);
    toast("Record deleted", "trash");
    setOpenRec(null);
    loadRecords(page);
  }

  function applyFilter() {
    setPage(1);
    setAppliedFilter(filter);
  }

  const allFields = collection ? parseFields(collection.fields) : [];
  const userFields = allFields.filter((f) => !f.system);
  const color = collColor(0);
  const displayCols = userFields.length > 0
    ? userFields.slice(0, 5).map((f) => f.name)
    : [];

  function cellValue(rec: RecordRow, col: string): string {
    const val = rec[col];
    if (val === null || val === undefined) return "—";
    if (typeof val === "boolean") return val ? "true" : "false";
    return String(val);
  }

  return (
    <>
      <Topbar
        title={
          collection ? (
            <span className="row" style={{ gap: 10 }}>
              <span className={`coll-icon ${color}`} style={{ width: 22, height: 22, fontSize: 11 }}>
                {collection.name[0]!.toUpperCase()}
              </span>
              <span className="mono" style={{ fontSize: 14 }}>{collection.name}</span>
            </span>
          ) : "Records"
        }
        subtitle={`${total.toLocaleString()} records`}
        onBack={() => setRoute({ page: "collections" })}
        actions={
          <>
            {collection && (
              <button
                className="btn btn-ghost"
                onClick={() => setRoute({ page: "collection-edit", coll: collId })}
              >
                <Icon name="pencil" size={12} /> Schema
              </button>
            )}
            <button
              className="btn btn-primary"
              onClick={() => setShowNew(true)}
              disabled={!collection}
            >
              <Icon name="plus" size={12} /> New record
            </button>
          </>
        }
      />
      <div className="app-body">
        <div className="filter-bar">
          <div
            className="input-group"
            style={{ flex: 1, maxWidth: 520 }}
            onKeyDown={(e) => e.key === "Enter" && applyFilter()}
          >
            <Icon name="search" size={13} />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter e.g. (title='hello') — press Enter to apply"
            />
            {appliedFilter && (
              <button
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 0 }}
                onClick={() => { setFilter(""); setAppliedFilter(""); setPage(1); }}
                title="Clear filter"
              >
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
          <div className="right">
            <button
              className="btn btn-ghost"
              disabled
              title="Sort available in v2"
              style={{ opacity: 0.4, cursor: "not-allowed" }}
            >
              <Icon name="sort" size={12} /> Sort
              <span style={{ fontSize: 10, marginLeft: 4, color: "var(--text-muted)" }}>v2</span>
            </button>
          </div>
        </div>

        <div className="table-wrap">
          {loading ? (
            <div className="empty">Loading…</div>
          ) : records.length === 0 ? (
            <div className="empty">
              {appliedFilter ? "No records match this filter." : "No records yet."}
            </div>
          ) : (
            <>
              <table className="table">
                <thead>
                  <tr>
                    <th>id</th>
                    {displayCols.map((c) => <th key={c}>{c}</th>)}
                    <th>created</th>
                    <th>updated</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r) => (
                    <tr
                      key={String(r.id)}
                      className={openRec?.id === r.id ? "selected" : ""}
                      onClick={() => openRecord(r)}
                    >
                      <td className="mono-cell muted">{String(r.id).slice(0, 12)}…</td>
                      {displayCols.map((c) => (
                        <td
                          key={c}
                          style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        >
                          {cellValue(r, c)}
                        </td>
                      ))}
                      <td className="muted mono-cell" style={{ fontSize: 11.5 }}>
                        {new Date((r.created as number) * 1000).toLocaleDateString()}
                      </td>
                      <td className="muted mono-cell" style={{ fontSize: 11.5 }}>
                        {new Date((r.updated as number) * 1000).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="pagination">
                <span>
                  {(page - 1) * 30 + 1}–{Math.min(page * 30, total)} of {total.toLocaleString()}
                </span>
                <div className="pages">
                  <button
                    className="btn-icon"
                    disabled={page === 1}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    <Icon name="chevronLeft" size={12} />
                  </button>
                  <button
                    className="btn-icon"
                    disabled={records.length < 30}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    <Icon name="chevronRight" size={12} />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Edit drawer */}
      <Drawer
        open={!!openRec}
        onClose={() => setOpenRec(null)}
        title="Edit record"
        idLabel={openRec ? String(openRec.id).slice(0, 16) : undefined}
        footer={
          <>
            <button
              className="btn btn-danger"
              onClick={() => openRec && handleDelete(String(openRec.id))}
            >
              <Icon name="trash" size={12} /> Delete
            </button>
            <span style={{ flex: 1 }} />
            <button className="btn btn-ghost" onClick={() => setOpenRec(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              <Icon name="check" size={12} />
              {saving ? "Saving…" : "Save"}
            </button>
          </>
        }
      >
        {openRec && (
          <div className="col" style={{ gap: 14 }}>
            {/* System read-only fields */}
            {(["id", "created", "updated"] as const).map((key) => {
              const raw = openRec[key];
              const display = key === "id"
                ? String(raw)
                : new Date((raw as number) * 1000).toISOString();
              return (
                <div className="field-row" key={key}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span className="field-name">{key}</span>
                    <FieldTypeChip type={key === "id" ? "text" : "autodate"} />
                  </div>
                  <input className="input mono" value={display} readOnly />
                </div>
              );
            })}
            <div className="divider" />
            {/* User fields */}
            {userFields.map((f) => (
              <div className="field-row" key={f.name}>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className="field-name">{f.name}</span>
                  <FieldTypeChip type={f.type} />
                </div>
                <FieldInput
                  field={f}
                  value={editData[f.name]}
                  onChange={(v) => setEditData((prev) => ({ ...prev, [f.name]: v }))}
                />
              </div>
            ))}
          </div>
        )}
      </Drawer>

      {/* New record modal */}
      {collection && (
        <NewRecordModal
          open={showNew}
          onClose={() => setShowNew(false)}
          fields={allFields}
          collectionName={collection.name}
          onCreated={() => { toast("Record created"); loadRecords(1); setPage(1); }}
        />
      )}
    </>
  );
}
