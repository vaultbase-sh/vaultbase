import { useEffect, useState } from "react";
import { api, type ApiResponse, type Collection } from "../api.ts";

export default function Dashboard() {
  const [collections, setCollections] = useState<Collection[]>([]);

  useEffect(() => {
    api.get<ApiResponse<Collection[]>>("/api/collections").then((r) => {
      if (r.data) setCollections(r.data);
    });
  }, []);

  return (
    <div>
      <h1 style={{ margin: "0 0 24px" }}>Dashboard</h1>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(180px,1fr))",
          gap: 16,
        }}
      >
        {collections.map((col) => (
          <a
            key={col.id}
            href={`/_/collections/${col.id}/records`}
            style={{
              display: "block",
              padding: 20,
              border: "1px solid #e4e4e7",
              borderRadius: 8,
              textDecoration: "none",
              color: "#18181b",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{col.name}</div>
            <div style={{ fontSize: 12, color: "#71717a" }}>Collection</div>
          </a>
        ))}
      </div>
      {collections.length === 0 && (
        <p style={{ color: "#71717a" }}>
          No collections yet.{" "}
          <a href="/_/collections" style={{ color: "#18181b" }}>
            Create one.
          </a>
        </p>
      )}
    </div>
  );
}
