import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type ApiResponse } from "../api.ts";

interface RecordRow {
  id: string;
  [key: string]: unknown;
}

interface ListResponse {
  data: RecordRow[];
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
}

export default function Records() {
  const { id } = useParams<{ id: string }>();
  const [rows, setRows] = useState<RecordRow[]>([]);
  const [colName, setColName] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [showForm, setShowForm] = useState(false);
  const [jsonInput, setJsonInput] = useState("{}");
  const [error, setError] = useState("");

  async function load(p = page) {
    if (!id) return;
    const col = await api.get<ApiResponse<{ name: string }>>(`/api/collections/${id}`);
    const name = col.data?.name ?? id;
    if (col.data) setColName(col.data.name);
    const r = await api.get<ListResponse>(`/api/${name}?page=${p}&perPage=30`);
    if (r.data) {
      setRows(r.data);
      setTotal(r.totalItems);
    }
  }

  useEffect(() => {
    load();
  }, [id]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    let body: unknown;
    try {
      body = JSON.parse(jsonInput);
    } catch {
      setError("Invalid JSON");
      return;
    }
    await api.post(`/api/${colName}`, body);
    setJsonInput("{}");
    setShowForm(false);
    load();
  }

  async function handleDelete(rid: string) {
    if (!confirm("Delete record?")) return;
    await api.delete(`/api/${colName}/${rid}`);
    load();
  }

  const cols =
    rows.length > 0
      ? Object.keys(rows[0]!)
          .filter((k) => !["collectionId", "collectionName"].includes(k))
          .slice(0, 6)
      : [];

  return (
    <div>
      <div
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}
      >
        <h1 style={{ margin: 0 }}>{colName || id}</h1>
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
          New record
        </button>
      </div>
      {showForm && (
        <form
          onSubmit={handleCreate}
          style={{ background: "#f4f4f5", padding: 20, borderRadius: 8, marginBottom: 24 }}
        >
          <h3 style={{ margin: "0 0 12px" }}>New record (JSON)</h3>
          {error && <div style={{ color: "#dc2626", marginBottom: 8 }}>{error}</div>}
          <textarea
            value={jsonInput}
            onChange={(e) => setJsonInput(e.target.value)}
            rows={6}
            style={{
              width: "100%",
              padding: 10,
              border: "1px solid #d4d4d8",
              borderRadius: 4,
              fontFamily: "monospace",
              boxSizing: "border-box",
            }}
          />
          <button
            type="submit"
            style={{
              marginTop: 8,
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
            {cols.map((c) => (
              <th key={c} style={{ textAlign: "left", padding: "8px 4px", fontSize: 13 }}>
                {c}
              </th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} style={{ borderBottom: "1px solid #f4f4f5" }}>
              {cols.map((c) => (
                <td
                  key={c}
                  style={{
                    padding: "10px 4px",
                    fontSize: 13,
                    maxWidth: 200,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {String(row[c] ?? "")}
                </td>
              ))}
              <td style={{ textAlign: "right" }}>
                <button
                  onClick={() => handleDelete(row.id)}
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
      <div style={{ marginTop: 16, display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
        <button
          disabled={page === 1}
          onClick={() => {
            const p = page - 1;
            setPage(p);
            load(p);
          }}
          style={{ padding: "4px 10px" }}
        >
          ←
        </button>
        <span>
          Page {page} · {total} total
        </span>
        <button
          disabled={rows.length < 30}
          onClick={() => {
            const p = page + 1;
            setPage(p);
            load(p);
          }}
          style={{ padding: "4px 10px" }}
        >
          →
        </button>
      </div>
    </div>
  );
}
