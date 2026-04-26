import { useEffect, useState } from "react";
import {
  api, type ApiResponse, type Collection, type ListResponse,
  type RecordRow, collColor, parseFields,
} from "../api.ts";
import { Topbar } from "../components/Shell.tsx";
import type { Route } from "../components/Shell.tsx";
import { Drawer, FieldTypeChip, Toggle } from "../components/UI.tsx";
import Icon from "../components/Icon.tsx";

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
  const [openRec, setOpenRec] = useState<RecordRow | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadCollection() {
    const res = await api.get<ApiResponse<Collection>>(`/api/collections/${collId}`);
    if (res.data) setCollection(res.data);
  }

  async function loadRecords(p = 1) {
    if (!collection) return;
    setLoading(true);
    const res = await api.get<ListResponse<RecordRow>>(
      `/api/${collection.name}?page=${p}&perPage=30`
    );
    if (res.data) { setRecords(res.data); setTotal(res.totalItems); }
    setLoading(false);
  }

  useEffect(() => { loadCollection(); }, [collId]);
  useEffect(() => { if (collection) loadRecords(page); }, [collection, page]);

  async function handleDelete(id: string) {
    if (!collection || !confirm("Delete this record?")) return;
    await api.delete(`/api/${collection.name}/${id}`);
    toast("Record deleted", "trash");
    setOpenRec(null);
    loadRecords(page);
  }

  const fields = collection ? parseFields(collection.fields).filter((f) => !f.system) : [];
  const colorIdx = 0;
  const color = collColor(colorIdx);

  const displayCols = fields.length > 0
    ? fields.slice(0, 5).map((f) => f.name)
    : ["id"];

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
              <span
                className={`coll-icon ${color}`}
                style={{ width: 22, height: 22, fontSize: 11 }}
              >
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
            <button className="btn btn-primary">
              <Icon name="plus" size={12} /> New record
            </button>
          </>
        }
      />
      <div className="app-body">
        <div className="filter-bar">
          <div className="input-group" style={{ flex: 1, maxWidth: 520 }}>
            <Icon name="search" size={13} />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter e.g. (status='active')"
            />
          </div>
          <div className="right">
            <button className="btn btn-ghost">
              <Icon name="sort" size={12} /> Sort
            </button>
          </div>
        </div>

        <div className="table-wrap">
          {loading ? (
            <div className="empty">Loading…</div>
          ) : records.length === 0 ? (
            <div className="empty">No records yet.</div>
          ) : (
            <>
              <table className="table">
                <thead>
                  <tr>
                    <th>id</th>
                    {displayCols.map((c) => <th key={c}>{c}</th>)}
                    <th>created</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r) => (
                    <tr
                      key={r.id}
                      className={openRec?.id === r.id ? "selected" : ""}
                      onClick={() => setOpenRec(r)}
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
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="pagination">
                <span>
                  {(page - 1) * 30 + 1}–{Math.min(page * 30, total)} of{" "}
                  {total.toLocaleString()}
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

      <Drawer
        open={!!openRec}
        onClose={() => setOpenRec(null)}
        title="Record"
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
            <button className="btn btn-ghost" onClick={() => setOpenRec(null)}>
              Close
            </button>
          </>
        }
      >
        {openRec && (
          <div className="col" style={{ gap: 14 }}>
            {Object.entries(openRec)
              .filter(([k]) => !["collectionId", "collectionName"].includes(k))
              .map(([key, val]) => {
                const fieldDef = fields.find((f) => f.name === key);
                const type = fieldDef?.type ?? (typeof val === "boolean" ? "bool" : "text");
                return (
                  <div className="field-row" key={key}>
                    <div className="row" style={{ justifyContent: "space-between" }}>
                      <span className="field-name">{key}</span>
                      <FieldTypeChip type={type} />
                    </div>
                    {type === "bool" ? (
                      <Toggle on={!!val} onChange={() => {}} />
                    ) : (
                      <input
                        className={`input${type === "autodate" || key === "id" ? " mono" : ""}`}
                        defaultValue={
                          type === "autodate"
                            ? new Date((val as number) * 1000).toISOString()
                            : String(val ?? "")
                        }
                        readOnly={type === "autodate" || key === "id"}
                      />
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </Drawer>
    </>
  );
}
