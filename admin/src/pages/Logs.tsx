import { useCallback, useEffect, useRef, useState } from "react";
import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import type { DataTablePageEvent } from "primereact/datatable";
import { Dropdown } from "primereact/dropdown";
import { api, type ListResponse } from "../api.ts";
import { VbBtn, VbCode, VbField, VbInput, VbPageHeader, VbTabs, type VbTab } from "../components/Vb.tsx";
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
  const [ruleOutcomeFilter, setRuleOutcomeFilter] = useState<"all" | "any" | "allow" | "deny" | "filter">("all");
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
    if (ruleOutcomeFilter !== "all") params.set("ruleOutcome", ruleOutcomeFilter);
    const res = await api.get<ListResponse<LogEntry>>(`/api/v1/admin/logs?${params}`);
    if (res.data) {
      setEntries(res.data);
      setTotal(res.totalItems);
    }
    setLoading(false);
  }, [methodFilter, statusFilter, showAdmin, appliedSearch, minDuration, ruleOutcomeFilter]);

  useEffect(() => {
    setLoading(true);
    load(page);
  }, [page, load]);

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

  const statusBadgeClass = (s: number): string =>
    s < 300 ? "success" : s < 400 ? "info" : s < 500 ? "warning" : "danger";

  return (
    <>
      <VbPageHeader
        breadcrumb={["Logs"]}
        title="Logs"
        sub="Every request, with how its rules decided. JSONPath search over the log files."
        right={
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
            <Dropdown
              value={ruleOutcomeFilter}
              options={[
                { label: "All rules",       value: "all"    },
                { label: "Any rule eval",   value: "any"    },
                { label: "Rule allow",      value: "allow"  },
                { label: "Rule deny",       value: "deny"   },
                { label: "Rule filter",     value: "filter" },
              ]}
              onChange={(e) => { setRuleOutcomeFilter(e.value); setPage(1); }}
              style={{ height: 30, minWidth: 150, fontSize: 12 }}
              title="Filter by per-request rule evaluation outcome"
            />
            <VbBtn
              kind="ghost"
              size="sm"
              icon="key"
              onClick={() => { setShowAdmin((v) => !v); setPage(1); }}
              title={showAdmin ? "Hide admin requests" : "Show admin requests"}
              style={showAdmin ? { borderColor: "var(--vb-accent)", color: "var(--vb-accent)" } : undefined}
            >
              Admin {showAdmin ? "on" : "off"}
            </VbBtn>
            <VbBtn
              kind={autoRefresh ? "primary" : "ghost"}
              size="sm"
              icon={autoRefresh ? "pause" : "play"}
              onClick={() => setAutoRefresh((v) => !v)}
            >
              {autoRefresh ? "Live" : "Paused"}
            </VbBtn>
          </>
        }
      />
      <VbTabs<"live" | "search">
        tabs={[
          { id: "live",   label: "Recent",          icon: "activity" },
          { id: "search", label: "JSONPath search", icon: "search" },
        ] as VbTab<"live" | "search">[]}
        active={mode}
        onChange={setMode}
        rightSlot={
          <span style={{ fontSize: 10.5, color: "var(--vb-fg-3)", fontFamily: "var(--font-mono)" }}>
            file logs: <code style={{
              fontFamily: "var(--font-mono)", fontSize: "0.92em",
              padding: "1px 5px", borderRadius: 3,
              background: "var(--vb-code-bg)", color: "var(--vb-code-fg)",
            }}>data_dir/logs/&lt;date&gt;.jsonl</code>
          </span>
        }
      />
      {mode === "search" ? (
        <LogSearchPanel />
      ) : (
      <div className="app-body">
        <div className="filter-bar">
          <div
            style={{ flex: 1, maxWidth: 480, position: "relative", display: "flex", alignItems: "center" }}
            onKeyDown={(e) => e.key === "Enter" && (setAppliedSearch(search), setPage(1))}
          >
            <span style={{ position: "absolute", left: 10, display: "flex", color: "var(--vb-fg-3)" }}><Icon name="search" size={13} /></span>
            <VbInput
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search path, hook, event or message, then Enter"
              style={{ paddingLeft: 30, paddingRight: appliedSearch ? 30 : 10 }}
            />
            {appliedSearch && (
              <button
                style={{ position: "absolute", right: 8, display: "flex", background: "none", border: "none", cursor: "pointer", color: "var(--vb-fg-3)", padding: 0 }}
                onClick={() => { setSearch(""); setAppliedSearch(""); setPage(1); }}
                title="Clear search"
              >
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
          <div className="right" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: "var(--vb-fg-3)" }}>min duration:</span>
            <VbInput
              mono
              style={{ width: 80 }}
              type="number"
              min={0}
              value={minDuration}
              onChange={(e) => { setMinDuration(e.target.value); setPage(1); }}
              placeholder="0"
            />
            <span style={{ fontSize: 11, color: "var(--vb-fg-3)" }}>ms</span>
          </div>
        </div>
        <div className="vb-pr-table">
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
          emptyMessage={methodFilter !== "all" || statusFilter !== "all" || ruleOutcomeFilter !== "all" || appliedSearch || parseInt(minDuration) > 0
            ? "No requests match these filters."
            : "No requests logged yet. Make some API calls."}
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
            style={{ width: 90 }}
            body={(l: LogEntry) => (
              <span className={`badge ${statusBadgeClass(l.status)}`} style={{ fontSize: 10.5 }}>
                {l.status}
              </span>
            )}
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
      </div>
      )}

      <Drawer
        open={!!openLog}
        onClose={() => setOpenLog(null)}
        title={openLog ? `${openLog.method} ${openLog.path}` : ""}
        idLabel={openLog ? `${openLog.status} · ${openLog.duration_ms}ms` : undefined}
        footer={
          <VbBtn kind="ghost" onClick={() => setOpenLog(null)}>Close</VbBtn>
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
    api.get<{ data: LogFile[] }>("/api/v1/admin/logs/files").then((res) => {
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
    const res = await api.post<SearchPayload>("/api/v1/admin/logs/search", body);
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
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Panel title="Query" meta="JSONPath over the log files">
        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 160 }}>
              <VbField label="From (UTC date)">
                <VbInput mono type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </VbField>
            </div>
            <div style={{ flex: 1, minWidth: 160 }}>
              <VbField label="To (UTC date)">
                <VbInput mono type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </VbField>
            </div>
          </div>
          <VbField
            label="JSONPath expression"
            hint={<>Each log entry is one document. Examples:{" "}
              <VbCode>$[?(@.status &gt;= 500)]</VbCode>, <VbCode>$[?(@.path =~ /api\/users/)]</VbCode>, <VbCode>$.auth_email</VbCode></>}
          >
            <VbInput
              mono
              value={jsonpath}
              onChange={(e) => setJsonpath(e.target.value)}
              placeholder="$[?(@.status >= 400)]"
              onKeyDown={(e) => { if (e.key === "Enter") run(); }}
            />
          </VbField>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 11, color: "var(--vb-fg-3)" }}>
              {files.length} log file{files.length === 1 ? "" : "s"} · {fmtSize(files.reduce((a, f) => a + f.size, 0))} total
            </span>
            <VbBtn kind="primary" size="sm" icon="play" onClick={run} disabled={running || !jsonpath.trim()}>
              {running ? "Running…" : "Run query"}
            </VbBtn>
          </div>
        </div>
      </Panel>

      {err && (
        <div style={{ padding: "10px 14px", borderRadius: 6, border: "1px solid var(--vb-status-danger)", background: "var(--vb-status-danger-bg)", color: "var(--vb-status-danger)", fontSize: 12 }}>
          {err}
        </div>
      )}

      {result && (
        <Panel
          title="Results"
          meta={<>{result.matched} matched · {result.scanned} scanned{result.results.length < result.matched && ` · showing the newest ${result.results.length}`}</>}
        >
          {result.results.length === 0 ? (
            <div style={{ fontSize: 12, color: "var(--vb-fg-3)" }}>No matches.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {result.results.map((hit, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 8 }}>
                  <VbField label="Entry">
                    <pre style={PRE}>{JSON.stringify(hit.entry, null, 2)}</pre>
                  </VbField>
                  <VbField label="Matched values">
                    <pre style={PRE}>{JSON.stringify(hit.matches, null, 2)}</pre>
                  </VbField>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}

      <Panel title="Log files" meta="one file per day · kept for the request-log retention in Settings → Data retention">
        {files.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--vb-fg-3)" }}>No log files yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {files.map((f) => (
              <div key={f.date} style={{ display: "flex", gap: 12, padding: "6px 0", borderBottom: "1px solid var(--vb-border)" }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, minWidth: 130, color: "var(--vb-fg)" }}>{f.date}.jsonl</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vb-fg-3)" }}>{fmtSize(f.size)}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
      </div>
    </div>
  );
}

const PRE: React.CSSProperties = {
  margin: 0, maxHeight: 180, overflow: "auto", padding: 10, borderRadius: 6,
  background: "var(--vb-bg-1)", border: "1px solid var(--vb-border)",
  fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vb-fg)",
};

function Panel({ title, meta, children }: { title: string; meta?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ background: "var(--vb-bg-2)", border: "1px solid var(--vb-border)", borderRadius: 8, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--vb-border)", background: "var(--vb-bg-1)" }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: "var(--vb-fg)" }}>{title}</h3>
        {meta && <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vb-fg-3)" }}>{meta}</span>}
      </div>
      <div style={{ padding: 16 }}>{children}</div>
    </div>
  );
}
