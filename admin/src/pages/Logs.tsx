import { useCallback, useEffect, useRef, useState } from "react";
import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import type { DataTablePageEvent } from "primereact/datatable";
import { Dropdown } from "primereact/dropdown";
import { api, type ListResponse } from "../api.ts";
import { Topbar } from "../components/Shell.tsx";
import { Drawer } from "../components/UI.tsx";
import Icon from "../components/Icon.tsx";

interface LogRuleEval {
  rule: string;
  collection: string;
  expression: string | null;
  outcome: "allow" | "deny" | "filter";
  reason: string;
}

interface LogEntry {
  id: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  ip: string | null;
  auth_id: string | null;
  auth_type: "user" | "admin" | null;
  auth_email: string | null;
  created_at: number;
  rules?: LogRuleEval[];
  kind?: "request" | "hook";
  message?: string;
  hook_collection?: string;
  hook_event?: string;
  hook_name?: string;
}

function relativeTime(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

type LogMode = "live" | "search";

interface LogFile { date: string; size: number }
interface SearchHit { entry: LogEntry; matches: unknown[] }
interface SearchPayload {
  data: { matched: number; scanned: number; results: SearchHit[] };
  error?: string;
}

export default function Logs() {
  const [mode, setMode] = useState<LogMode>("live");
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [methodFilter, setMethodFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [showAdmin, setShowAdmin] = useState(false);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [minDuration, setMinDuration] = useState("0");
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
    if (appliedSearch) params.set("search", appliedSearch);
    if (minDuration && parseInt(minDuration) > 0) params.set("minDuration", minDuration);
    const res = await api.get<ListResponse<LogEntry>>(`/api/admin/logs?${params}`);
    if (res.data) {
      setEntries(res.data);
      setTotal(res.totalItems);
    }
    setLoading(false);
  }, [methodFilter, statusFilter, showAdmin, appliedSearch, minDuration]);

  useEffect(() => {
    setLoading(true);
    load(page);
  }, [page, methodFilter, statusFilter, showAdmin, appliedSearch, minDuration]);

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
                { label: "HOOK",   value: "HOOK" },
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
      <div className="tabs" style={{ paddingLeft: 20 }}>
        <div className={`tab ${mode === "live" ? "active" : ""}`} onClick={() => setMode("live")}>
          <Icon name="activity" size={12} /> Recent
        </div>
        <div className={`tab ${mode === "search" ? "active" : ""}`} onClick={() => setMode("search")}>
          <Icon name="search" size={12} /> JSONPath search
        </div>
        <span style={{ marginLeft: "auto", alignSelf: "center", fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          file logs: <code>data_dir/logs/&lt;date&gt;.jsonl</code>
        </span>
      </div>
      {mode === "search" ? (
        <LogSearchPanel />
      ) : (
      <div className="app-body">
        <div className="filter-bar">
          <div
            className="input-group"
            style={{ flex: 1, maxWidth: 480 }}
            onKeyDown={(e) => e.key === "Enter" && (setAppliedSearch(search), setPage(1))}
          >
            <Icon name="search" size={13} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="search path / hook name / event / message — press Enter"
            />
            {appliedSearch && (
              <button
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 0 }}
                onClick={() => { setSearch(""); setAppliedSearch(""); setPage(1); }}
                title="Clear search"
              >
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
          <div className="right" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>min duration:</span>
            <input
              className="input mono"
              style={{ width: 80, height: 30, fontSize: 12, padding: "0 8px" }}
              type="number"
              min={0}
              value={minDuration}
              onChange={(e) => { setMinDuration(e.target.value); setPage(1); }}
              placeholder="0"
            />
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>ms</span>
          </div>
        </div>
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
            header="Path / Message"
            body={(l: LogEntry) => {
              const ruleDeny = l.rules?.some((r) => r.outcome === "deny");
              const ruleCount = l.rules?.length ?? 0;
              return (
                <span className="mono-cell" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block", maxWidth: 500 }}>
                  {l.kind === "hook" ? (
                    <>
                      <span style={{ color: "var(--accent-light)" }}>{l.path}</span>
                      {l.message && <span className="muted" style={{ marginLeft: 8 }}>· {l.message}</span>}
                    </>
                  ) : l.path}
                  {ruleCount > 0 && (
                    <span
                      title={`${ruleCount} rule${ruleCount === 1 ? "" : "s"} evaluated${ruleDeny ? " — denied by rule" : ""}`}
                      style={{
                        marginLeft: 8,
                        fontSize: 10,
                        padding: "1px 6px",
                        borderRadius: 8,
                        background: ruleDeny ? "rgba(248,113,113,0.12)" : "rgba(255,255,255,0.06)",
                        color: ruleDeny ? "var(--danger)" : "var(--text-muted)",
                      }}
                    >
                      {ruleDeny ? "rule deny" : `${ruleCount} rule${ruleCount === 1 ? "" : "s"}`}
                    </span>
                  )}
                </span>
              );
            }}
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
      )}

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
              <label className="label">{openLog.kind === "hook" ? "Hook" : "Path"}</label>
              <div className="code-block">{openLog.path}</div>
            </div>
            {openLog.kind === "hook" && (
              <>
                <div className="row" style={{ gap: 16 }}>
                  <div style={{ flex: 1 }}>
                    <label className="label">Hook name</label>
                    <div className="mono" style={{ fontSize: 12 }}>
                      {openLog.hook_name || <span className="muted">(unnamed)</span>}
                    </div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <label className="label">Event</label>
                    <div className="mono" style={{ fontSize: 12 }}>{openLog.hook_event || "—"}</div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <label className="label">Collection</label>
                    <div className="mono" style={{ fontSize: 12 }}>{openLog.hook_collection || <span className="muted">(global)</span>}</div>
                  </div>
                </div>
                {openLog.message && (
                  <div>
                    <label className="label">Message</label>
                    <div className="code-block">{openLog.message}</div>
                  </div>
                )}
              </>
            )}
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
              <label className="label">Authenticated as</label>
              {openLog.auth_id ? (
                <div className="row" style={{ gap: 8, alignItems: "center" }}>
                  <span className={`badge ${openLog.auth_type === "admin" ? "auth" : "base"}`}>
                    {openLog.auth_type}
                  </span>
                  <span className="mono" style={{ fontSize: 12 }}>
                    {openLog.auth_email ?? openLog.auth_id.slice(0, 12) + "…"}
                  </span>
                  <span className="muted mono" style={{ fontSize: 11 }}>
                    {openLog.auth_id.slice(0, 12)}…
                  </span>
                </div>
              ) : (
                <div className="muted" style={{ fontSize: 12 }}>Anonymous</div>
              )}
            </div>
            <div>
              <label className="label">Timestamp</label>
              <div className="code-block">{new Date(openLog.created_at * 1000).toISOString()}</div>
            </div>
            {openLog.rules && openLog.rules.length > 0 && (
              <div>
                <label className="label">Rule evaluation ({openLog.rules.length})</label>
                <div className="col" style={{ gap: 6, marginTop: 4 }}>
                  {openLog.rules.map((r, i) => (
                    <div
                      key={i}
                      style={{
                        border: "0.5px solid var(--border-default)",
                        borderRadius: 6,
                        padding: "8px 10px",
                        background: "rgba(255,255,255,0.02)",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                        <span
                          className="mono"
                          style={{ fontSize: 11, color: "var(--text-secondary)" }}
                        >
                          {r.collection}.{r.rule}
                        </span>
                        <span
                          style={{
                            fontSize: 10,
                            padding: "1px 7px",
                            borderRadius: 8,
                            background:
                              r.outcome === "allow" ? "rgba(74,222,128,0.12)"
                              : r.outcome === "deny"  ? "rgba(248,113,113,0.12)"
                              : "rgba(168,176,255,0.12)",
                            color:
                              r.outcome === "allow" ? "var(--success)"
                              : r.outcome === "deny"  ? "var(--danger)"
                              : "var(--accent-light)",
                          }}
                        >
                          {r.outcome}
                        </span>
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{r.reason}</span>
                      </div>
                      <div
                        className="mono"
                        style={{
                          fontSize: 11,
                          color: r.expression ? "var(--text-primary)" : "var(--text-muted)",
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                        }}
                      >
                        {r.expression === null ? "(public — no rule set)"
                          : r.expression === ""   ? "(admin only — empty rule)"
                          : r.expression}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Drawer>
    </>
  );
}

function LogSearchPanel() {
  const [files, setFiles] = useState<LogFile[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [jsonpath, setJsonpath] = useState('$[?(@.status >= 400)]');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ matched: number; scanned: number; results: SearchHit[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ data: LogFile[] }>("/api/admin/logs/files").then((res) => {
      if (res.data) setFiles(res.data);
    });
  }, []);

  async function run() {
    setRunning(true);
    setErr(null);
    setResult(null);
    const body: { jsonpath: string; from?: string; to?: string; limit: number } = {
      jsonpath,
      limit: 500,
    };
    if (from) body.from = from;
    if (to) body.to = to;
    const res = await api.post<SearchPayload>("/api/admin/logs/search", body);
    setRunning(false);
    if (res.error) { setErr(res.error); return; }
    if (res.data) setResult(res.data);
  }

  function fmtSize(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  return (
    <div className="app-body">
      <div className="editor-card" style={{ marginBottom: 16 }}>
        <div className="editor-card-head">
          <h3>Query</h3>
          <span className="meta">JSONPath against JSONL files</span>
        </div>
        <div style={{ padding: 14, display: "grid", gap: 12 }}>
          <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 160 }}>
              <label className="label">From (UTC date)</label>
              <input
                className="input mono"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div style={{ flex: 1, minWidth: 160 }}>
              <label className="label">To (UTC date)</label>
              <input
                className="input mono"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </div>
          <div>
            <label className="label">JSONPath expression</label>
            <input
              className="input mono"
              value={jsonpath}
              onChange={(e) => setJsonpath(e.target.value)}
              placeholder='$[?(@.status >= 400)]'
              onKeyDown={(e) => { if (e.key === "Enter") run(); }}
            />
            <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
              Each log entry is one document. Examples:{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>$[?(@.status &gt;= 500)]</code>,{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>$[?(@.path =~ /api\/users/)]</code>,{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>$.auth_email</code>
            </div>
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="muted" style={{ fontSize: 11 }}>
              {files.length} log file{files.length === 1 ? "" : "s"} ·{" "}
              {fmtSize(files.reduce((a, f) => a + f.size, 0))} total
            </span>
            <button className="btn btn-primary" onClick={run} disabled={running || !jsonpath.trim()}>
              {running ? "Running…" : "Run query"}
            </button>
          </div>
        </div>
      </div>

      {err && (
        <div className="editor-card" style={{ borderColor: "rgba(248,113,113,0.3)" }}>
          <div style={{ padding: 14, color: "var(--danger)", fontSize: 12 }}>{err}</div>
        </div>
      )}

      {result && (
        <div className="editor-card">
          <div className="editor-card-head">
            <h3>Results</h3>
            <span className="meta">
              {result.matched} matched · {result.scanned} scanned
            </span>
          </div>
          {result.results.length === 0 ? (
            <div className="empty">No matches</div>
          ) : (
            <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
              {result.results.map((hit, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div>
                    <label className="label">Entry</label>
                    <pre className="code-block" style={{ margin: 0, maxHeight: 180 }}>
                      {JSON.stringify(hit.entry, null, 2)}
                    </pre>
                  </div>
                  <div>
                    <label className="label">Matched values</label>
                    <pre className="code-block" style={{ margin: 0, maxHeight: 180 }}>
                      {JSON.stringify(hit.matches, null, 2)}
                    </pre>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="editor-card" style={{ marginTop: 16 }}>
        <div className="editor-card-head">
          <h3>Available log files</h3>
          <span className="meta">date-rotated, append-only, never deleted</span>
        </div>
        <div style={{ padding: 12 }}>
          {files.length === 0 ? (
            <div className="empty">No log files yet</div>
          ) : (
            <div className="col" style={{ gap: 4 }}>
              {files.map((f) => (
                <div key={f.date} className="row" style={{ gap: 12, padding: "6px 0", borderBottom: "0.5px solid rgba(255,255,255,0.04)" }}>
                  <span className="mono" style={{ fontSize: 12, minWidth: 110 }}>{f.date}.jsonl</span>
                  <span className="muted mono" style={{ fontSize: 11 }}>{fmtSize(f.size)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
