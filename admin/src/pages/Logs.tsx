import { useCallback, useEffect, useRef, useState } from "react";
import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import type { DataTablePageEvent } from "primereact/datatable";
import { Dropdown } from "primereact/dropdown";
import { api, type ListResponse } from "../api.ts";
import { Topbar } from "../components/Shell.tsx";
import { Drawer } from "../components/UI.tsx";
import Icon from "../components/Icon.tsx";

interface LogEntry {
  id: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  ip: string | null;
  created_at: number;
}

function relativeTime(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

export default function Logs() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [methodFilter, setMethodFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [showAdmin, setShowAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [openLog, setOpenLog] = useState<LogEntry | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (p: number) => {
    const params = new URLSearchParams({
      page: String(p),
      perPage: "50",
      method: methodFilter,
      status: statusFilter,
      includeAdmin: String(showAdmin),
    });
    const res = await api.get<ListResponse<LogEntry>>(`/api/admin/logs?${params}`);
    if (res.data) {
      setEntries(res.data);
      setTotal(res.totalItems);
    }
    setLoading(false);
  }, [methodFilter, statusFilter, showAdmin]);

  useEffect(() => {
    setLoading(true);
    load(page);
  }, [page, methodFilter, statusFilter, showAdmin]);

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (!autoRefresh) return;
    intervalRef.current = setInterval(() => load(page), 2000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [autoRefresh, load, page]);

  const statusClass = (s: number) =>
    s < 300 ? "status-2xx" : s < 400 ? "status-3xx" : s < 500 ? "status-4xx" : "status-5xx";

  return (
    <>
      <Topbar
        title="Logs"
        subtitle={`${total.toLocaleString()} entries · ${autoRefresh ? "live" : "paused"}`}
        actions={
          <>
            <Dropdown
              value={methodFilter}
              options={[
                { label: "All methods", value: "all" },
                { label: "GET",    value: "GET" },
                { label: "POST",   value: "POST" },
                { label: "PATCH",  value: "PATCH" },
                { label: "DELETE", value: "DELETE" },
              ]}
              onChange={(e) => { setMethodFilter(e.value); setPage(1); }}
              style={{ height: 30, minWidth: 130, fontSize: 12 }}
            />
            <Dropdown
              value={statusFilter}
              options={[
                { label: "All status", value: "all" },
                { label: "2xx", value: "2xx" },
                { label: "4xx", value: "4xx" },
                { label: "5xx", value: "5xx" },
              ]}
              onChange={(e) => { setStatusFilter(e.value); setPage(1); }}
              style={{ height: 30, minWidth: 120, fontSize: 12 }}
            />
            <button
              className={`btn ${showAdmin ? "btn-ghost" : "btn-ghost"}`}
              onClick={() => { setShowAdmin((v) => !v); setPage(1); }}
              title={showAdmin ? "Hide admin requests" : "Show admin requests"}
              style={showAdmin ? { borderColor: "var(--accent)", color: "var(--accent-light)" } : undefined}
            >
              <Icon name="key" size={12} />
              Admin {showAdmin ? "on" : "off"}
            </button>
            <button
              className={`btn ${autoRefresh ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setAutoRefresh((v) => !v)}
            >
              <Icon name={autoRefresh ? "pause" : "play"} size={11} />
              {autoRefresh ? "Live" : "Paused"}
            </button>
          </>
        }
      />
      <div className="app-body">
        <DataTable
          value={entries}
          lazy
          paginator
          rows={50}
          totalRecords={total}
          first={(page - 1) * 50}
          onPage={(e: DataTablePageEvent) => setPage(Math.floor(e.first / 50) + 1)}
          loading={loading}
          onRowClick={(e) => setOpenLog(e.data as LogEntry)}
          selection={openLog}
          dataKey="id"
          emptyMessage="No requests logged yet. Make some API calls."
          style={{ fontSize: 13 }}
        >
          <Column
            header="Time"
            style={{ width: 90 }}
            body={(l: LogEntry) => <span className="muted mono-cell">{relativeTime(l.created_at)} ago</span>}
          />
          <Column
            header="Method"
            style={{ width: 80 }}
            body={(l: LogEntry) => <span className={`badge method-${l.method.toLowerCase()}`}>{l.method}</span>}
          />
          <Column
            header="Path"
            body={(l: LogEntry) => (
              <span className="mono-cell" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block", maxWidth: 400 }}>
                {l.path}
              </span>
            )}
          />
          <Column
            header="Status"
            style={{ width: 80 }}
            body={(l: LogEntry) => <span className={`mono-cell ${statusClass(l.status)}`} style={{ fontWeight: 500 }}>{l.status}</span>}
          />
          <Column
            header="Duration"
            style={{ width: 90, textAlign: "right" }}
            body={(l: LogEntry) => (
              <span className={`right mono-cell ${l.duration_ms > 100 ? "status-4xx" : "muted"}`}>
                {l.duration_ms}ms
              </span>
            )}
          />
        </DataTable>
      </div>

      <Drawer
        open={!!openLog}
        onClose={() => setOpenLog(null)}
        title={openLog ? `${openLog.method} ${openLog.path}` : ""}
        idLabel={openLog ? `${openLog.status} · ${openLog.duration_ms}ms` : undefined}
        footer={
          <button className="btn btn-ghost" onClick={() => setOpenLog(null)}>Close</button>
        }
      >
        {openLog && (
          <div className="col" style={{ gap: 16 }}>
            <div>
              <label className="label">Path</label>
              <div className="code-block">{openLog.path}</div>
            </div>
            <div className="row" style={{ gap: 16 }}>
              <div style={{ flex: 1 }}>
                <label className="label">Status</label>
                <div className={`mono ${statusClass(openLog.status)}`} style={{ fontSize: 13, fontWeight: 500 }}>
                  {openLog.status}
                </div>
              </div>
              <div style={{ flex: 1 }}>
                <label className="label">Duration</label>
                <div className="mono" style={{ fontSize: 13 }}>{openLog.duration_ms}ms</div>
              </div>
              <div style={{ flex: 1 }}>
                <label className="label">IP</label>
                <div className="mono muted" style={{ fontSize: 12 }}>{openLog.ip ?? "—"}</div>
              </div>
            </div>
            <div>
              <label className="label">Timestamp</label>
              <div className="code-block">{new Date(openLog.created_at * 1000).toISOString()}</div>
            </div>
          </div>
        )}
      </Drawer>
    </>
  );
}
