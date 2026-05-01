import { useEffect, useMemo, useRef, useState } from "react";
import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import type { DataTablePageEvent } from "primereact/datatable";
import { Dropdown } from "primereact/dropdown";
import { MultiSelect } from "primereact/multiselect";
import { Editor as QuillEditor } from "primereact/editor";
import {
  api, getMemoryToken, type ApiResponse, type Collection, type FieldDef, type ListResponse,
  type RecordRow, collColor, parseFields,
} from "../api.ts";
import { useNavigate, useParams } from "react-router-dom";
import { Topbar } from "../components/Shell.tsx";
import { Drawer, FieldTypeChip, Modal, Toggle } from "../components/UI.tsx";
import { confirm } from "../components/Confirm.tsx";
import { toast } from "../stores/toast.ts";
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
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const editableFields = fields.filter(
    (f) => !f.system && f.type !== "autodate"
  );
  const relationCache = useRelationCache(editableFields, open);

  function setValue(name: string, val: unknown) {
    setValues((prev) => ({ ...prev, [name]: val }));
    setFieldErrors((prev) => { const { [name]: _, ...rest } = prev; return rest; });
  }

  async function handleCreate() {
    setError(""); setFieldErrors({});
    setSaving(true);
    // Strip empty password fields on create — server treats undefined as null
    const passwordNames = new Set(fields.filter((f) => f.type === "password").map((f) => f.name));
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      if (passwordNames.has(k) && (v === "" || v === null || v === undefined)) continue;
      payload[k] = v;
    }
    const res = await api.post<ApiResponse<RecordRow>>(
      `/api/${collectionName}`,
      payload
    );
    setSaving(false);
    if (res.code === 422 && res.details) { setFieldErrors(res.details); setError(res.error ?? ""); return; }
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
                relationCache={relationCache}
              />
              {fieldErrors[f.name] && (
                <div style={{ fontSize: 11, color: "var(--danger)", marginTop: 2 }}>
                  {fieldErrors[f.name]}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}

// ── Relation cache helpers ───────────────────────────────────────────────────
type RelationOption = { label: string; value: string };
type RelationCache = Record<string, RelationOption[]>;

function recordLabel(r: RecordRow): string {
  // Prefer human-readable fields; fall back to id
  for (const k of ["name", "title", "email", "label", "slug"]) {
    if (typeof r[k] === "string" && r[k]) return `${r[k]} · ${String(r.id).slice(0, 8)}`;
  }
  return String(r.id);
}

function useRelationCache(fields: FieldDef[], enabled: boolean): RelationCache {
  const [cache, setCache] = useState<RelationCache>({});

  useEffect(() => {
    if (!enabled) return;
    const targets = new Set(
      fields
        .filter((f) => f.type === "relation" && f.collection)
        .map((f) => f.collection!)
    );
    for (const target of targets) {
      if (cache[target]) continue;
      api.get<ListResponse<RecordRow>>(`/api/${target}?perPage=200`).then((res) => {
        if (res.data) {
          const opts = res.data.map((r) => ({ value: String(r.id), label: recordLabel(r) }));
          setCache((prev) => ({ ...prev, [target]: opts }));
        }
      });
    }
  }, [enabled, fields]);

  return cache;
}

// ── File preview helpers ────────────────────────────────────────────────────

/**
 * In-memory cache of protected-file tokens keyed by filename. Tokens are
 * minted lazily via `POST /api/files/:collection/:recordId/:field/:filename/token`
 * and reused until they expire (~1h server-side). We refresh ~60s before
 * expiry to dodge edge-of-window failures.
 *
 * Module-level so multiple FileFieldPreview instances on the same page (e.g.
 * the records list cell + the open drawer) share one mint per filename.
 */
type FileToken = { token: string; expires_at: number };
const fileTokenCache = new Map<string, FileToken>();
const fileTokenInflight = new Map<string, Promise<FileToken | null>>();

async function mintFileToken(
  collectionName: string,
  recordId: string,
  field: string,
  filename: string,
): Promise<FileToken | null> {
  const now = Math.floor(Date.now() / 1000);
  const cached = fileTokenCache.get(filename);
  if (cached && cached.expires_at - 60 > now) return cached;
  const existing = fileTokenInflight.get(filename);
  if (existing) return existing;
  const p = (async () => {
    const res = await api.post<ApiResponse<FileToken>>(
      `/api/files/${collectionName}/${recordId}/${field}/${filename}/token`,
      {},
    );
    if (res.data) {
      fileTokenCache.set(filename, res.data);
      return res.data;
    }
    return null;
  })().finally(() => fileTokenInflight.delete(filename));
  fileTokenInflight.set(filename, p);
  return p;
}

function isProtectedFileField(field: FieldDef): boolean {
  return field.type === "file" && field.options?.["protected"] === true;
}

function filenamesFromValue(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string" && v.length > 0);
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

/** Heuristic: render as <img> if the extension looks like an image. */
function looksImage(filename: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(filename);
}

/**
 * Render a file value (single filename or array) as a small preview / download
 * link. For protected fields, lazily mints a token and appends `?token=` to
 * the URL. Tokens are cached per-filename (see `fileTokenCache` above) so this
 * stays cheap across re-renders.
 */
function FileFieldPreview({
  field,
  value,
  collectionName,
  recordId,
}: {
  field: FieldDef;
  value: unknown;
  collectionName: string;
  recordId: string;
}) {
  const filenames = useMemo(() => filenamesFromValue(value), [value]);
  const protectedField = isProtectedFileField(field);
  // Map of filename → token string (just the token, the URL is composed below)
  const [tokens, setTokens] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!protectedField || filenames.length === 0 || !recordId) return;
    let cancelled = false;
    (async () => {
      const next: Record<string, string> = {};
      for (const fn of filenames) {
        const t = await mintFileToken(collectionName, recordId, field.name, fn);
        if (t) next[fn] = t.token;
      }
      if (!cancelled && Object.keys(next).length > 0) {
        setTokens((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => { cancelled = true; };
  }, [protectedField, filenames.join("|"), collectionName, recordId, field.name]);

  if (filenames.length === 0) {
    return <span className="muted" style={{ fontSize: 11 }}>—</span>;
  }

  function urlFor(fn: string): string {
    const tok = tokens[fn];
    return tok ? `/api/files/${fn}?token=${encodeURIComponent(tok)}` : `/api/files/${fn}`;
  }

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      {filenames.map((fn) => {
        const url = urlFor(fn);
        const ready = !protectedField || !!tokens[fn];
        if (looksImage(fn)) {
          return ready ? (
            <a key={fn} href={url} target="_blank" rel="noreferrer" title={fn}>
              <img
                src={url}
                alt={fn}
                style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 4, border: "0.5px solid var(--border)" }}
              />
            </a>
          ) : (
            <span
              key={fn}
              title={fn}
              style={{ width: 36, height: 36, borderRadius: 4, border: "0.5px solid var(--border)", background: "rgba(255,255,255,0.04)" }}
            />
          );
        }
        return (
          <a
            key={fn}
            href={ready ? url : undefined}
            target="_blank"
            rel="noreferrer"
            className="mono"
            style={{ fontSize: 11, color: ready ? "var(--text-secondary)" : "var(--text-muted)" }}
            title={fn}
          >
            {fn.length > 20 ? `${fn.slice(0, 8)}…${fn.slice(-8)}` : fn}
          </a>
        );
      })}
    </div>
  );
}

// ── Shared field input renderer ──────────────────────────────────────────────
function FieldInput({
  field,
  value,
  onChange,
  readOnly,
  relationCache,
  collectionName,
  recordId,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  readOnly?: boolean;
  relationCache?: RelationCache;
  /** Required for file-field token issuance; omitted in the New Record modal. */
  collectionName?: string;
  recordId?: string;
}) {
  if (field.type === "bool") {
    return <Toggle on={!!value} onChange={onChange} />;
  }
  if (field.type === "file") {
    const filenames = filenamesFromValue(value);
    return (
      <div className="col" style={{ gap: 8 }}>
        {filenames.length > 0 && collectionName && recordId ? (
          <FileFieldPreview
            field={field}
            value={value}
            collectionName={collectionName}
            recordId={recordId}
          />
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input className="input" value="—" disabled />
            <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
              File upload available in v2
            </span>
          </div>
        )}
      </div>
    );
  }
  if (field.type === "relation") {
    const target = field.collection;
    const opts = target ? relationCache?.[target] : undefined;
    if (target && opts) {
      return (
        <Dropdown
          value={String(value ?? "")}
          options={opts}
          onChange={(e) => onChange(e.value)}
          disabled={readOnly}
          filter
          showClear
          placeholder={opts.length === 0 ? `No records in '${target}'` : "Select a record…"}
          emptyMessage={`No records in '${target}'`}
          style={{ width: "100%", height: 34 }}
          panelStyle={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
        />
      );
    }
    return (
      <input
        className="input mono"
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.value)}
        readOnly={readOnly}
        placeholder={target ? `Loading ${target}…` : "Set target collection in schema"}
      />
    );
  }
  if (field.type === "select") {
    const opts = (field.options?.values as string[] | undefined) ?? [];
    if (opts.length === 0) {
      return (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input className="input" value="" disabled placeholder="No values configured" />
          <span style={{ fontSize: 11, color: "var(--warning)", whiteSpace: "nowrap" }}>
            Set allowed values in schema
          </span>
        </div>
      );
    }
    if (field.options?.multiple) {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <MultiSelect
          value={selected}
          options={opts.map((o) => ({ label: o, value: o }))}
          onChange={(e) => onChange(e.value)}
          disabled={readOnly}
          display="chip"
          placeholder="Select values…"
          filter
          style={{ width: "100%", minHeight: 34 }}
          panelStyle={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
        />
      );
    }
    return (
      <Dropdown
        value={String(value ?? "")}
        options={[{ label: "— none —", value: "" }, ...opts.map((o) => ({ label: o, value: o }))]}
        onChange={(e) => onChange(e.value)}
        disabled={readOnly}
        style={{ width: "100%", height: 34 }}
      />
    );
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
  if (field.type === "password") {
    return (
      <input
        className="input mono"
        type="password"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
        readOnly={readOnly}
        placeholder="• • • • • • • •"
        autoComplete="new-password"
      />
    );
  }
  if (field.type === "editor") {
    return (
      <QuillEditor
        value={typeof value === "string" ? value : ""}
        onTextChange={(e) => onChange(e.htmlValue ?? "")}
        readOnly={readOnly}
        style={{ height: 220 }}
      />
    );
  }
  if (field.type === "geoPoint") {
    const v = (value && typeof value === "object" ? value : {}) as { lat?: number; lng?: number };
    return (
      <div className="row" style={{ gap: 8 }}>
        <input
          className="input mono"
          type="number"
          step="any"
          value={typeof v.lat === "number" ? String(v.lat) : ""}
          onChange={(e) => onChange({ lat: e.target.valueAsNumber, lng: v.lng ?? 0 })}
          readOnly={readOnly}
          placeholder="lat"
        />
        <input
          className="input mono"
          type="number"
          step="any"
          value={typeof v.lng === "number" ? String(v.lng) : ""}
          onChange={(e) => onChange({ lat: v.lat ?? 0, lng: e.target.valueAsNumber })}
          readOnly={readOnly}
          placeholder="lng"
        />
      </div>
    );
  }
  return (
    <input
      className={`input${["autodate"].includes(field.type) ? " mono" : ""}`}
      value={String(value ?? "")}
      onChange={(e) => onChange(e.target.value)}
      readOnly={readOnly}
    />
  );
}

// ── Main Records page ────────────────────────────────────────────────────────
export default function Records() {
  const params = useParams();
  const navigate = useNavigate();
  const collId = params["id"] ?? "";
  const [collection, setCollection] = useState<Collection | null>(null);
  const [records, setRecords] = useState<RecordRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState("");
  const [appliedFilter, setAppliedFilter] = useState("");
  const [sort, setSort] = useState("-created");
  const [openRec, setOpenRec] = useState<RecordRow | null>(null);
  const [editData, setEditData] = useState<Record<string, unknown>>({});
  const [editErrors, setEditErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [selected, setSelected] = useState<RecordRow[]>([]);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  async function loadCollection() {
    const res = await api.get<ApiResponse<Collection>>(`/api/collections/${collId}`);
    if (res.data) setCollection(res.data);
  }

  async function loadRecords(p = 1, f = appliedFilter) {
    if (!collection) return;
    setLoading(true);
    const params = new URLSearchParams({ page: String(p), perPage: "30" });
    if (collection.type !== "auth") {
      params.set("sort", sort);
      if (f) params.set("filter", f);
    }
    const url = collection.type === "auth"
      ? `/api/admin/users/${collection.name}?${params}`
      : `/api/${collection.name}?${params}`;
    const res = await api.get<ListResponse<RecordRow>>(url);
    if (res.data) { setRecords(res.data); setTotal(res.totalItems); }
    setLoading(false);
  }

  useEffect(() => { loadCollection(); }, [collId]);
  useEffect(() => { if (collection) loadRecords(page, appliedFilter); }, [collection, page, appliedFilter, sort]);
  // Clear selection on navigation events; row references would otherwise be stale.
  useEffect(() => { setSelected([]); }, [collId, page, appliedFilter, sort]);

  function openRecord(r: RecordRow) {
    setOpenRec(r);
    // seed edit data with current non-meta values
    const meta = new Set(["id", "collectionId", "collectionName", "created", "updated"]);
    const initial: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) {
      if (!meta.has(k)) initial[k] = v;
    }
    setEditData(initial);
    setEditErrors({});
  }

  async function handleSave() {
    if (!collection || !openRec) return;
    setEditErrors({});
    setSaving(true);

    if (collection.type === "auth") {
      // Auth-user updates go through the admin users endpoint. Email + verified
      // are top-level columns; everything else is shoved into the `data` blob.
      const payload: Record<string, unknown> = {};
      const dataObj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(editData)) {
        if (k === "email") payload["email"] = v;
        else if (k === "verified") payload["verified"] = !!v;
        else dataObj[k] = v;
      }
      if (Object.keys(dataObj).length > 0) payload["data"] = dataObj;
      const res = await api.patch<ApiResponse<RecordRow>>(
        `/api/admin/users/${collection.name}/${String(openRec.id)}`,
        payload
      );
      setSaving(false);
      if (res.code === 422 && res.details) { setEditErrors(res.details); toast("Validation failed", "info"); return; }
      if (res.error) { toast(res.error, "info"); return; }
      toast("User saved");
      setOpenRec(null);
      loadRecords(page);
      return;
    }

    // Strip empty password fields so we don't blank existing hashes on no-op edits
    const fields = parseFields(collection.fields);
    const passwordNames = new Set(fields.filter((f) => f.type === "password").map((f) => f.name));
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(editData)) {
      if (passwordNames.has(k) && (v === "" || v === null || v === undefined)) continue;
      payload[k] = v;
    }
    const res = await api.patch<ApiResponse<RecordRow>>(
      `/api/${collection.name}/${String(openRec.id)}`,
      payload
    );
    setSaving(false);
    if (res.code === 422 && res.details) { setEditErrors(res.details); toast("Validation failed", "info"); return; }
    if (res.error) { toast(res.error, "info"); return; }
    toast("Record saved");
    setOpenRec(null);
    loadRecords(page);
  }

  async function handleDelete(id: string) {
    if (!collection) return;
    const isAuth = collection.type === "auth";
    const ok = await confirm({
      title: isAuth ? "Delete user" : "Delete record",
      message: isAuth
        ? `Delete this user from "${collection.name}"?\n\nID: ${id}\n\nThis cannot be undone.`
        : `Delete this record from "${collection.name}"?\n\nID: ${id}\n\nThis cannot be undone.`,
      danger: true,
    });
    if (!ok) return;
    const url = isAuth
      ? `/api/admin/users/${collection.name}/${id}`
      : `/api/${collection.name}/${id}`;
    await api.delete(url);
    toast(isAuth ? "User deleted" : "Record deleted", "trash");
    setOpenRec(null);
    loadRecords(page);
  }

  async function handleBulkDelete() {
    if (!collection || selected.length === 0) return;
    const isAuth = collection.type === "auth";
    const ok = await confirm({
      title: isAuth ? "Delete users" : "Delete records",
      message: `Delete ${selected.length} ${isAuth ? "user" : "record"}${selected.length === 1 ? "" : "s"} from "${collection.name}"?\n\nThis cannot be undone.`,
      danger: true,
      confirmLabel: `Delete ${selected.length}`,
    });
    if (!ok) return;
    setBulkDeleting(true);
    const ids = selected.map((r) => String(r.id));
    let failed = 0;

    if (isAuth) {
      // No batch API for auth users — sequential per-id deletes.
      for (const id of ids) {
        const res = await api.delete<ApiResponse<null>>(`/api/admin/users/${collection.name}/${id}`);
        if (res.error) failed++;
      }
    } else {
      // Use the atomic batch API in chunks of 100 (server cap).
      const CHUNK = 100;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const res = await api.post<{ data?: unknown[]; error?: string; code?: number }>(
          "/api/batch",
          {
            requests: slice.map((id) => ({
              method: "DELETE",
              url: `/api/${collection.name}/${id}`,
            })),
          }
        );
        if (res.error) failed += slice.length; // batches are atomic — all-or-nothing per chunk
      }
    }

    setBulkDeleting(false);
    setSelected([]);
    if (failed === 0) {
      toast(`Deleted ${ids.length} ${isAuth ? "user" : "record"}${ids.length === 1 ? "" : "s"}`, "trash");
    } else if (failed === ids.length) {
      toast(`Bulk delete failed`, "info");
    } else {
      toast(`Deleted ${ids.length - failed} of ${ids.length}; ${failed} failed`, "info");
    }
    loadRecords(page);
  }

  function applyFilter() {
    setPage(1);
    setAppliedFilter(filter);
  }

  function handleExport() {
    if (!collection) return;
    const token = getMemoryToken();
    fetch(`/api/admin/export/${collection.name}`, {
      credentials: "same-origin",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => {
        if (!r.ok) throw new Error(`Failed: ${r.status}`);
        return r.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${collection.name}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        toast(`Exported ${collection.name}.csv`, "download");
      })
      .catch((e) => toast(`Export failed: ${e instanceof Error ? e.message : String(e)}`, "info"));
  }

  function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !collection) return;
    file.text().then(async (text) => {
      const token = getMemoryToken();
      const headers: Record<string, string> = { "Content-Type": "text/csv" };
      if (token) headers.Authorization = `Bearer ${token}`;
      const res = await fetch(`/api/admin/import/${collection.name}`, {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: text,
      });
      const j = (await res.json()) as { data?: { created: number; failed: number; total: number; errors: unknown[] }; error?: string };
      if (j.error) { toast(`Import failed: ${j.error}`, "info"); return; }
      const d = j.data!;
      if (d.failed === 0) {
        toast(`Imported ${d.created} of ${d.total} rows`, "check");
      } else {
        toast(`Imported ${d.created}, ${d.failed} failed (see console)`, "info");
        console.warn(`Import errors for ${collection.name}:`, d.errors);
      }
      loadRecords(page);
    });
  }

  async function handleImpersonate(id: string) {
    if (!collection) return;
    const res = await api.post<ApiResponse<{ token: string; record: { id: string; email: string } }>>(
      `/api/admin/impersonate/${collection.name}/${id}`,
      {}
    );
    if (res.error) { toast(res.error, "info"); return; }
    if (!res.data?.token) { toast("No token returned", "info"); return; }
    try {
      await navigator.clipboard.writeText(res.data.token);
      toast("Impersonation token copied to clipboard (1h expiry)", "check");
    } catch {
      toast("Token issued — paste from console", "check");
      console.log("Impersonation token:", res.data.token);
    }
  }

  async function handleDisableMfa(id: string) {
    if (!collection) return;
    const ok = await confirm({
      title: "Disable MFA",
      message: "Reset this user's MFA? They'll be able to sign in with just their password until they re-enroll.",
      danger: true,
      confirmLabel: "Disable MFA",
    });
    if (!ok) return;
    const res = await api.patch<ApiResponse<RecordRow>>(
      `/api/admin/users/${collection.name}/${id}`,
      { mfa_enabled: false }
    );
    if (res.error) { toast(res.error, "info"); return; }
    toast("MFA disabled");
    loadRecords(page);
    setOpenRec(null);
  }

  const allFields = collection ? parseFields(collection.fields) : [];
  const userFields = allFields.filter((f) => !f.system);
  const editRelationCache = useRelationCache(userFields, !!openRec);
  const color = collColor(0);
  const displayCols = userFields.length > 0
    ? userFields.slice(0, 5).map((f) => f.name)
    : [];
  // Look up by column name so the table cell renderer can branch on type.
  const fieldsByName = new Map<string, FieldDef>(userFields.map((f) => [f.name, f]));

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
        onBack={() => navigate("/_/collections")}
        actions={
          <>
            {collection && (
              <button
                className="btn btn-ghost"
                onClick={() => navigate(`/_/collections/${collId}/edit`)}
              >
                <Icon name="pencil" size={12} /> Schema
              </button>
            )}
            {collection?.type === "base" && (
              <>
                <button
                  className="btn btn-ghost"
                  onClick={handleExport}
                  title="Download all records as CSV"
                >
                  <Icon name="download" size={12} /> Export
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => importInputRef.current?.click()}
                  title="Upload a CSV to bulk-create records"
                >
                  <Icon name="upload" size={12} /> Import
                </button>
                <input
                  ref={importInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  style={{ display: "none" }}
                  onChange={handleImport}
                />
              </>
            )}
            <button
              className="btn btn-primary"
              onClick={() => setShowNew(true)}
              disabled={!collection || collection.type === "auth" || collection.type === "view"}
              title={
                collection?.type === "auth" ? "Users register via POST /api/auth/<collection>/register"
                : collection?.type === "view" ? "View collections are read-only"
                : undefined
              }
            >
              <Icon name="plus" size={12} /> {
                collection?.type === "auth" ? "New user"
                : collection?.type === "view" ? "Read-only"
                : "New record"
              }
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
            <Dropdown
              value={sort}
              options={[
                { label: "Created ↓", value: "-created" },
                { label: "Created ↑", value: "created" },
                { label: "Updated ↓", value: "-updated" },
                { label: "Updated ↑", value: "updated" },
                { label: "ID ↓", value: "-id" },
                { label: "ID ↑", value: "id" },
              ]}
              onChange={(e) => { setSort(e.value); setPage(1); }}
              style={{ height: 30, minWidth: 130, fontSize: 12 }}
            />
          </div>
        </div>

        {selected.length > 0 && (
          <div className="bulk-bar">
            <span className="count">
              <span className="num">{selected.length}</span> selected
            </span>
            {collection?.type === "base" && (
              <button className="btn btn-ghost" onClick={handleExport} disabled={bulkDeleting}>
                <Icon name="download" size={11} /> Export
              </button>
            )}
            <button className="btn btn-ghost" onClick={() => setSelected([])} disabled={bulkDeleting}>
              Clear
            </button>
            <button
              className="btn btn-danger"
              onClick={handleBulkDelete}
              disabled={bulkDeleting || collection?.type === "view"}
            >
              <Icon name="trash" size={11} />
              {bulkDeleting ? "Deleting…" : `Delete · ${selected.length}`}
            </button>
            <span className="meta">{total.toLocaleString()} total</span>
          </div>
        )}

        <DataTable
          value={records}
          lazy
          paginator
          rows={30}
          totalRecords={total}
          first={(page - 1) * 30}
          onPage={(e: DataTablePageEvent) => setPage(Math.floor(e.first / 30) + 1)}
          loading={loading}
          onRowClick={(e) => openRecord(e.data as RecordRow)}
          // Selection drives off the checkbox column only (selectionMode="checkbox"
          // on the DataTable means row clicks open the drawer; ticking the
          // checkbox manages bulk selection independently).
          selection={(collection?.type === "view" ? null : selected) as never}
          onSelectionChange={((e: { value: RecordRow[] }) => setSelected(e.value)) as never}
          selectionMode={collection?.type === "view" ? null : "checkbox"}
          dataKey="id"
          emptyMessage={appliedFilter ? "No records match this filter." : "No records yet."}
          style={{ fontSize: 13 }}
        >
          {collection?.type !== "view" && (
            <Column
              selectionMode="multiple"
              headerStyle={{ width: "3rem" }}
              bodyStyle={{ width: "3rem" }}
            />
          )}
          <Column
            field="id"
            header="id"
            body={(r: RecordRow) => (
              <span className="mono-cell muted">{String(r.id).slice(0, 12)}…</span>
            )}
          />
          {displayCols.map((c) => {
            const fdef = fieldsByName.get(c);
            const isFile = fdef?.type === "file";
            return (
              <Column
                key={c}
                field={c}
                header={c}
                body={(r: RecordRow) => {
                  if (isFile && collection && fdef) {
                    return (
                      <FileFieldPreview
                        field={fdef}
                        value={r[c]}
                        collectionName={collection.name}
                        recordId={String(r.id)}
                      />
                    );
                  }
                  return (
                    <span style={{ display: "block", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {cellValue(r, c)}
                    </span>
                  );
                }}
              />
            );
          })}
          {collection?.type === "auth" && (
            <Column
              field="status"
              header="status"
              body={(r: RecordRow) => (
                <span style={{ display: "inline-flex", gap: 4 }}>
                  {r["mfa_enabled"] === true && (
                    <span title="MFA enabled" style={{ fontSize: 10, padding: "1px 6px", borderRadius: 8, background: "rgba(74,222,128,0.15)", color: "var(--success)" }}>MFA</span>
                  )}
                  {r["anonymous"] === true && (
                    <span title="Anonymous user" style={{ fontSize: 10, padding: "1px 6px", borderRadius: 8, background: "rgba(255,255,255,0.07)", color: "var(--text-muted)" }}>anon</span>
                  )}
                </span>
              )}
            />
          )}
          <Column
            field="created"
            header="created"
            body={(r: RecordRow) => (
              <span className="muted mono-cell" style={{ fontSize: 11.5 }}>
                {new Date((r.created as number) * 1000).toLocaleDateString()}
              </span>
            )}
          />
          <Column
            field="updated"
            header="updated"
            body={(r: RecordRow) => (
              <span className="muted mono-cell" style={{ fontSize: 11.5 }}>
                {new Date((r.updated as number) * 1000).toLocaleDateString()}
              </span>
            )}
          />
        </DataTable>
      </div>

      {/* Edit drawer */}
      <Drawer
        open={!!openRec}
        onClose={() => setOpenRec(null)}
        title={collection?.type === "view" ? "View record (read-only)" : "Edit record"}
        idLabel={openRec ? String(openRec.id).slice(0, 16) : undefined}
        footer={
          collection?.type === "view" ? (
            <button className="btn btn-ghost" onClick={() => setOpenRec(null)} style={{ marginLeft: "auto" }}>Close</button>
          ) : (
            <>
              <button
                className="btn btn-danger"
                onClick={() => openRec && handleDelete(String(openRec.id))}
              >
                <Icon name="trash" size={12} /> Delete
              </button>
              {collection?.type === "auth" && openRec && (
                <>
                  {openRec["mfa_enabled"] === true && (
                    <button
                      className="btn btn-ghost"
                      onClick={() => handleDisableMfa(String(openRec.id))}
                      title="Reset MFA — user signs in with password only until they re-enroll"
                    >
                      <Icon name="key" size={12} /> Disable MFA
                    </button>
                  )}
                  <button
                    className="btn btn-ghost"
                    onClick={() => handleImpersonate(String(openRec.id))}
                    title="Mint a 1h user JWT for support purposes (audited)"
                  >
                    <Icon name="users" size={12} /> Impersonate
                  </button>
                </>
              )}
              <span style={{ flex: 1 }} />
              <button className="btn btn-ghost" onClick={() => setOpenRec(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                <Icon name="check" size={12} />
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          )
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
                  onChange={(v) => {
                    setEditData((prev) => ({ ...prev, [f.name]: v }));
                    setEditErrors((prev) => { const { [f.name]: _, ...rest } = prev; return rest; });
                  }}
                  relationCache={editRelationCache}
                  readOnly={collection?.type === "view"}
                  collectionName={collection?.name}
                  recordId={String(openRec.id)}
                />
                {editErrors[f.name] && (
                  <div style={{ fontSize: 11, color: "var(--danger)", marginTop: 2 }}>
                    {editErrors[f.name]}
                  </div>
                )}
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
