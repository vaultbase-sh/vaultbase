/**
 * Dashboard — implements `Vaultbase Dashboard.dc.html` (v2) from the
 * "Vaultbase redesign scope" project: boards 1a (fresh instance, everything
 * empty) and 1b (in use).
 *
 * Styling in ../styles/dashboard-next.css; see that file for why the design
 * tokens are scoped rather than hoisted to :root.
 *
 * Every number here comes from a real endpoint — see loadAll(). The one thing
 * the board asks for that the data model has no field for is the dead-job
 * "JOB" column: `enqueue(queue, payload, opts)` stores no job name, so we show
 * the short job id instead of the board's `send-welcome 9f2c41`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type ApiResponse } from "../api.ts";
import "../styles/dashboard-next.css";

// ── Shapes returned by the API ───────────────────────────────────────────────
interface QueueStat {
  queue: string;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  dead: number;
  succeeded_window: number;
  failed_window: number;
  dead_window: number;
  oldest_queued_at: number | null;
}

interface JobLogRow {
  id: string;
  queue: string;
  attempt: number;
  error: string | null;
  enqueued_at: number;
  finished_at: number | null;
  retry_max: number | null;
}

interface CollectionStat {
  name: string;
  type: string;
  recordCount: number | null;
  recordCountCapped: boolean;
  lastUpdated: number | null;
  recentWrites: number;
}

interface LogEntry {
  ts: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
}

interface Health {
  status: string;
  uptime_s: number;
}

// ── Range picker ─────────────────────────────────────────────────────────────
const RANGES = [
  { label: "1h", sec: 3_600 },
  { label: "24h", sec: 86_400 },
  { label: "7d", sec: 604_800 },
] as const;
type RangeLabel = (typeof RANGES)[number]["label"];

// ── Formatting ───────────────────────────────────────────────────────────────
const nf = new Intl.NumberFormat();

/** Compact age: 41s · 6m · 2h · 3d. The board's AGE/OLDEST/LAST columns. */
function ago(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "—";
  const d = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (d < 60) return `${d}s`;
  if (d < 3_600) return `${Math.floor(d / 60)}m`;
  if (d < 86_400) return `${Math.floor(d / 3_600)}h`;
  return `${Math.floor(d / 86_400)}d`;
}

/** `3d 04:12`, matching the board's uptime format. */
function uptime(s: number | null): string {
  if (s === null) return "—";
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const hm = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  return d > 0 ? `${d}d ${hm}` : `${hm}:${String(s % 60).padStart(2, "0")}`;
}

function clock(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? "—" : d.toTimeString().slice(0, 8);
}

function count(n: number | null, capped: boolean): string {
  if (n === null) return "—";
  return capped ? `${nf.format(n)}+` : nf.format(n);
}

function statusClass(s: number): string {
  if (s >= 500) return "vb-dash__err";
  if (s >= 400) return "vb-dash__warn";
  return "vb-dash__ok";
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [range, setRange] = useState<RangeLabel>("24h");
  const [loading, setLoading] = useState(true);
  const [firstLoad, setFirstLoad] = useState(true);

  const [health, setHealth] = useState<Health | null>(null);
  const [queues, setQueues] = useState<QueueStat[]>([]);
  const [dead, setDead] = useState<JobLogRow[]>([]);
  const [colls, setColls] = useState<CollectionStat[]>([]);
  const [reqs, setReqs] = useState<LogEntry[]>([]);

  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const loadAll = useCallback(async (windowSec: number) => {
    setLoading(true);
    const [h, q, d, c, l] = await Promise.all([
      fetch("/_/health").then((r) => r.json()).catch(() => null) as Promise<{ data?: Health } | null>,
      api.get<ApiResponse<QueueStat[]>>(`/api/v1/admin/queues/stats?window=${windowSec}`),
      api.get<ApiResponse<JobLogRow[]>>("/api/v1/admin/queues/jobs?status=dead&perPage=6"),
      api.get<ApiResponse<CollectionStat[]>>(`/api/v1/admin/collections/stats?window=${windowSec}`),
      // `logs/search` is the only tail available; `$[*]` matches every entry
      // and readLogs() emits newest-first, so this is the recent-request list.
      api.post<ApiResponse<{ results: { entry: LogEntry }[] }>>("/api/v1/admin/logs/search", {
        jsonpath: "$[*]",
        limit: 7,
      }),
    ]);
    if (!alive.current) return;
    setHealth(h?.data ?? null);
    setQueues(q.data ?? []);
    setDead(d.data ?? []);
    setColls(c.data ?? []);
    setReqs((l.data?.results ?? []).map((r) => r.entry).filter(Boolean));
    setLoading(false);
    setFirstLoad(false);
  }, []);

  useEffect(() => {
    const sec = RANGES.find((r) => r.label === range)!.sec;
    void loadAll(sec);
  }, [range, loadAll]);

  // ── Derived tile values ────────────────────────────────────────────────────
  const sum = (pick: (q: QueueStat) => number) => queues.reduce((a, q) => a + pick(q), 0);
  const queued = sum((q) => q.queued);
  const running = sum((q) => q.running);
  const succeeded = sum((q) => q.succeeded_window);
  const failedWin = sum((q) => q.failed_window);
  const deadTotal = sum((q) => q.dead);

  const settled = succeeded + failedWin;
  const successRate = settled > 0 ? `${((succeeded / settled) * 100).toFixed(1)}%` : null;

  const baseCount = colls.filter((c) => c.type === "base").length;
  const authCount = colls.filter((c) => c.type === "auth").length;
  const singletonCount = colls.filter((c) => c.type === "singleton").length;
  const viewCount = colls.filter((c) => c.type === "view").length;
  const collsBreakdown = ([[baseCount, "base"], [authCount, "auth"], [viewCount, "view"], [singletonCount, "single"]] as const)
    .filter(([n]) => n > 0).map(([n, l]) => `${n} ${l}`).join(" · ");

  const oldestDead = dead.reduce<number | null>((acc, j) => {
    const t = j.finished_at ?? j.enqueued_at;
    return acc === null || t < acc ? t : acc;
  }, null);

  const topColls = [...colls]
    .sort((a, b) => (b.recordCount ?? 0) - (a.recordCount ?? 0))
    .slice(0, 5);

  const maxPending = Math.max(1, ...queues.map((q) => q.queued));
  const port = window.location.port || (window.location.protocol === "https:" ? "443" : "80");

  return (
    <div className="vb-dash">
      {/* ── Topbar ─────────────────────────────────────────────────────── */}
      <div className="vb-dash__bar">
        <span className="vb-dash__title">Dashboard</span>
        <span className="vb-dash__sub">
          At-a-glance health of the running instance — collections, queues, recent activity.
        </span>
        <span className="vb-dash__spacer" />
        <span className="vb-dash__status">
          <span className={"vb-dash__dot" + (health ? "" : " vb-dash__dot--down")} />
          <strong>{health ? "running" : "unreachable"}</strong>
          <span>·</span>
          <span>up {uptime(health?.uptime_s ?? null)}</span>
          <span>·</span>
          <span>:{port}</span>
        </span>
        <div className="vb-dash__range" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button
              key={r.label}
              type="button"
              aria-pressed={r.label === range}
              onClick={() => setRange(r.label)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="vb-dash__refresh"
          aria-label="Refresh"
          data-busy={loading && !firstLoad}
          onClick={() => void loadAll(RANGES.find((r) => r.label === range)!.sec)}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="square">
            <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" />
          </svg>
        </button>
      </div>

      {/* ── Stat tiles ─────────────────────────────────────────────────── */}
      <div className="vb-dash__stats">
        <Stat
          label="COLLECTIONS"
          value={nf.format(colls.length)}
          sub={colls.length ? collsBreakdown : "—"}
        />
        <Stat
          label="QUEUED"
          value={nf.format(queued)}
          sub={queues.length ? `${running} running · ${queues.length} queues` : "—"}
        />
        <Stat
          label="SUCCEEDED"
          value={nf.format(succeeded)}
          sub={successRate ? `last ${range} · ${successRate}` : `last ${range}`}
        />
        <Stat
          label="DEAD-LETTER"
          value={nf.format(deadTotal)}
          sub={deadTotal > 0 && oldestDead ? `oldest ${ago(oldestDead)}` : "—"}
          alert={deadTotal > 0}
        />
      </div>

      {/* ── Panels ─────────────────────────────────────────────────────── */}
      <div className="vb-dash__grid">
        <Panel
          title="Recent dead jobs"
          meta={`${dead.length} of last 50`}
          action={{ label: "View all →", onClick: () => navigate("/_/hooks") }}
          cols="vb-dash__t--dead"
          head={["QUEUE", "JOB", "ERROR", "TRIES", "AGE"]}
          align={["", "", "", "num", "num"]}
          loading={firstLoad}
          empty={dead.length === 0}
          emptyNode={<><b>No dead jobs.</b> <span>Background workers haven't blown up. Tick.</span></>}
        >
          {dead.map((j) => (
            <div key={j.id} className="vb-dash__row vb-dash__t--dead">
              <span className="vb-dash__key">{j.queue}</span>
              <span>{j.id.slice(0, 8)}</span>
              <span className="vb-dash__err" title={j.error ?? ""}>{j.error ?? "—"}</span>
              <span className="vb-dash__num">
                {j.attempt}/{j.retry_max ?? j.attempt}
              </span>
              <span className="vb-dash__num vb-dash__dim">{ago(j.finished_at ?? j.enqueued_at)}</span>
            </div>
          ))}
        </Panel>

        <Panel
          title="Per-queue backlog"
          meta={`${queues.length} ${queues.length === 1 ? "queue" : "queues"}`}
          cols="vb-dash__t--queue"
          head={["QUEUE", "PENDING", "RUNNING", `FAILED ${range.toUpperCase()}`, "OLDEST"]}
          align={["", "", "num", "num", "num"]}
          loading={firstLoad}
          empty={queues.length === 0}
          emptyNode={
            <>
              <b>No workers configured.</b>{" "}
              <span>Workers process jobs from named queues. Define one in Hooks → Workers.</span>{" "}
              <button type="button" onClick={() => navigate("/_/hooks")}>Open Hooks</button>
            </>
          }
        >
          {queues.map((q) => (
            <div key={q.queue} className="vb-dash__row vb-dash__t--queue">
              <span className="vb-dash__key">{q.queue}</span>
              <span className="vb-dash__bar-cell">
                <span className="vb-dash__num">{q.queued}</span>
                <span className="vb-dash__bar-track">
                  <span
                    className="vb-dash__bar-fill"
                    style={{ width: `${(q.queued / maxPending) * 100}%` }}
                  />
                </span>
              </span>
              <span className="vb-dash__num">{q.running}</span>
              <span className={"vb-dash__num" + (q.failed_window ? " vb-dash__err" : " vb-dash__dim")}>
                {q.failed_window}
              </span>
              <span className="vb-dash__num vb-dash__dim">{ago(q.oldest_queued_at)}</span>
            </div>
          ))}
        </Panel>

        <Panel
          title="Top collections"
          meta={`${colls.length} total`}
          action={{ label: "All collections →", onClick: () => navigate("/_/collections") }}
          cols="vb-dash__t--coll"
          head={["NAME", "TYPE", "RECORDS", `WRITES ${range.toUpperCase()}`, "LAST WRITE"]}
          align={["", "", "num", "num", "num"]}
          loading={firstLoad}
          empty={colls.length === 0}
          emptyNode={
            <>
              <b>No collections yet.</b>{" "}
              <span>Create your first collection to start modeling data.</span>{" "}
              <button type="button" onClick={() => navigate("/_/collections")}>Open Collections</button>
            </>
          }
        >
          {topColls.map((c) => (
            <div key={c.name} className="vb-dash__row vb-dash__t--coll">
              <span>{c.name}</span>
              <span className="vb-dash__dim">{c.type}</span>
              <span className="vb-dash__num">{count(c.recordCount, c.recordCountCapped)}</span>
              <span className="vb-dash__num">{nf.format(c.recentWrites)}</span>
              <span className="vb-dash__num vb-dash__dim">{ago(c.lastUpdated)}</span>
            </div>
          ))}
        </Panel>

        <Panel
          title="Recent requests"
          meta={`last ${range}`}
          action={{ label: "Open Logs →", onClick: () => navigate("/_/logs") }}
          cols="vb-dash__t--req"
          head={["TIME", "METHOD", "PATH", "STATUS", "MS"]}
          align={["", "", "", "num", "num"]}
          loading={firstLoad}
          empty={reqs.length === 0}
          emptyNode={<><b>No requests yet.</b> <span>Calls to /api/* show up here as they happen.</span></>}
        >
          {reqs.map((r, i) => (
            <div key={`${r.ts}-${i}`} className="vb-dash__row vb-dash__t--req">
              <span className="vb-dash__dim">{clock(r.ts)}</span>
              <span className="vb-dash__key">{r.method}</span>
              <span title={r.path}>{r.path}</span>
              <span className={"vb-dash__num " + statusClass(r.status)}>{r.status}</span>
              <span className="vb-dash__num vb-dash__dim">{r.duration_ms}</span>
            </div>
          ))}
        </Panel>
      </div>
    </div>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────
function Stat({ label, value, sub, alert }: {
  label: string;
  value: string;
  sub: string;
  alert?: boolean;
}) {
  return (
    <div className="vb-dash__stat">
      <span className="vb-dash__stat-label">{label}</span>
      <span className={"vb-dash__stat-value" + (alert ? " vb-dash__stat-value--alert" : "")}>
        {value}
      </span>
      <span className="vb-dash__stat-sub" title={sub}>{sub}</span>
    </div>
  );
}

function Panel({
  title, meta, action, cols, head, align, loading, empty, emptyNode, children,
}: {
  title: string;
  meta: string;
  action?: { label: string; onClick: () => void };
  cols: string;
  head: string[];
  align: string[];
  loading: boolean;
  empty: boolean;
  emptyNode: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="vb-dash__panel">
      <div className="vb-dash__panel-head">
        <span className="vb-dash__panel-title">{title}</span>
        <span className="vb-dash__panel-meta">{meta}</span>
        <span className="vb-dash__spacer" />
        {action && (
          <button type="button" className="vb-dash__panel-link" onClick={action.onClick}>
            {action.label}
          </button>
        )}
      </div>
      <div className={`vb-dash__th ${cols}`}>
        {head.map((h, i) => (
          <span key={h} className={align[i] === "num" ? "vb-dash__num" : ""}>{h}</span>
        ))}
      </div>
      {loading ? (
        <>
          <div className="vb-dash__skel" />
          <div className="vb-dash__skel" />
          <div className="vb-dash__skel" />
        </>
      ) : empty ? (
        <div className="vb-dash__empty">{emptyNode}</div>
      ) : (
        children
      )}
    </section>
  );
}
