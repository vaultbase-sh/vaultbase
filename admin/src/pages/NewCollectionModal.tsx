import { useEffect, useState } from "react";
import { api, type ApiResponse, type Collection, type FieldDef } from "../api.ts";
import { Modal, FieldTypeChip } from "../components/UI.tsx";
import Icon from "../components/Icon.tsx";

const FIELD_TYPES: FieldDef["type"][] = ["text", "number", "bool", "date", "file", "relation", "select", "json"];

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
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Reset state whenever modal is opened
  useEffect(() => {
    if (open) {
      setName("");
      setFields(SYSTEM_FIELDS);
      setError("");
      setLoading(false);
    }
  }, [open]);

  function addField(t: FieldDef["type"]) {
    const newField: FieldDef = { name: "", type: t, required: false };
    setFields((fs) => [...fs.slice(0, -2), newField, ...fs.slice(-2)]);
  }

  function updateFieldName(i: number, raw: string) {
    const cleaned = cleanFieldName(raw);
    setFields((fs) => fs.map((f, xi) => xi === i ? { ...f, name: cleaned } : f));
  }

  function updateFieldType(i: number, t: FieldDef["type"]) {
    setFields((fs) => fs.map((f, xi) => xi === i ? { ...f, type: t } : f));
  }

  function removeField(i: number) {
    setFields((fs) => fs.filter((_, xi) => xi !== i));
  }

  async function handleCreate() {
    const collName = cleanCollName(name);
    if (!collName) return;
    const userFields = fields.filter((f) => !f.system);
    const unnamed = userFields.filter((f) => !f.name);
    if (unnamed.length > 0) { setError("All fields must have a name."); return; }
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
  const userFields = fields.filter((f) => !f.system);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New collection"
      width={580}
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
              <div key={i} className="field-row-edit" style={{ padding: "8px 12px", gap: 8 }}>
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
                    onChange={(e) => updateFieldName(i, e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    placeholder="field_name"
                  />
                )}

                {f.system ? (
                  <FieldTypeChip type={f.type} />
                ) : (
                  <select
                    className="input mono"
                    style={{ height: 26, fontSize: 11, padding: "0 6px", width: "auto" }}
                    value={f.type}
                    onChange={(e) => updateFieldType(i, e.target.value as FieldDef["type"])}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                )}

                {f.system ? (
                  <span className="system" style={{ marginLeft: "auto", fontSize: 10.5 }}>system</span>
                ) : (
                  <button
                    className="btn-icon"
                    style={{ marginLeft: "auto", flexShrink: 0 }}
                    onClick={(e) => { e.stopPropagation(); removeField(i); }}
                    title="Remove field"
                  >
                    <Icon name="x" size={12} />
                  </button>
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
