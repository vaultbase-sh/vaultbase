import { useEffect, useMemo, useRef, useState } from "react";
import { Dropdown } from "primereact/dropdown";
import { MultiSelect } from "primereact/multiselect";
import { Editor as QuillEditor } from "primereact/editor";
import {
  api, getMemoryToken, type ApiResponse, type Collection, type FieldDef, type ListResponse,
  type RecordRow, collColor, parseFields,
} from "../api.ts";
import { useNavigate, useParams } from "react-router-dom";
import { Drawer, FieldTypeChip, Modal, Toggle } from "../components/UI.tsx";
import { confirm } from "../components/Confirm.tsx";
import { toast } from "../stores/toast.ts";
import Icon from "../components/Icon.tsx";
import {
  CollectionAvatar,
  TypePill,
  VbBtn,
  VbEmptyState,
  VbInput,
  VbSubHeader,
  VbTable,
  VbTabs,
  type VbTab,
  type VbTableColumn,
} from "../components/Vb.tsx";

// ── GeoPoint map picker (Leaflet + OpenStreetMap) ──────────────────────────
//
// Lazy-loads Leaflet so the bundle's first-page payload doesn't carry it for
// pages that never see geoPoint fields. CSS is shipped at boot via
// `main.tsx` so the imported library renders correctly the first time.
//
// Controls:
//   - Click anywhere on the map → place marker + emit (lat, lng)
//   - Drag the marker → emit (lat, lng) on dragend
//   - External lat/lng prop change → re-position marker, recenter on big jump

function GeoPointMap({
  lat, lng, onChange, readOnly,
}: {
  lat?: number;
  lng?: number;
  onChange: (lat: number, lng: number) => void;
  readOnly?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Use `any` here so we don't hard-import the Leaflet types at top-level
  // — the lazy `import()` keeps the actual module out of the entry chunk.
  const mapRef = useRef<unknown>(null);
  const markerRef = useRef<unknown>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;
    let cancelled = false;
    let cleanupFn: (() => void) | null = null;

    void (async () => {
      const [L, iconUrl, iconRetinaUrl, shadowUrl] = await Promise.all([
        import("leaflet"),
        import("leaflet/dist/images/marker-icon.png?url"),
        import("leaflet/dist/images/marker-icon-2x.png?url"),
        import("leaflet/dist/images/marker-shadow.png?url"),
      ]);
      if (cancelled || !containerRef.current) return;

      // Vite mangles Leaflet's relative URLs to its default-marker sprite.
      // Bundle the icons via ?url imports so they ship from the same origin
      // and don't require relaxing the img-src CSP for unpkg.
      const Icon = L.Icon as unknown as { Default: { mergeOptions: (o: Record<string, string>) => void } };
      Icon.Default.mergeOptions({
        iconUrl:       iconUrl.default,
        iconRetinaUrl: iconRetinaUrl.default,
        shadowUrl:     shadowUrl.default,
      });

      const hasCoords = typeof lat === "number" && typeof lng === "number";
      const initLat = hasCoords ? lat! : 0;
      const initLng = hasCoords ? lng! : 0;
      const initZoom = hasCoords ? 13 : 2;

      const map = L.map(containerRef.current).setView([initLat, initLng], initZoom);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);

      const marker = L.marker([initLat, initLng], { draggable: !readOnly }).addTo(map);
      mapRef.current = map;
      markerRef.current = marker;

      if (!readOnly) {
        map.on("click", (e: { latlng: { lat: number; lng: number } }) => {
          marker.setLatLng(e.latlng);
          onChangeRef.current(e.latlng.lat, e.latlng.lng);
        });
        marker.on("dragend", () => {
          const ll = marker.getLatLng();
          onChangeRef.current(ll.lat, ll.lng);
        });
      }

      cleanupFn = () => { map.remove(); };
    })();

    return () => {
      cancelled = true;
      if (cleanupFn) cleanupFn();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  // External lat/lng change → reposition + recenter if jumping far.
  useEffect(() => {
    const m = markerRef.current as { setLatLng: (ll: [number, number]) => void } | null;
    const map = mapRef.current as { setView: (ll: [number, number], z: number) => void; getZoom: () => number } | null;
    if (!m || !map) return;
    if (typeof lat !== "number" || typeof lng !== "number") return;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    m.setLatLng([lat, lng]);
    if (map.getZoom() < 5) map.setView([lat, lng], 13);
  }, [lat, lng]);

  return (
    <div
      ref={containerRef}
      style={{
        height: 240,
        borderRadius: 6,
        border: "1px solid var(--border-default)",
        overflow: "hidden",
        background: "var(--bg-input)",
      }}
    />
  );
}

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
      `/api/v1/${collectionName}`,
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
      api.get<ListResponse<RecordRow>>(`/api/v1/${target}?perPage=200`).then((res) => {
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
 * minted lazily via `POST /api/v1/files/:collection/:recordId/:field/:filename/token`
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
      `/api/v1/files/${collectionName}/${recordId}/${field}/${filename}/token`,
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
    return tok ? `/api/v1/files/${fn}?token=${encodeURIComponent(tok)}` : `/api/v1/files/${fn}`;
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
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filenames.length > 0 && collectionName && recordId ? (
          <FileFieldPreview
            field={field}
            value={value}
            collectionName={collectionName}
            recordId={recordId}
          />
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <VbInput value="—" disabled style={{ flex: 1 }} />
            <span style={{ fontSize: 11, color: "var(--vb-fg-3)", whiteSpace: "nowrap" }}>
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
          style={{ width: "100%", height: 32 }}
          panelStyle={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
        />
      );
    }
    return (
      <VbInput
        mono
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
          <VbInput value="" disabled placeholder="No values configured" style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: "var(--vb-status-warning)", whiteSpace: "nowrap" }}>
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
          style={{ width: "100%", minHeight: 32 }}
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
        style={{ width: "100%", height: 32 }}
      />
    );
  }
  if (field.type === "number") {
    return (
      <VbInput
        mono
        type="number"
        value={String(value ?? "")}
        onChange={(e) => onChange(e.target.valueAsNumber)}
        readOnly={readOnly}
      />
    );
  }
  if (field.type === "password") {
    return (
      <PasswordInput
        value={typeof value === "string" ? value : ""}
        onChange={(v) => onChange(v)}
        readOnly={readOnly}
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
    const setLat = (lat: number) => onChange({ lat, lng: v.lng ?? 0 });
    const setLng = (lng: number) => onChange({ lat: v.lat ?? 0, lng });
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <VbInput
            mono type="number" step="any" placeholder="lat"
            value={typeof v.lat === "number" ? String(v.lat) : ""}
            onChange={(e) => setLat(e.target.valueAsNumber)}
            readOnly={readOnly}
          />
          <VbInput
            mono type="number" step="any" placeholder="lng"
            value={typeof v.lng === "number" ? String(v.lng) : ""}
            onChange={(e) => setLng(e.target.valueAsNumber)}
            readOnly={readOnly}
          />
        </div>
        <GeoPointMap
          lat={typeof v.lat === "number" && Number.isFinite(v.lat) ? v.lat : undefined}
          lng={typeof v.lng === "number" && Number.isFinite(v.lng) ? v.lng : undefined}
          readOnly={readOnly}
          onChange={(lat, lng) => onChange({ lat, lng })}
        />
      </div>
    );
  }
  return (
    <VbInput
      mono={["autodate"].includes(field.type)}
      value={String(value ?? "")}
      onChange={(e) => onChange(e.target.value)}
      readOnly={readOnly}
    />
  );
}

const DrawerFieldRow: React.FC<{
  name: string;
  type: string;
  required?: boolean;
  children: React.ReactNode;
}> = ({ name, type, required, children }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
    <div style={{
      display: "flex",
      alignItems: "baseline",
      justifyContent: "space-between",
      gap: 12,
    }}>
      <span style={{
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: 1.2,
        textTransform: "uppercase",
        color: "var(--vb-fg-2)",
        fontFamily: "var(--font-mono)",
      }}>
        {name}
        {required && (
          <span style={{ color: "var(--vb-status-danger)", marginLeft: 4 }}>*</span>
        )}
      </span>
      <FieldTypeChip type={type} />
    </div>
    {children}
  </div>
);

const PasswordInput: React.FC<{
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
}> = ({ value, onChange, readOnly }) => {
  const [show, setShow] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <VbInput
        mono
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        readOnly={readOnly}
        placeholder="• • • • • • • •  (leave blank to keep)"
        autoComplete="new-password"
        style={{ paddingRight: 32 }}
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        disabled={!value}
        style={{
          position: "absolute",
          right: 6,
          top: "50%",
          transform: "translateY(-50%)",
          background: "transparent",
          border: 0,
          color: "var(--vb-fg-3)",
          cursor: value ? "pointer" : "default",
          padding: 4,
        }}
        title={show ? "Hide" : "Show"}
      >
        <Icon name="eye" size={13} />
      </button>
    </div>
  );
};

// ── Column builder for the VbTable ───────────────────────────────────────────

function recordColumns(
  collection: Collection | null,
  displayCols: string[],
  fieldsByName: Map<string, FieldDef>,
  cellValue: (rec: RecordRow, col: string) => string,
): VbTableColumn<RecordRow>[] {
  const cols: VbTableColumn<RecordRow>[] = [];

  cols.push({
    key: "id",
    label: "id",
    width: 140,
    mono: true,
    render: (r) => (
      <span style={{ color: "var(--vb-fg-3)" }}>{String(r.id).slice(0, 12)}…</span>
    ),
  });

  for (const c of displayCols) {
    const fdef = fieldsByName.get(c);
    const isFile = fdef?.type === "file";
    const isGeo = fdef?.type === "geoPoint";
    cols.push({
      key: c,
      label: c,
      flex: 1,
      mono: false,
      render: (r) => {
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
        if (isGeo) {
          const text = cellValue(r, c);
          if (text === "—") return <span style={{ color: "var(--vb-fg-3)" }}>—</span>;
          return (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "#62cc9c", fontFamily: "var(--font-mono)" }}>
              <Icon name="mapPin" size={11} />
              {text}
            </span>
          );
        }
        const text = cellValue(r, c);
        if (text === "—") return <span style={{ color: "var(--vb-fg-3)" }}>—</span>;
        return text;
      },
    });
  }

  if (collection?.type === "auth") {
    cols.push({
      key: "status",
      label: "status",
      width: 100,
      render: (r) => (
        <span style={{ display: "inline-flex", gap: 4 }}>
          {r["mfa_enabled"] === true && (
            <span title="MFA enabled" style={{
              fontSize: 10, padding: "1px 6px", borderRadius: 8,
              background: "var(--vb-status-success-bg)", color: "var(--vb-status-success)",
              fontFamily: "var(--font-mono)",
            }}>MFA</span>
          )}
          {r["anonymous"] === true && (
            <span title="Anonymous user" style={{
              fontSize: 10, padding: "1px 6px", borderRadius: 8,
              background: "var(--vb-bg-3)", color: "var(--vb-fg-3)",
              fontFamily: "var(--font-mono)",
            }}>anon</span>
          )}
        </span>
      ),
    });
  }

  cols.push({
    key: "created",
    label: "created",
    width: 110,
    mono: true,
    sortable: true,
    render: (r) => (
      <span style={{ color: "var(--vb-fg-3)", fontSize: 11.5 }}>
        {new Date((r.created as number) * 1000).toLocaleDateString()}
      </span>
    ),
  });

  cols.push({
    key: "updated",
    label: "updated",
    width: 110,
    mono: true,
    sortable: true,
    render: (r) => (
      <span style={{ color: "var(--vb-fg-3)", fontSize: 11.5 }}>
        {new Date((r.updated as number) * 1000).toLocaleDateString()}
      </span>
    ),
  });

  return cols;
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
    const res = await api.get<ApiResponse<Collection>>(`/api/v1/collections/${collId}`);
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
      ? `/api/v1/admin/users/${collection.name}?${params}`
      : `/api/v1/${collection.name}?${params}`;
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
        `/api/v1/admin/users/${collection.name}/${String(openRec.id)}`,
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
      `/api/v1/${collection.name}/${String(openRec.id)}`,
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
      ? `/api/v1/admin/users/${collection.name}/${id}`
      : `/api/v1/${collection.name}/${id}`;
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
        const res = await api.delete<ApiResponse<null>>(`/api/v1/admin/users/${collection.name}/${id}`);
        if (res.error) failed++;
      }
    } else {
      // Use the atomic batch API in chunks of 100 (server cap).
      const CHUNK = 100;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const res = await api.post<{ data?: unknown[]; error?: string; code?: number }>(
          "/api/v1/batch",
          {
            requests: slice.map((id) => ({
              method: "DELETE",
              url: `/api/v1/${collection.name}/${id}`,
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

  function applyFilter(override?: string) {
    setPage(1);
    if (override !== undefined) {
      setFilter(override);
      setAppliedFilter(override);
    } else {
      setAppliedFilter(filter);
    }
  }

  function handleExport() {
    if (!collection) return;
    const token = getMemoryToken();
    fetch(`/api/v1/admin/export/${collection.name}`, {
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
      const res = await fetch(`/api/v1/admin/import/${collection.name}`, {
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
      `/api/v1/admin/impersonate/${collection.name}/${id}`,
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
      `/api/v1/admin/users/${collection.name}/${id}`,
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
    const f = fieldsByName.get(col);
    if (f?.type === "geoPoint" && val && typeof val === "object") {
      const o = val as { lat?: unknown; lng?: unknown };
      if (typeof o.lat === "number" && typeof o.lng === "number" &&
          Number.isFinite(o.lat) && Number.isFinite(o.lng)) {
        return `${o.lat.toFixed(4)}, ${o.lng.toFixed(4)}`;
      }
      return "—";
    }
    return String(val);
  }

  // Sub-tab navigation: clicking Schema/Rules/Indexes jumps into CollectionEdit.
  // (CollectionEdit's internal tab state defaults to Fields; param-syncing the
  // exact tab is a small follow-up — for now the navigation is intent-correct.)
  const subTabs: VbTab<"records" | "schema" | "rules" | "indexes">[] = [
    { id: "records",  label: "Records",   icon: "stack", count: total > 0 ? total : 0 },
    { id: "schema",   label: "Schema",    icon: "settings" },
    { id: "rules",    label: "API rules", icon: "shield" },
    { id: "indexes",  label: "Indexes",   icon: "zap" },
  ];
  const onSubTab = (id: typeof subTabs[number]["id"]) => {
    if (id === "records") return;
    if (id === "rules" || id === "indexes" || id === "schema") {
      navigate(`/_/collections/${collId}/edit`);
    }
  };

  const recordCount = collection ? `${total.toLocaleString()} records` : "—";
  const newBtnLabel = collection?.type === "auth" ? "New user"
    : collection?.type === "view" ? "Read-only"
    : "New record";
  const newBtnTitle = collection?.type === "auth"
    ? "Users register via POST /api/v1/auth/<collection>/register"
    : collection?.type === "view" ? "View collections are read-only"
    : undefined;

  return (
    <>
      <VbSubHeader
        onBack={() => navigate("/_/collections")}
        crumbs={[
          <span key="c" style={{ color: "var(--vb-fg-3)" }}>Collections</span>,
          collection ? (
            <span key="n" style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
              <CollectionAvatar letter={collection.name[0] ?? "?"} />
              <span style={{ display: "inline-flex", flexDirection: "column", lineHeight: 1.1 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: "var(--vb-fg)", fontFamily: "var(--font-mono)" }}>
                  {collection.name}
                </span>
                <span style={{ fontSize: 10.5, color: "var(--vb-fg-3)", fontFamily: "var(--font-mono)" }}>
                  {recordCount} · {collection.type}
                </span>
              </span>
              <TypePill type={collection.type} />
            </span>
          ) : <span key="loading">Loading…</span>,
        ]}
        right={
          <>
            {collection?.type === "base" && (
              <>
                <VbBtn kind="ghost" size="sm" icon="download" onClick={handleExport} title="Download all records as CSV">
                  Export
                </VbBtn>
                <VbBtn kind="ghost" size="sm" icon="upload" onClick={() => importInputRef.current?.click()} title="Upload a CSV to bulk-create records">
                  Import
                </VbBtn>
                <input
                  ref={importInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  style={{ display: "none" }}
                  onChange={handleImport}
                />
              </>
            )}
            <span style={{ width: 1, height: 20, background: "var(--vb-border)", margin: "0 4px" }} />
            <VbBtn
              kind="primary"
              size="sm"
              icon="plus"
              onClick={() => setShowNew(true)}
              disabled={!collection || collection.type === "auth" || collection.type === "view"}
              title={newBtnTitle}
            >
              {newBtnLabel}
            </VbBtn>
          </>
        }
      />

      <VbTabs
        tabs={subTabs}
        active="records"
        onChange={onSubTab}
      />

      <div className="app-body" style={{ padding: "16px 28px 28px" }}>
        {/* Filter bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <div style={{ flex: 1, position: "relative" }}>
            <span style={{
              position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)",
              color: "var(--vb-fg-3)",
            }}>
              <Icon name="search" size={14} />
            </span>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyFilter()}
              placeholder='filter — e.g. (title="hello") · press Enter to apply'
              style={{
                width: "100%",
                height: 32,
                padding: "0 110px 0 32px",
                background: "var(--vb-bg-2)",
                border: "1px solid var(--vb-border-2)",
                borderRadius: 6,
                color: "var(--vb-fg)",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                outline: "none",
              }}
            />
            {appliedFilter ? (
              <button
                onClick={() => { setFilter(""); setAppliedFilter(""); setPage(1); }}
                title="Clear filter"
                style={{
                  position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                  background: "transparent", border: "0", color: "var(--vb-fg-3)",
                  cursor: "pointer", padding: 4,
                }}
              >
                <Icon name="x" size={12} />
              </button>
            ) : (
              <span style={{
                position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
                fontSize: 10, color: "var(--vb-fg-3)", fontFamily: "var(--font-mono)",
                padding: "2px 6px", borderRadius: 3, background: "var(--vb-bg-3)",
                pointerEvents: "none",
              }}>⏎ apply</span>
            )}
          </div>
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
            style={{ height: 32, minWidth: 132, fontSize: 12 }}
          />
        </div>

        {/* Filter presets — visual placeholder. Wiring saved presets is a
            follow-up; today these chips set example filters into the input. */}
        <div style={{
          display: "flex", alignItems: "center", gap: 6,
          marginBottom: 12, flexWrap: "wrap",
        }}>
          <span style={{
            fontSize: 10.5, color: "var(--vb-fg-3)",
            textTransform: "uppercase", letterSpacing: 1.2, marginRight: 4,
            fontFamily: "var(--font-mono)",
          }}>presets</span>
          {[
            { label: "Last 24h",    set: `created > "${new Date(Date.now() - 86400_000).toISOString()}"` },
            { label: "Has updates", set: `updated != created` },
          ].map((p) => (
            <button
              key={p.label}
              onClick={() => applyFilter(p.set)}
              style={{
                appearance: "none",
                border: "1px solid var(--vb-border-2)",
                background: "var(--vb-bg-2)",
                color: "var(--vb-fg-2)",
                fontFamily: "var(--font-mono)",
                fontSize: 10.5,
                padding: "3px 8px",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >{p.label}</button>
          ))}
        </div>

        {selected.length > 0 && (
          <div style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 14px",
            background: "var(--vb-accent-soft)",
            border: "1px solid rgba(232, 90, 79, 0.30)",
            borderRadius: 6,
            marginBottom: 10,
          }}>
            <span style={{
              fontSize: 11.5, fontFamily: "var(--font-mono)",
              color: "var(--vb-accent)",
            }}>
              <span style={{ fontWeight: 700 }}>{selected.length}</span> selected
            </span>
            {collection?.type === "base" && (
              <VbBtn kind="ghost" size="sm" icon="download" onClick={handleExport} disabled={bulkDeleting}>
                Export
              </VbBtn>
            )}
            <VbBtn kind="ghost" size="sm" onClick={() => setSelected([])} disabled={bulkDeleting}>
              Clear
            </VbBtn>
            <VbBtn
              kind="danger"
              size="sm"
              icon="trash"
              onClick={handleBulkDelete}
              disabled={bulkDeleting || collection?.type === "view"}
            >
              {bulkDeleting ? "Deleting…" : `Delete · ${selected.length}`}
            </VbBtn>
            <span style={{
              marginLeft: "auto",
              fontSize: 11, color: "var(--vb-fg-3)",
              fontFamily: "var(--font-mono)",
            }}>{total.toLocaleString()} total</span>
          </div>
        )}

        <VbTable<RecordRow>
          rows={records}
          rowKey={(r) => String(r.id)}
          loading={loading}
          selectable={collection?.type !== "view"}
          selected={collection?.type === "view" ? [] : selected}
          onSelectionChange={setSelected}
          onRowClick={(r) => openRecord(r)}
          sort={sort}
          onSortChange={(s) => { setSort(s); setPage(1); }}
          total={total}
          page={page}
          pageSize={30}
          onPageChange={setPage}
          columns={recordColumns(collection, displayCols, fieldsByName, cellValue)}
          emptyState={
            <VbEmptyState
              icon="stack"
              title={appliedFilter ? "No records match this filter." : "No records yet"}
              body={appliedFilter
                ? "Adjust the filter or clear it to see all records."
                : "Create one manually, import a CSV, or insert from a hook."}
            />
          }
        />
      </div>

      {/* Edit drawer */}
      <Drawer
        open={!!openRec}
        onClose={() => setOpenRec(null)}
        title={collection?.type === "view" ? "View record (read-only)" : "Edit record"}
        idLabel={openRec ? String(openRec.id).slice(0, 16) : undefined}
        footer={
          collection?.type === "view" ? (
            <VbBtn kind="ghost" size="sm" onClick={() => setOpenRec(null)} style={{ marginLeft: "auto" }}>
              Close
            </VbBtn>
          ) : (
            <>
              <VbBtn
                kind="danger"
                size="sm"
                icon="trash"
                onClick={() => openRec && handleDelete(String(openRec.id))}
              >
                Delete
              </VbBtn>
              {collection?.type === "auth" && openRec && (
                <>
                  {openRec["mfa_enabled"] === true && (
                    <VbBtn
                      kind="ghost"
                      size="sm"
                      icon="key"
                      onClick={() => handleDisableMfa(String(openRec.id))}
                      title="Reset MFA — user signs in with password only until they re-enroll"
                    >
                      Disable MFA
                    </VbBtn>
                  )}
                  <VbBtn
                    kind="ghost"
                    size="sm"
                    icon="users"
                    onClick={() => handleImpersonate(String(openRec.id))}
                    title="Mint a 1h user JWT for support purposes (audited)"
                  >
                    Impersonate
                  </VbBtn>
                </>
              )}
              <span style={{ flex: 1 }} />
              <VbBtn kind="ghost" size="sm" onClick={() => setOpenRec(null)}>
                Cancel
              </VbBtn>
              <VbBtn kind="primary" size="sm" icon="check" onClick={handleSave} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </VbBtn>
            </>
          )
        }
      >
        {openRec && (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {/* System read-only fields */}
            {(["id", "created", "updated"] as const).map((key) => {
              const raw = openRec[key];
              const display = key === "id"
                ? String(raw)
                : new Date((raw as number) * 1000).toISOString();
              return (
                <DrawerFieldRow key={key} name={key} type={key === "id" ? "text" : "autodate"}>
                  <VbInput mono value={display} readOnly />
                </DrawerFieldRow>
              );
            })}
            <div style={{ borderTop: "1px solid var(--vb-border)", margin: "4px 0" }} />
            {/* User fields */}
            {userFields.map((f) => (
              <DrawerFieldRow key={f.name} name={f.name} type={f.type} required={f.required}>
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
                  <div style={{
                    fontSize: 11,
                    color: "var(--vb-status-danger)",
                    marginTop: 4,
                    fontFamily: "var(--font-mono)",
                  }}>
                    {editErrors[f.name]}
                  </div>
                )}
              </DrawerFieldRow>
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
