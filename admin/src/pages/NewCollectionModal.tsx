import { useState } from "react";
import { api, type ApiResponse, type Collection, type FieldDef } from "../api.ts";
import { Modal, FieldTypeChip } from "../components/UI.tsx";
import Icon from "../components/Icon.tsx";

const FIELD_TYPES: FieldDef["type"][] = ["text", "number", "bool", "date", "file", "relation", "select", "json"];

const SYSTEM_FIELDS: FieldDef[] = [
  { name: "id", type: "text", required: true, system: true },
  { name: "created", type: "autodate", required: true, system: true },
  { name: "updated", type: "autodate", required: true, system: true },
];

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
  const [type, setType] = useState<"base" | "auth">("base");
  const [fields, setFields] = useState<FieldDef[]>(SYSTEM_FIELDS);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const cleanName = name.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");

  function addField(t: FieldDef["type"]) {
    const newField: FieldDef = { name: `${t}_field`, type: t, required: false };
    setFields((fs) => [...fs.slice(0, -2), newField, ...fs.slice(-2)]);
  }

  function removeField(i: number) {
    setFields((fs) => fs.filter((_, xi) => xi !== i));
  }

  async function handleCreate() {
    if (!cleanName) return;
    setError("");
    setLoading(true);
    const userFields = fields.filter((f) => !f.system);
    const res = await api.post<ApiResponse<Collection>>("/api/collections", {
      name: cleanName,
      fields: userFields,
    });
    setLoading(false);
    if (res.error) { setError(res.error); return; }
    setName(""); setFields(SYSTEM_FIELDS); setType("base");
    onCreate(cleanName);
  }

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
            disabled={!cleanName || loading}
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
        <div>
          <label className="label">Name</label>
          <input
            className="input mono"
            value={cleanName || name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my_collection"
            autoFocus
          />
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            Lowercase, numbers, underscores. API path:{" "}
            <span className="mono">/api/{cleanName || "name"}</span>
          </div>
        </div>

        <div>
          <label className="label">Type</label>
          <div className="row">
            {[
              { id: "base" as const, label: "Base", desc: "Standard collection of records" },
              { id: "auth" as const, label: "Auth", desc: "Adds email + password auth fields" },
            ].map((t) => (
              <div
                key={t.id}
                onClick={() => setType(t.id)}
                style={{
                  flex: 1, padding: "10px 12px", borderRadius: 8, cursor: "pointer",
                  border: `0.5px solid ${type === t.id ? "var(--accent)" : "var(--border-default)"}`,
                  background: type === t.id ? "var(--accent-glow)" : "rgba(255,255,255,0.03)",
                }}
              >
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span style={{ fontSize: 12.5, fontWeight: 500, color: type === t.id ? "var(--accent-light)" : "var(--text-primary)" }}>
                    {t.label}
                  </span>
                  {type === t.id && <Icon name="check" size={12} style={{ color: "var(--accent-light)" }} />}
                </div>
                <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{t.desc}</div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <label className="label">Schema · {fields.length} fields</label>
          <div className="field-list" style={{ borderRadius: 8 }}>
            {fields.map((f, i) => (
              <div key={i} className="field-row-edit" style={{ padding: "8px 12px" }}>
                <span className="grip"><Icon name="grip" size={12} /></span>
                <span className="name" style={{ minWidth: 140, fontSize: 12 }}>{f.name}</span>
                <FieldTypeChip type={f.type} />
                {f.system ? (
                  <span className="system" style={{ marginLeft: "auto" }}>system</span>
                ) : (
                  <button
                    className="btn-icon"
                    style={{ marginLeft: "auto" }}
                    onClick={() => removeField(i)}
                  >
                    <Icon name="x" size={12} />
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="add-field-bar" style={{ borderRadius: 8, marginTop: 6, border: "0.5px solid var(--border-default)" }}>
            <span className="label-mini">Add</span>
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
