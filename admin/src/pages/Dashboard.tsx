import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type ApiResponse, type Collection } from "../api.ts";
import { VbBtn, VbEmptyState, VbPageHeader, VbPill, BigStat } from "../components/Vb.tsx";
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

const COLL_TYPE_TONE: Record<string, "neutral" | "accent" | "warning"> = {
  base: "neutral",
  auth: "accent",
  view: "warning",
};

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
      <VbPageHeader
        breadcrumb={["Dashboard"]}
        title="Dashboard"
        sub="At-a-glance health of the running instance — collections, queues, recent activity."
        right={
          <VbPill tone={broken ? "danger" : "success"} dot>
            {broken ? `${totalDead} dead jobs` : "all systems nominal"}
          </VbPill>
        }
      />
      <div className="app-body">
        {broken && (
          <DashAlert onClick={() => navigate("/_/hooks")}>
            <strong>{totalDead} jobs in dead-letter.</strong>{" "}
            Inspect and retry from <span style={{ color: "var(--vb-accent)" }}>Hooks → Jobs log</span>.
          </DashAlert>
        )}

        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 12,
          marginBottom: 20,
          border: "1px solid var(--vb-border)",
          borderRadius: 8,
          overflow: "hidden",
        }}>
          <BigStat
            label="Collections"
            value={collections.length}
          />
          <BigStat
            label="Queued"
            value={totalQueued}
          />
          <BigStat
            label="Succeeded"
            value={totalSucceeded.toLocaleString()}
          />
          <BigStat
            label="Dead-letter"
            value={totalDead}
            tone={totalDead > 0 ? "danger" : null}
          />
        </div>

        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
          gap: 16,
          marginBottom: 16,
        }}>
          <DashCard title="Recent dead jobs" meta={`${deadJobs.length} of last ${deadJobs.length}`}>
            {deadJobs.length === 0 ? (
              <VbEmptyState icon="check" title="No dead jobs" body="Background workers haven't blown up. Tick." />
            ) : (
              <div>
                {deadJobs.map((j, i) => (
                  <div
                    key={j.id}
                    onClick={() => navigate("/_/hooks")}
                    style={{
                      padding: "12px 16px",
                      borderBottom: i === deadJobs.length - 1 ? "none" : "1px solid var(--vb-border)",
                      display: "flex",
                      gap: 12,
                      alignItems: "flex-start",
                      cursor: "pointer",
                      transition: "background 100ms",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--vb-bg-3)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    <VbPill tone="danger" dot>dead</VbPill>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--vb-fg)" }}>
                        {j.queue} · {j.id.slice(0, 12)}…
                      </div>
                      <div style={{
                        fontFamily: "var(--font-mono)",
                        fontSize: 11,
                        color: "var(--vb-fg-3)",
                        marginTop: 2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}>
                        {j.error?.split("\n")[0] ?? "—"}
                      </div>
                    </div>
                    <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--vb-fg-3)" }}>
                      {relTime(j.finished_at ?? j.enqueued_at)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </DashCard>

          <DashCard title="Per-queue backlog" meta={`${stats.length} ${stats.length === 1 ? "queue" : "queues"}`}>
            {stats.length === 0 ? (
              <VbEmptyState
                icon="zap"
                title="No workers configured"
                body={<>Workers process jobs from named queues. Define one in <span style={{ fontFamily: "var(--font-mono)", color: "var(--vb-fg-2)" }}>Hooks → Workers</span>.</>}
                actions={<VbBtn kind="primary" size="sm" icon="zap" onClick={() => navigate("/_/hooks")}>Open Hooks</VbBtn>}
              />
            ) : (
              <div>
                {stats.map((s, i) => (
                  <div
                    key={s.queue}
                    style={{
                      padding: "12px 16px",
                      borderBottom: i === stats.length - 1 ? "none" : "1px solid var(--vb-border)",
                      display: "flex",
                      gap: 14,
                      alignItems: "center",
                    }}
                  >
                    <span style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 12.5,
                      color: "var(--vb-fg)",
                      minWidth: 100,
                    }}>{s.queue}</span>
                    <span style={{
                      display: "inline-flex",
                      gap: 14,
                      fontFamily: "var(--font-mono)",
                      fontSize: 11.5,
                      flex: 1,
                    }}>
                      <span style={{ color: "var(--vb-accent)" }}>{s.queued}q</span>
                      <span style={{ color: "var(--vb-status-warning)" }}>{s.running}r</span>
                      <span style={{ color: "var(--vb-status-success)" }}>{s.succeeded}✓</span>
                      <span style={{ color: "var(--vb-status-danger)" }}>{s.dead}☠</span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </DashCard>
        </div>

        <DashCard title="Top collections" meta={`${collections.length} total`}>
          {collections.length === 0 ? (
            <VbEmptyState
              icon="database"
              title="No collections yet"
              body="Create your first collection to start modeling data."
              actions={<VbBtn kind="primary" size="sm" icon="plus" onClick={() => navigate("/_/collections")}>Open Collections</VbBtn>}
            />
          ) : (
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
              gap: 8,
              padding: 12,
            }}>
              {collections.slice(0, 8).map((c) => {
                const t = c.type ?? "base";
                return (
                  <button
                    key={c.id}
                    onClick={() => navigate(`/_/collections/${c.id}/records`)}
                    style={{
                      appearance: "none",
                      background: "var(--vb-bg-3)",
                      border: "1px solid var(--vb-border)",
                      borderRadius: 6,
                      padding: "10px 12px",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      cursor: "pointer",
                      transition: "background 100ms",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--vb-bg-4)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "var(--vb-bg-3)"; }}
                  >
                    <span style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 12.5,
                      color: "var(--vb-fg)",
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      textAlign: "left",
                    }}>{c.name}</span>
                    <VbPill tone={COLL_TYPE_TONE[t] ?? "neutral"}>{t}</VbPill>
                  </button>
                );
              })}
            </div>
          )}
        </DashCard>
      </div>
    </>
  );
}

function DashAlert({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        gap: 12,
        alignItems: "flex-start",
        padding: "12px 16px",
        borderRadius: 8,
        background: "var(--vb-status-danger-bg)",
        border: "1px solid rgba(232,90,79,0.3)",
        color: "var(--vb-fg)",
        marginBottom: 20,
        fontSize: 12.5,
        cursor: onClick ? "pointer" : "default",
      }}
    >
      <Icon name="alert" size={14} />
      <div>{children}</div>
    </div>
  );
}

function DashCard({ title, meta, children }: { title: string; meta?: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: "var(--vb-bg-2)",
      border: "1px solid var(--vb-border)",
      borderRadius: 8,
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
    }}>
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 16px",
        borderBottom: "1px solid var(--vb-border)",
        background: "var(--vb-bg-1)",
      }}>
        <h3 style={{
          margin: 0,
          fontSize: 12.5,
          fontWeight: 600,
          color: "var(--vb-fg)",
          letterSpacing: 0.2,
        }}>{title}</h3>
        {meta && (
          <span style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--vb-fg-3)",
          }}>{meta}</span>
        )}
      </div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  );
}
