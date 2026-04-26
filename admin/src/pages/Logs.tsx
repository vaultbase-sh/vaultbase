import { useCallback, useEffect, useRef, useState } from "react";
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
            <select
              className="input"
              style={{ height: 30, padding: "0 10px", width: "auto", fontSize: 12 }}
              value={methodFilter}
              onChange={(e) => { setMethodFilter(e.target.value); setPage(1); }}
            >
              <option value="all">All methods</option>
              {["GET", "POST", "PATCH", "DELETE"].map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <select
              className="input"
              style={{ height: 30, padding: "0 10px", width: "auto", fontSize: 12 }}
              value={statusFilter}
              onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
            >
              <option value="all">All status</option>
              <option value="2xx">2xx</option>
              <option value="4xx">4xx</option>
              <option value="5xx">5xx</option>
            </select>
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
        <div className="table-wrap">
          {loading ? (
            <div className="empty">Loading…</div>
          ) : entries.length === 0 ? (
            <div className="empty">No requests logged yet. Make some API calls.</div>
          ) : (
            <>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 90 }}>Time</th>
                    <th style={{ width: 80 }}>Method</th>
                    <th>Path</th>
                    <th style={{ width: 80 }}>Status</th>
                    <th className="right" style={{ width: 90 }}>Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((l) => (
                    <tr
                      key={l.id}
                      className={openLog?.id === l.id ? "selected" : ""}
                      onClick={() => setOpenLog(l)}
                    >
                      <td className="muted mono-cell">{relativeTime(l.created_at)} ago</td>
                      <td>
                        <span className={`badge method-${l.method.toLowerCase()}`}>{l.method}</span>
                      </td>
                      <td
                        className="mono-cell"
                        style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 0 }}
                      >
                        {l.path}
                      </td>
                      <td className={`mono-cell ${statusClass(l.status)}`} style={{ fontWeight: 500 }}>
                        {l.status}
                      </td>
                      <td className={`right mono-cell ${l.duration_ms > 100 ? "status-4xx" : "muted"}`}>
                        {l.duration_ms}ms
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="pagination">
                <span>
                  {(page - 1) * 50 + 1}–{Math.min(page * 50, total)} of {total.toLocaleString()}
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
                    disabled={entries.length < 50}
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
