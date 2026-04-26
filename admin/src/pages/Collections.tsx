import { useEffect, useState } from "react";
import { api, type ApiResponse, type Collection, collColor, parseFields } from "../api.ts";
import { Topbar } from "../components/Shell.tsx";
import type { Route } from "../components/Shell.tsx";
import { StatCard } from "../components/UI.tsx";
import Icon from "../components/Icon.tsx";
import NewCollectionModal from "./NewCollectionModal.tsx";

const SPARK = [0.3, 0.4, 0.5, 0.5, 0.6, 0.7, 0.7, 0.8, 0.9, 1.0, 1.0, 0.9];

export default function Collections({
  setRoute,
  toast,
}: {
  setRoute: (r: Route) => void;
  toast: (text: string, icon?: string) => void;
}) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [tab, setTab] = useState<"all" | "auth" | "base">("all");
  const [showNew, setShowNew] = useState(false);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const res = await api.get<ApiResponse<Collection[]>>("/api/collections");
    if (res.data) setCollections(res.data);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleDelete(e: React.MouseEvent, id: string, name: string) {
    e.stopPropagation();
    if (!confirm(`Delete collection "${name}" and all its records?`)) return;
    await api.delete(`/api/collections/${id}`);
    toast(`Collection "${name}" deleted`, "trash");
    load();
  }

  // Detect collection type heuristic: if it has email + password_hash fields → auth
  function collType(col: Collection) {
    const fields = parseFields(col.fields);
    return fields.some((f) => f.name === "email") ? "auth" : "base";
  }

  const typed = collections.map((c, i) => ({
    ...c,
    type: collType(c),
    color: collColor(i),
    fieldCount: parseFields(c.fields).length,
  }));

  const filtered = typed.filter((c) => tab === "all" || c.type === tab);
  const authCount = typed.filter((c) => c.type === "auth").length;
  const baseCount = typed.filter((c) => c.type === "base").length;

  return (
    <>
      <Topbar
        title="Collections"
        subtitle={`${collections.length} collections`}
        actions={
          <>
            <button
              className="btn btn-ghost"
              disabled
              title="Import available in v2"
              style={{ opacity: 0.4, cursor: "not-allowed" }}
            >
              <Icon name="upload" size={12} /> Import
              <span style={{ fontSize: 10, marginLeft: 4, color: "var(--text-muted)" }}>v2</span>
            </button>
            <button className="btn btn-primary" onClick={() => setShowNew(true)}>
              <Icon name="plus" size={12} /> New collection
            </button>
          </>
        }
      />
      <div className="tabs">
        {[
          { id: "all" as const, label: "All", count: collections.length },
          { id: "auth" as const, label: "Auth", count: authCount },
          { id: "base" as const, label: "Base", count: baseCount },
        ].map((t) => (
          <div
            key={t.id}
            className={`tab${tab === t.id ? " active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}{" "}
            <span className="badge base mono">{t.count}</span>
          </div>
        ))}
      </div>
      <div className="app-body">
        <div className="stat-row">
          <StatCard
            label="Collections"
            value={collections.length}
            spark={SPARK}
          />
          <StatCard
            label="Auth collections"
            value={authCount}
            spark={SPARK.map((v) => v * 0.6)}
          />
          <StatCard
            label="Base collections"
            value={baseCount}
            spark={SPARK.map((v) => v * 0.8)}
          />
        </div>

        <div className="table-wrap">
          {loading ? (
            <div className="empty">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="empty">
              No collections yet.{" "}
              <button
                className="btn btn-ghost"
                style={{ display: "inline-flex", height: 24, padding: "0 10px", fontSize: 12 }}
                onClick={() => setShowNew(true)}
              >
                Create one
              </button>
            </div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: "40%" }}>Name</th>
                  <th>Type</th>
                  <th className="right">Fields</th>
                  <th className="right" style={{ width: 92 }} />
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id} onClick={() => setRoute({ page: "records", coll: c.id })}>
                    <td>
                      <div className="cell-name">
                        <div className={`coll-icon ${c.color}`}>
                          {c.name[0]!.toUpperCase()}
                        </div>
                        <div className="cell-name-text">
                          <span className="name">{c.name}</span>
                          <span className="meta">
                            {c.fieldCount} fields · id, created…
                          </span>
                        </div>
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${c.type}`}>{c.type}</span>
                    </td>
                    <td className="right mono-cell">{c.fieldCount}</td>
                    <td className="right">
                      <span className="row-actions">
                        <button
                          className="btn-icon"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRoute({ page: "collection-edit", coll: c.id });
                          }}
                          title="Edit schema"
                        >
                          <Icon name="pencil" size={12} />
                        </button>
                        <button
                          className="btn-icon danger"
                          onClick={(e) => handleDelete(e, c.id, c.name)}
                          title="Delete"
                        >
                          <Icon name="trash" size={12} />
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <NewCollectionModal
        open={showNew}
        onClose={() => setShowNew(false)}
        onCreate={(name) => {
          setShowNew(false);
          toast(`Collection "${name}" created`);
          load();
        }}
      />
    </>
  );
}
