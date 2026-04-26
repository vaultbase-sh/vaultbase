import { useEffect, useMemo, useState } from "react";
import { Dropdown } from "primereact/dropdown";
import { api, type ApiResponse, type Collection, type FieldDef } from "../api.ts";
import { Modal, FieldTypeChip, Toggle } from "../components/UI.tsx";
import Icon from "../components/Icon.tsx";

const FIELD_TYPES: FieldDef["type"][] = ["text", "number", "bool", "email", "url", "date", "file", "relation", "select", "json"];

const SYSTEM_FIELDS: FieldDef[] = [
  { name: "id",      type: "text",     required: true, system: true },
  { name: "created", type: "autodate", required: true, system: true },
  { name: "updated", type: "autodate", required: true, system: true },
];

function cleanFieldName(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

function cleanCollName(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
}

export default function NewCollectionModal({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [fields, setFields] = useState<FieldDef[]>(SYSTEM_FIELDS);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [allCollections, setAllCollections] = useState<Collection[]>([]);

  useEffect(() => {
    if (open) {
      setName("");
      setFields(SYSTEM_FIELDS);
      setExpanded(null);
      setError("");
      setLoading(false);
      // Fetch existing collections for relation autocomplete
      api.get<ApiResponse<Collection[]>>("/api/collections").then((res) => {
        if (res.data) setAllCollections(res.data);
      });
    }
  }, [open]);

  const collectionNames = useMemo(
    () => allCollections.map((c) => c.name),
    [allCollections]
  );

  function addField(t: FieldDef["type"]) {
    const newField: FieldDef = { name: "", type: t, required: false, options: {} };
    setFields((fs) => [...fs.slice(0, -2), newField, ...fs.slice(-2)]);
    setExpanded(fields.length - 2); // index of newly inserted field
  }

  function patchField(i: number, patch: Partial<FieldDef>) {
    setFields((fs) => fs.map((f, xi) => (xi === i ? { ...f, ...patch } : f)));
  }

  function patchOptions(i: number, patch: Record<string, unknown>) {
    setFields((fs) =>
      fs.map((f, xi) =>
        xi === i ? { ...f, options: { ...(f.options ?? {}), ...patch } } : f
      )
    );
  }

  function removeField(i: number) {
    setFields((fs) => fs.filter((_, xi) => xi !== i));
    if (expanded === i) setExpanded(null);
    else if (expanded !== null && expanded > i) setExpanded(expanded - 1);
  }

  async function handleCreate() {
    const collName = cleanCollName(name);
    if (!collName) return;
    const userFields = fields.filter((f) => !f.system);
    const unnamed = userFields.filter((f) => !f.name);
    if (unnamed.length > 0) { setError("All fields must have a name."); return; }
    const badSelect = userFields.find(
      (f) => f.type === "select" && (!Array.isArray(f.options?.values) || (f.options?.values as string[]).length === 0)
    );
    if (badSelect) { setError(`Select field '${badSelect.name}' must have at least one allowed value.`); return; }
    const badRelation = userFields.find((f) => f.type === "relation" && !f.collection);
    if (badRelation) { setError(`Relation field '${badRelation.name}' must have a target collection.`); return; }
    setError("");
    setLoading(true);
    const res = await api.post<ApiResponse<Collection>>("/api/collections", {
      name: collName,
      fields: userFields,
    });
    setLoading(false);
    if (res.error) { setError(res.error); return; }
    onCreate(collName);
  }

  const collName = cleanCollName(name);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New collection"
      width={620}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={!collName || loading}
            onClick={handleCreate}
          >
            <Icon name="check" size={12} />
            {loading ? "Creating…" : "Create collection"}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 16 }}>
        {error && (
          <div style={{ color: "var(--danger)", fontSize: 12, padding: "8px 12px", background: "rgba(248,113,113,0.1)", borderRadius: 6 }}>
            {error}
          </div>
        )}

        {/* Collection name */}
        <div>
          <label className="label">Name</label>
          <input
            className="input mono"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my_collection"
            autoFocus
          />
          {name && collName !== name && (
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              Stored as: <span className="mono" style={{ color: "var(--text-secondary)" }}>{collName}</span>
            </div>
          )}
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            API path: <span className="mono">/api/{collName || "name"}</span>
          </div>
        </div>

        {/* Field schema */}
        <div>
          <label className="label">Schema · {fields.length} fields</label>
          <div className="field-list" style={{ borderRadius: 8 }}>
            {fields.map((f, i) => (
              <div key={i} style={{ borderBottom: i < fields.length - 1 ? "0.5px solid rgba(255,255,255,0.04)" : "none" }}>
                <div
                  className={`field-row-edit${expanded === i ? " selected" : ""}`}
                  style={{ padding: "8px 12px", gap: 8, borderBottom: "none" }}
                >
                  <span className="grip" style={{ flexShrink: 0 }}>
                    <Icon name="grip" size={12} />
                  </span>

                  {f.system ? (
                    <span className="name" style={{ minWidth: 140, fontSize: 12 }}>{f.name}</span>
                  ) : (
                    <input
                      className="input mono"
                      style={{ height: 26, fontSize: 12, minWidth: 130, maxWidth: 160 }}
                      value={f.name}
                      onChange={(e) => patchField(i, { name: cleanFieldName(e.target.value) })}
                      onClick={(e) => e.stopPropagation()}
                      placeholder="field_name"
                    />
                  )}

                  {f.system ? (
                    <FieldTypeChip type={f.type} />
                  ) : (
                    <Dropdown
                      value={f.type}
                      options={FIELD_TYPES}
                      onChange={(e) => { e.originalEvent?.stopPropagation(); patchField(i, { type: e.value as FieldDef["type"], options: {} }); }}
                      style={{ height: 26, minWidth: 100, fontSize: 11 }}
                      panelStyle={{ fontFamily: "var(--font-mono)", fontSize: 11 }}
                    />
                  )}

                  {!f.system && (
                    <label
                      style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--text-secondary)" }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Toggle
                        on={f.required ?? false}
                        onChange={(v) => patchField(i, { required: v })}
                      />
                      <span>req</span>
                    </label>
                  )}

                  {f.system ? (
                    <span className="system" style={{ marginLeft: "auto", fontSize: 10.5 }}>system</span>
                  ) : (
                    <>
                      <button
                        className="btn-icon"
                        style={{ marginLeft: "auto", flexShrink: 0 }}
                        onClick={(e) => { e.stopPropagation(); setExpanded(expanded === i ? null : i); }}
                        title={expanded === i ? "Hide options" : "Show options"}
                      >
                        <Icon name={expanded === i ? "chevronDown" : "chevronRight"} size={12} />
                      </button>
                      <button
                        className="btn-icon"
                        style={{ flexShrink: 0 }}
                        onClick={(e) => { e.stopPropagation(); removeField(i); }}
                        title="Remove field"
                      >
                        <Icon name="x" size={12} />
                      </button>
                    </>
                  )}
                </div>

                {expanded === i && !f.system && (
                  <FieldOptionsPanel
                    field={f}
                    onPatchOptions={(patch) => patchOptions(i, patch)}
                    onPatchField={(patch) => patchField(i, patch)}
                    collectionNames={collectionNames}
                  />
                )}
              </div>
            ))}
          </div>
          <div className="add-field-bar" style={{ borderRadius: 8, marginTop: 6, border: "0.5px solid var(--border-default)" }}>
            <span className="label-mini">Add field</span>
            {FIELD_TYPES.map((t) => (
              <span className="add-chip" key={t} onClick={() => addField(t)}>
                <Icon name="plus" size={10} />{t}
              </span>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── Per-field options panel ──────────────────────────────────────────────────
function FieldOptionsPanel({
  field,
  onPatchOptions,
  onPatchField,
  collectionNames,
}: {
  field: FieldDef;
  onPatchOptions: (patch: Record<string, unknown>) => void;
  onPatchField: (patch: Partial<FieldDef>) => void;
  collectionNames: string[];
}) {
  const opts = (field.options ?? {}) as Record<string, unknown>;

  function numOrUndef(v: string): number | undefined {
    if (v === "") return undefined;
    const n = Number(v);
    return isNaN(n) ? undefined : n;
  }

  return (
    <div
      style={{
        padding: "10px 14px 12px 36px",
        background: "rgba(255,255,255,0.015)",
        display: "flex",
        flexDirection: "column",
        gap: 10,
        fontSize: 12,
      }}
    >
      {/* Text / Email / URL */}
      {(field.type === "text" || field.type === "email" || field.type === "url") && (
        <>
          <div style={{ display: "flex", gap: 8 }}>
            <Field label="Min length">
              <input
                className="input mono"
                style={{ height: 28, fontSize: 12 }}
                type="number"
                min={0}
                value={(opts["min"] as number | undefined) ?? ""}
                onChange={(e) => onPatchOptions({ min: numOrUndef(e.target.value) })}
                placeholder="0"
              />
            </Field>
            <Field label="Max length">
              <input
                className="input mono"
                style={{ height: 28, fontSize: 12 }}
                type="number"
                min={0}
                value={(opts["max"] as number | undefined) ?? ""}
                onChange={(e) => onPatchOptions({ max: numOrUndef(e.target.value) })}
                placeholder="—"
              />
            </Field>
          </div>
          {field.type === "text" && (
            <Field label="Regex pattern">
              <input
                className="input mono"
                style={{ height: 28, fontSize: 12 }}
                value={(opts["pattern"] as string | undefined) ?? ""}
                onChange={(e) => onPatchOptions({ pattern: e.target.value || undefined })}
                placeholder="^[a-z0-9-]+$"
              />
            </Field>
          )}
          <UniqueToggle opts={opts} onPatchOptions={onPatchOptions} />
        </>
      )}

      {/* Number */}
      {field.type === "number" && (
        <>
          <div style={{ display: "flex", gap: 8 }}>
            <Field label="Min value">
              <input
                className="input mono"
                style={{ height: 28, fontSize: 12 }}
                type="number"
                value={(opts["min"] as number | undefined) ?? ""}
                onChange={(e) => onPatchOptions({ min: numOrUndef(e.target.value) })}
                placeholder="—"
              />
            </Field>
            <Field label="Max value">
              <input
                className="input mono"
                style={{ height: 28, fontSize: 12 }}
                type="number"
                value={(opts["max"] as number | undefined) ?? ""}
                onChange={(e) => onPatchOptions({ max: numOrUndef(e.target.value) })}
                placeholder="—"
              />
            </Field>
          </div>
          <UniqueToggle opts={opts} onPatchOptions={onPatchOptions} />
        </>
      )}

      {/* Select */}
      {field.type === "select" && (
        <>
          <Field label="Allowed values (comma-separated)">
            <input
              className="input mono"
              style={{ height: 28, fontSize: 12 }}
              value={Array.isArray(opts["values"]) ? (opts["values"] as string[]).join(", ") : ""}
              onChange={(e) =>
                onPatchOptions({
                  values: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              placeholder="draft, review, live"
            />
          </Field>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <Toggle
              on={!!opts["multiple"]}
              onChange={(v) => onPatchOptions({ multiple: v })}
            />
            <span>Allow multiple values</span>
          </label>
        </>
      )}

      {/* Relation */}
      {field.type === "relation" && (
        <Field label="Target collection">
          {collectionNames.length === 0 ? (
            <div className="muted" style={{ fontSize: 11 }}>
              No other collections yet. Create the target collection first.
            </div>
          ) : (
            <Dropdown
              value={field.collection ?? null}
              options={collectionNames}
              onChange={(e) => onPatchField({ collection: e.value })}
              placeholder="Select a collection…"
              filter
              showClear
              style={{ width: "100%", height: 28, fontSize: 12 }}
              panelStyle={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
            />
          )}
        </Field>
      )}

      {/* File */}
      {field.type === "file" && (
        <>
          <Field label="Max size (bytes)">
            <input
              className="input mono"
              style={{ height: 28, fontSize: 12 }}
              type="number"
              min={0}
              value={(opts["maxSize"] as number | undefined) ?? ""}
              onChange={(e) => onPatchOptions({ maxSize: numOrUndef(e.target.value) })}
              placeholder="5242880 = 5MB"
            />
          </Field>
          <Field label="Allowed MIME types (comma-separated)">
            <input
              className="input mono"
              style={{ height: 28, fontSize: 12 }}
              value={Array.isArray(opts["mimeTypes"]) ? (opts["mimeTypes"] as string[]).join(", ") : ""}
              onChange={(e) =>
                onPatchOptions({
                  mimeTypes: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              placeholder="image/*, application/pdf"
            />
          </Field>
        </>
      )}

      {(field.type === "bool" || field.type === "date" || field.type === "json") && (
        <div className="muted" style={{ fontSize: 11 }}>No additional options for this type.</div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4, fontWeight: 500 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function UniqueToggle({
  opts,
  onPatchOptions,
}: {
  opts: Record<string, unknown>;
  onPatchOptions: (patch: Record<string, unknown>) => void;
}) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
      <Toggle on={!!opts["unique"]} onChange={(v) => onPatchOptions({ unique: v })} />
      <span>Unique — reject duplicate values</span>
    </label>
  );
}
