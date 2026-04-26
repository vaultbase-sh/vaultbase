import { useEffect, useState } from "react";
import { api, type ApiResponse, type Collection } from "../api.ts";

interface FieldDef {
  name: string;
  type: string;
  required?: boolean;
}

function FieldEditor({
  fields,
  onChange,
}: {
  fields: FieldDef[];
  onChange: (f: FieldDef[]) => void;
}) {
  function add() {
    onChange([...fields, { name: "", type: "text", required: false }]);
  }
  function remove(i: number) {
    onChange(fields.filter((_, idx) => idx !== i));
  }
  function update(i: number, key: keyof FieldDef, value: string | boolean) {
    onChange(fields.map((f, idx) => (idx === i ? { ...f, [key]: value } : f)));
  }
  return (
    <div>
      {fields.map((f, i) => (
        <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <input
            placeholder="name"
            value={f.name}
            onChange={(e) => update(i, "name", e.target.value)}
            style={{ flex: 1, padding: "6px 8px", border: "1px solid #d4d4d8", borderRadius: 4 }}
          />
          <select
            value={f.type}
            onChange={(e) => update(i, "type", e.target.value)}
            style={{ padding: "6px 8px", border: "1px solid #d4d4d8", borderRadius: 4 }}
          >
            {["text", "number", "bool", "file", "relation", "select", "autodate"].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={f.required ?? false}
              onChange={(e) => update(i, "required", e.target.checked)}
            />{" "}
            req
          </label>
          <button
            type="button"
            onClick={() => remove(i)}
            style={{
              padding: "4px 8px",
              background: "#fee2e2",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={add}
        style={{
          padding: "6px 12px",
          background: "#f4f4f5",
          border: "1px solid #d4d4d8",
          borderRadius: 4,
          cursor: "pointer",
        }}
      >
        + Add field
      </button>
    </div>
  );
}

export default function Collections() {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [fields, setFields] = useState<FieldDef[]>([]);
  const [error, setError] = useState("");

  async function load() {
    const r = await api.get<ApiResponse<Collection[]>>("/api/collections");
    if (r.data) setCollections(r.data);
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const r = await api.post<ApiResponse<Collection>>("/api/collections", { name, fields });
    if (r.error) {
      setError(r.error);
      return;
    }
    setName("");
    setFields([]);
    setShowForm(false);
    load();
  }

  async function handleDelete(id: string) {
    if (!confirm("Delete this collection and all its records?")) return;
    await api.delete(`/api/collections/${id}`);
    load();
  }

  return (
    <div>
      <div
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}
      >
        <h1 style={{ margin: 0 }}>Collections</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          style={{
            padding: "8px 16px",
            background: "#18181b",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          New collection
        </button>
      </div>
      {showForm && (
        <form
          onSubmit={handleCreate}
          style={{ background: "#f4f4f5", padding: 20, borderRadius: 8, marginBottom: 24 }}
        >
          <h3 style={{ margin: "0 0 16px" }}>New collection</h3>
          {error && <div style={{ color: "#dc2626", marginBottom: 12 }}>{error}</div>}
          <input
            placeholder="Collection name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            style={{
              width: "100%",
              padding: "8px 10px",
              marginBottom: 16,
              border: "1px solid #d4d4d8",
              borderRadius: 4,
              boxSizing: "border-box",
            }}
          />
          <div style={{ marginBottom: 16 }}>
            <FieldEditor fields={fields} onChange={setFields} />
          </div>
          <button
            type="submit"
            style={{
              padding: "8px 16px",
              background: "#18181b",
              color: "#fff",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            Create
          </button>
        </form>
      )}
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "2px solid #e4e4e7" }}>
            <th style={{ textAlign: "left", padding: "8px 0" }}>Name</th>
            <th style={{ textAlign: "left", padding: "8px 0" }}>Fields</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {collections.map((col) => (
            <tr key={col.id} style={{ borderBottom: "1px solid #f4f4f5" }}>
              <td style={{ padding: "10px 0" }}>
                <a
                  href={`/_/collections/${col.id}/records`}
                  style={{ color: "#18181b", fontWeight: 500 }}
                >
                  {col.name}
                </a>
              </td>
              <td style={{ padding: "10px 0", color: "#71717a", fontSize: 13 }}>
                {(JSON.parse(col.fields) as FieldDef[]).length} fields
              </td>
              <td style={{ padding: "10px 0", textAlign: "right" }}>
                <button
                  onClick={() => handleDelete(col.id)}
                  style={{
                    padding: "4px 10px",
                    background: "#fee2e2",
                    border: "none",
                    borderRadius: 4,
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
