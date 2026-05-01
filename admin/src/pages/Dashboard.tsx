import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type ApiResponse, type Collection } from "../api.ts";
import { Topbar, PageHeader } from "../components/Shell.tsx";
import Icon from "../components/Icon.tsx";

interface QueueStat {
  queue: string;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  dead: number;
}

interface JobLogRow {
  id: string;
  queue: string;
  status: "queued" | "running" | "succeeded" | "failed" | "dead";
  attempt: number;
  error: string | null;
  enqueued_at: number;
  finished_at: number | null;
}

function relTime(sec: number | null): string {
  if (!sec) return "—";
  const d = Math.floor(Date.now() / 1000) - sec;
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [stats, setStats] = useState<QueueStat[]>([]);
  const [deadJobs, setDeadJobs] = useState<JobLogRow[]>([]);

  useEffect(() => {
    void Promise.all([
      api.get<ApiResponse<Collection[]>>("/api/v1/collections"),
      api.get<ApiResponse<QueueStat[]>>("/api/v1/admin/queues/stats"),
      api.get<{ data: JobLogRow[] }>("/api/v1/admin/queues/jobs?status=dead&perPage=5"),
    ]).then(([c, s, d]) => {
      if (c.data) setCollections(c.data);
      if (s.data) setStats(s.data);
      setDeadJobs(d.data ?? []);
    });
  }, []);

  const totalQueued = stats.reduce((a, s) => a + s.queued, 0);
  const totalRunning = stats.reduce((a, s) => a + s.running, 0);
  const totalDead = stats.reduce((a, s) => a + s.dead, 0);
  const totalSucceeded = stats.reduce((a, s) => a + s.succeeded, 0);

  const broken = totalDead > 0 || deadJobs.length > 0;

  return (
    <>
      <Topbar crumbs={[{ label: "Dashboard" }]} />
      <div className="app-body">
        <PageHeader
          title="Dashboard"
          subtitle={broken ? `${totalDead} dead jobs` : "All systems nominal"}
        />

        {broken && (
          <div className="cal dn" style={{ marginBottom: 20 }}>
            <Icon name="alert" size={14} />
            <div>
              <strong>{totalDead} jobs in dead-letter.</strong>{" "}
              Inspect and retry from{" "}
              <a onClick={() => navigate("/_/hooks")} style={{ color: "var(--accent-light)", cursor: "pointer" }}>
                Hooks → Jobs log
              </a>.
            </div>
          </div>
        )}

        <div className="dash-stats">
          <div className="stat-tile">
            <div className="lbl">Collections</div>
            <div className="val">{collections.length}</div>
            <div className="delta" style={{ color: "var(--text-tertiary)" }}>
              {collections.filter((c) => c.type === "auth").length} auth ·{" "}
              {collections.filter((c) => c.type === "view").length} view
            </div>
          </div>
          <div className="stat-tile">
            <div className="lbl">Queued</div>
            <div className="val" style={{ color: totalQueued > 0 ? "var(--accent-light)" : "var(--text-primary)" }}>
              {totalQueued}
            </div>
            <div className="delta" style={{ color: "var(--text-tertiary)" }}>
              {totalRunning} running
            </div>
          </div>
          <div className="stat-tile">
            <div className="lbl">Succeeded</div>
            <div className="val">{totalSucceeded.toLocaleString()}</div>
            <div className="delta up">all-time</div>
          </div>
          <div className="stat-tile">
            <div className="lbl">Dead-letter</div>
            <div className="val" style={{ color: totalDead > 0 ? "#ff7b7b" : "var(--text-primary)" }}>
              {totalDead}
            </div>
            <div className={`delta ${totalDead > 0 ? "down" : ""}`}>
              {totalDead > 0 ? "needs attention" : "clean"}
            </div>
          </div>
        </div>

        <div className="dash-grid">
          <div className="editor-card">
            <div className="editor-card-head">
              <h3>Recent dead jobs</h3>
              <span className="meta">{deadJobs.length} of last {deadJobs.length}</span>
            </div>
            {deadJobs.length === 0 ? (
              <div className="empty-state">
                <div className="ic"><Icon name="check" size={20} /></div>
                <h4>No dead jobs</h4>
                <p>Background workers haven't blown up. Tick.</p>
              </div>
            ) : (
              <div>
                {deadJobs.map((j) => (
                  <div
                    key={j.id}
                    style={{
                      padding: "10px 14px",
                      borderBottom: "1px solid var(--border-subtle)",
                      display: "flex",
                      gap: 10,
                      alignItems: "flex-start",
                      cursor: "pointer",
                    }}
                    onClick={() => navigate("/_/hooks")}
                  >
                    <span className="badge danger" style={{ fontSize: 10.5 }}>dead</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="mono" style={{ fontSize: 12, color: "var(--text-primary)" }}>
                        {j.queue} · {j.id.slice(0, 12)}…
                      </div>
                      <div className="muted mono" style={{ fontSize: 11, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {j.error?.split("\n")[0] ?? "—"}
                      </div>
                    </div>
                    <span className="muted mono" style={{ fontSize: 11 }}>
                      {relTime(j.finished_at ?? j.enqueued_at)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="editor-card">
            <div className="editor-card-head">
              <h3>Per-queue backlog</h3>
              <span className="meta">{stats.length} {stats.length === 1 ? "queue" : "queues"}</span>
            </div>
            {stats.length === 0 ? (
              <div className="empty-state">
                <div className="ic"><Icon name="zap" size={20} /></div>
                <h4>No workers configured</h4>
                <p>
                  Workers process jobs from named queues. Define one in{" "}
                  <span className="mono">Hooks → Workers</span>.
                </p>
                <div className="row">
                  <button className="btn btn-primary" onClick={() => navigate("/_/hooks")}>
                    Open Hooks
                  </button>
                </div>
              </div>
            ) : (
              <div>
                {stats.map((s) => (
                  <div
                    key={s.queue}
                    style={{
                      padding: "10px 14px",
                      borderBottom: "1px solid var(--border-subtle)",
                      display: "flex",
                      gap: 12,
                      alignItems: "center",
                    }}
                  >
                    <span className="mono" style={{ fontSize: 12.5, color: "var(--text-primary)", minWidth: 100 }}>
                      {s.queue}
                    </span>
                    <span style={{ display: "inline-flex", gap: 12, fontFamily: "var(--font-mono)", fontSize: 11, flex: 1 }}>
                      <span style={{ color: "var(--accent-light)" }}>{s.queued}q</span>
                      <span style={{ color: "var(--warning)" }}>{s.running}r</span>
                      <span style={{ color: "#4ade80" }}>{s.succeeded}✓</span>
                      <span style={{ color: "#ff7b7b" }}>{s.dead}☠</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="editor-card" style={{ marginTop: 20 }}>
          <div className="editor-card-head">
            <h3>Top collections</h3>
            <span className="meta">{collections.length} total</span>
          </div>
          {collections.length === 0 ? (
            <div className="empty-state">
              <div className="ic"><Icon name="database" size={20} /></div>
              <h4>No collections yet</h4>
              <p>Create your first collection to start modeling data.</p>
              <div className="row">
                <button className="btn btn-primary" onClick={() => navigate("/_/collections")}>
                  Open Collections
                </button>
              </div>
            </div>
          ) : (
            <div className="dash-coll-grid">
              {collections.slice(0, 8).map((c) => (
                <a
                  key={c.id}
                  onClick={() => navigate(`/_/collections/${c.id}/records`)}
                  className="dash-coll"
                >
                  <span className="mono name">{c.name}</span>
                  <span className={`badge ${c.type ?? "base"}`} style={{ fontSize: 10.5 }}>
                    {c.type ?? "base"}
                  </span>
                </a>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
