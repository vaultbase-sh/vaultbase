import { useCallback, useEffect, useState } from "react";
import { DataTable } from "primereact/datatable";
import { Column } from "primereact/column";
import type { DataTablePageEvent } from "primereact/datatable";
import { api, type ListResponse } from "../api.ts";
import { VbBtn, VbPageHeader } from "../components/Vb.tsx";
import { Drawer } from "../components/UI.tsx";
import Icon from "../components/Icon.tsx";

interface AuditEntry {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  method: string;
  path: string;
  action: string;
  target: string | null;
  status: number;
  ip: string | null;
  summary: string | null;
  at: number;
}

function relativeTime(ts: number): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

function statusBadge(s: number): string {
  return s < 300 ? "success" : s < 400 ? "info" : s < 500 ? "warning" : "danger";
}

export default function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [actorId, setActorId] = useState("");
  const [appliedActor, setAppliedActor] = useState("");
  const [actionPrefix, setActionPrefix] = useState("");
  const [appliedAction, setAppliedAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<AuditEntry | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), perPage: "50" });
    if (appliedActor) params.set("actorId", appliedActor);
    if (appliedAction) params.set("actionPrefix", appliedAction);
    if (from) {
      const t = Math.floor(new Date(from + "T00:00:00Z").getTime() / 1000);
      if (Number.isFinite(t)) params.set("from", String(t));
    }
    if (to) {
      const t = Math.floor(new Date(to + "T23:59:59Z").getTime() / 1000);
      if (Number.isFinite(t)) params.set("to", String(t));
    }
    const res = await api.get<{ data: ListResponse<AuditEntry> }>(`/api/v1/admin/audit-log?${params}`);
    if (res.data) {
      setEntries(res.data.data ?? []);
      setTotal(res.data.totalItems ?? 0);
    }
    setLoading(false);
  }, [page, appliedActor, appliedAction, from, to]);

  useEffect(() => { load(); }, [load]);

  function applyFilters() {
    setAppliedActor(actorId.trim());
    setAppliedAction(actionPrefix.trim());
    setPage(1);
  }
  function resetFilters() {
    setActorId(""); setAppliedActor("");
    setActionPrefix(""); setAppliedAction("");
    setFrom(""); setTo("");
    setPage(1);
  }

  return (
    <>
      <VbPageHeader
        breadcrumb={["Audit log"]}
        title="Audit log"
        sub="Append-only trail of admin API state changes — who did what, when, from where."
        right={
          <VbBtn kind="ghost" size="sm" icon="refresh" onClick={() => load()} title="Refresh">
            Refresh
          </VbBtn>
        }
      />
      <div className="app-body">
        <div className="filter-bar" style={{ flexWrap: "wrap", gap: 8 }}>
          <div
            className="input-group"
            style={{ minWidth: 200 }}
            onKeyDown={(e) => e.key === "Enter" && applyFilters()}
          >
            <Icon name="user" size={13} />
            <input
              value={actorId}
              onChange={(e) => setActorId(e.target.value)}
              placeholder="actor id (Enter)"
            />
          </div>
          <div
            className="input-group"
            style={{ minWidth: 220 }}
            onKeyDown={(e) => e.key === "Enter" && applyFilters()}
          >
            <Icon name="filter" size={13} />
            <input
              value={actionPrefix}
              onChange={(e) => setActionPrefix(e.target.value)}
              placeholder='action prefix — e.g. "collections."'
            />
          </div>
          <input
            className="input mono"
            type="date"
            value={from}
            onChange={(e) => { setFrom(e.target.value); setPage(1); }}
            style={{ height: 30, fontSize: 12, padding: "0 8px" }}
            title="From (UTC)"
          />
          <input
            className="input mono"
            type="date"
            value={to}
            onChange={(e) => { setTo(e.target.value); setPage(1); }}
            style={{ height: 30, fontSize: 12, padding: "0 8px" }}
            title="To (UTC)"
          />
          <button className="btn btn-primary" onClick={applyFilters}>Apply</button>
          {(appliedActor || appliedAction || from || to) && (
            <button className="btn btn-ghost" onClick={resetFilters}>
              <Icon name="x" size={12} />
              Clear
            </button>
          )}
          <span className="muted" style={{ marginLeft: "auto", fontSize: 11 }}>
            append-only · {total} entries
          </span>
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
          onRowClick={(e) => setOpen(e.data as AuditEntry)}
          selection={open}
          dataKey="id"
          emptyMessage="No audit entries yet. State-changing /api/v1/admin/* requests show up here."
          style={{ fontSize: 13 }}
        >
          <Column
            header="When"
            style={{ width: 90 }}
            body={(e: AuditEntry) => <span className="muted mono-cell">{relativeTime(e.at)} ago</span>}
          />
          <Column
            header="Actor"
            style={{ width: 220 }}
            body={(e: AuditEntry) => (
              e.actor_email
                ? <span className="mono-cell">{e.actor_email}</span>
                : e.actor_id
                  ? <span className="mono-cell muted">{e.actor_id.slice(0, 12)}…</span>
                  : <span className="muted" style={{ fontSize: 12 }}>anonymous</span>
            )}
          />
          <Column
            header="Action"
            body={(e: AuditEntry) => (
              <span className="mono-cell" style={{ color: "var(--accent-light)" }}>{e.action}</span>
            )}
          />
          <Column
            header="Target"
            style={{ width: 200 }}
            body={(e: AuditEntry) => (
              e.target
                ? <span className="mono-cell">{e.target}</span>
                : <span className="muted">—</span>
            )}
          />
          <Column
            header="Method"
            style={{ width: 80 }}
            body={(e: AuditEntry) => <span className={`badge method-${e.method.toLowerCase()}`}>{e.method}</span>}
          />
          <Column
            header="Status"
            style={{ width: 80 }}
            body={(e: AuditEntry) => (
              <span className={`badge ${statusBadge(e.status)}`} style={{ fontSize: 10.5 }}>{e.status}</span>
            )}
          />
        </DataTable>
        </div>
      </div>

      <Drawer
        open={!!open}
        onClose={() => setOpen(null)}
        title={open ? `${open.method} ${open.path}` : ""}
        idLabel={open ? `${open.action} · ${open.status}` : undefined}
        footer={<button className="btn btn-ghost" onClick={() => setOpen(null)}>Close</button>}
      >
        {open && (
          <div className="col" style={{ gap: 16 }}>
            <div>
              <label className="label">Action</label>
              <div className="code-block">{open.action}</div>
            </div>
            <div>
              <label className="label">Path</label>
              <div className="code-block">{open.path}</div>
            </div>
            <div className="row" style={{ gap: 16 }}>
              <div style={{ flex: 1 }}>
                <label className="label">Method</label>
                <div className="mono" style={{ fontSize: 12 }}>{open.method}</div>
              </div>
              <div style={{ flex: 1 }}>
                <label className="label">Status</label>
                <div className="mono" style={{ fontSize: 12 }}>{open.status}</div>
              </div>
              <div style={{ flex: 1 }}>
                <label className="label">Target</label>
                <div className="mono" style={{ fontSize: 12 }}>{open.target ?? "—"}</div>
              </div>
            </div>
            <div className="row" style={{ gap: 16 }}>
              <div style={{ flex: 1 }}>
                <label className="label">Actor email</label>
                <div className="mono" style={{ fontSize: 12 }}>{open.actor_email ?? "—"}</div>
              </div>
              <div style={{ flex: 1 }}>
                <label className="label">Actor id</label>
                <div className="mono muted" style={{ fontSize: 12 }}>{open.actor_id ?? "—"}</div>
              </div>
            </div>
            <div className="row" style={{ gap: 16 }}>
              <div style={{ flex: 1 }}>
                <label className="label">IP</label>
                <div className="mono muted" style={{ fontSize: 12 }}>{open.ip ?? "—"}</div>
              </div>
              <div style={{ flex: 1 }}>
                <label className="label">Timestamp</label>
                <div className="mono" style={{ fontSize: 12 }}>{new Date(open.at * 1000).toISOString()}</div>
              </div>
            </div>
            {open.summary && (
              <div>
                <label className="label">Summary</label>
                <pre className="code-block" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{open.summary}</pre>
              </div>
            )}
          </div>
        )}
      </Drawer>
    </>
  );
}
