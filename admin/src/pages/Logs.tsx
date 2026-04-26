import { useState, useEffect } from "react";
import { Topbar } from "../components/Shell.tsx";
import { Drawer } from "../components/UI.tsx";
import Icon from "../components/Icon.tsx";

interface LogEntry {
  id: number; ts: string; method: string; path: string; status: number; ms: number;
}

const MOCK_LOGS: LogEntry[] = [
  { id: 1,  ts: "12s",  method: "GET",    path: "/api/collections",              status: 200, ms: 4   },
  { id: 2,  ts: "18s",  method: "POST",   path: "/api/collections/posts",        status: 201, ms: 12  },
  { id: 3,  ts: "31s",  method: "PATCH",  path: "/api/collections/posts/rec_1",  status: 200, ms: 9   },
  { id: 4,  ts: "44s",  method: "GET",    path: "/api/collections",              status: 200, ms: 6   },
  { id: 5,  ts: "51s",  method: "POST",   path: "/api/admin/auth/login",         status: 401, ms: 24  },
  { id: 6,  ts: "1m",   method: "GET",    path: "/api/health",                   status: 200, ms: 1   },
  { id: 7,  ts: "2m",   method: "DELETE", path: "/api/collections/posts/rec_2",  status: 204, ms: 7   },
  { id: 8,  ts: "3m",   method: "GET",    path: "/api/posts?page=1&perPage=30",  status: 200, ms: 8   },
  { id: 9,  ts: "4m",   method: "PATCH",  path: "/api/collections/users/u_1",   status: 403, ms: 3   },
  { id: 10, ts: "5m",   method: "POST",   path: "/api/files/posts/rec_3/photo",  status: 201, ms: 142 },
];

export default function Logs() {
  const [openLog, setOpenLog] = useState<LogEntry | null>(null);
  const [methodFilter, setMethodFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => setTick((t) => t + 1), 2000);
    return () => clearInterval(id);
  }, [autoRefresh]);

  const statusClass = (s: number) =>
    s < 300 ? "status-2xx" : s < 400 ? "status-3xx" : s < 500 ? "status-4xx" : "status-5xx";

  const filtered = MOCK_LOGS.filter((l) => {
    if (methodFilter !== "all" && l.method !== methodFilter) return false;
    if (statusFilter === "2xx" && l.status >= 300) return false;
    if (statusFilter === "4xx" && !(l.status >= 400 && l.status < 500)) return false;
    if (statusFilter === "5xx" && l.status < 500) return false;
    return true;
  });

  return (
    <>
      <Topbar
        title="Logs"
        subtitle={`${filtered.length} entries · ${autoRefresh ? "live" : "paused"}`}
        actions={
          <>
            <select
              className="input"
              style={{ height: 30, padding: "0 10px", width: "auto", fontSize: 12 }}
              value={methodFilter}
              onChange={(e) => setMethodFilter(e.target.value)}
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
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="all">All status</option>
              <option value="2xx">2xx</option>
              <option value="4xx">4xx</option>
              <option value="5xx">5xx</option>
            </select>
            <button
              className={`btn ${autoRefresh ? "btn-primary" : "btn-ghost"}`}
              onClick={() => setAutoRefresh(!autoRefresh)}
            >
              <Icon name={autoRefresh ? "pause" : "play"} size={11} />
              {autoRefresh ? "Live" : "Paused"}
            </button>
          </>
        }
      />
      <div className="app-body">
        <div style={{ marginBottom: 12, padding: "10px 14px", background: "rgba(251,191,36,0.08)", border: "0.5px solid rgba(251,191,36,0.25)", borderRadius: 8, fontSize: 12, color: "var(--warning)" }}>
          <Icon name="info" size={13} style={{ marginRight: 8, verticalAlign: "middle" }} />
          Request logging not yet implemented. Showing sample data.
        </div>
        <div className="table-wrap">
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
              {filtered.map((l) => (
                <tr
                  key={l.id}
                  className={openLog?.id === l.id ? "selected" : ""}
                  onClick={() => setOpenLog(l)}
                >
                  <td className="muted mono-cell">{l.ts} ago</td>
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
                  <td className={`right mono-cell ${l.ms > 100 ? "status-4xx" : "muted"}`}>
                    {l.ms}ms
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Drawer
        open={!!openLog}
        onClose={() => setOpenLog(null)}
        title={openLog ? `${openLog.method} request` : ""}
        idLabel={openLog ? `${openLog.status} · ${openLog.ms}ms` : undefined}
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
                <div className="mono" style={{ fontSize: 13 }}>{openLog.ms}ms</div>
              </div>
            </div>
          </div>
        )}
      </Drawer>
    </>
  );
}
