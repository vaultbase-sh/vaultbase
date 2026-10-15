/**
 * Monitoring — near-real-time view of `/_/metrics`.
 *
 * Polls `/api/v1/_/metrics` (1 s by default) and renders:
 *   - per-second throughput + latency from the server's 120 s ring buffer
 *   - CPU / event-loop lag / memory, kept client-side as the poll history
 *   - per-step latency histograms, read vs write split, status classes
 *   - SQLite file + WAL sizes, realtime connection count
 *   - list queries by total time, with the index that would serve a scan
 *
 * Numbers are per process. Under cluster mode each poll lands on whichever
 * worker the kernel picks, so the page shows that worker's view (the worker
 * id is in the status strip).
 *
 * Styling: reuses the scoped `.vb-dash` tokens from dashboard-next.css plus
 * the chart/table additions in monitoring.css.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type ApiResponse } from "../api.ts";
import { confirm } from "../components/Confirm.tsx";
import { toast } from "../stores/toast.ts";
import "../styles/dashboard-next.css";
import "../styles/monitoring.css";

// ── Shapes returned by /_/metrics ────────────────────────────────────────────
interface Hist {
  count: number;
  p50_us: number;
  p90_us: number;
  p99_us: number;
  p99_9_us: number;
  p99_99_us: number;
  max_us: number;
  mean_us: number;
}

interface SecondSample {
  t: number;
  reqs: number;
  writes: number;
  errors: number;
  mean_us: number;
  max_us: number;
}

interface Snapshot {
  uptime_seconds: number;
  requests_total: number;
  rps_1min: number;
  steps: Record<string, Hist>;
  total: Hist;
  reads: Hist;
  writes: Hist;
  status: { "2xx": number; "3xx": number; "4xx": number; "5xx": number };
  methods: Record<string, number>;
  series: SecondSample[];
  process: {
    pid: number;
    worker_id: string | null;
    rss_bytes: number;
    heap_used_bytes: number;
    heap_total_bytes: number;
    cpu_percent: number;
    event_loop_lag_ms: number;
    realtime_connections: number;
  };
  read_workers?: { workers: number; forwarded: number; inflight: number; dropped: number };
  database?: { driver: string; size_bytes: number; connections: { total: number; active: number } | null } | null;
  sqlite: {
    page_count: number;
    page_size: number;
    wal_pages: number;
    db_bytes: number;
    wal_bytes: number;
    checkpoint: {
      mode: "worker" | "inline";
      passes: number;
      restarts: number;
      max_pass_ms: number;
      max_restart_ms: number;
    } | null;
  } | null;
}

/** One list-query shape from `/_/metrics/queries`. */
interface QueryRow {
  id: string;
  collection: string;
  filter: string | null;
  sort: string | null;
  search: boolean;
  deep: boolean;
  count: number;
  mean_us: number;
  max_us: number;
  total_us: number;
  last_seen: number;
  rows: number;
  plan: string[];
  scan: boolean;
  temp_sort: boolean;
  suggestion: { fields: string[]; name: string } | null;
}

/** One poll's process gauges, kept client-side for the resource charts. */
interface ProcSample {
  t: number;
  cpu: number;
  lag: number;
  rss: number;
  heap: number;
}

const HISTORY = 120;

const INTERVALS = [
  { label: "1s", ms: 1_000 },
  { label: "2s", ms: 2_000 },
  { label: "5s", ms: 5_000 },
] as const;
type IntervalLabel = (typeof INTERVALS)[number]["label"];

const STEP_LABELS: Record<string, string> = {
  route_match: "route match",
  auth_verify: "auth verify",
  collection_load: "collection load",
  rule_compile: "rule compile",
  db_exec: "db exec",
  record_write: "record write",
  row_decode: "row decode",
  serialize: "serialize",
  compress: "compress",
  log_write: "log write",
};

// ── Formatting ───────────────────────────────────────────────────────────────
const nf = new Intl.NumberFormat();

function dur(us: number): string {
  if (!us) return "0";
  if (us < 1_000) return `${Math.round(us)}µs`;
  if (us < 1_000_000) return `${(us / 1_000).toFixed(us < 10_000 ? 2 : 1)}ms`;
  return `${(us / 1_000_000).toFixed(2)}s`;
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

function uptime(s: number): string {
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const hms = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return d > 0 ? `${d}d ${hms}` : hms;
}

function clock(sec: number): string {
  return new Date(sec * 1000).toTimeString().slice(0, 8);
}

function pct(part: number, whole: number): string {
  if (!whole) return "0%";
  const p = (part / whole) * 100;
  return `${p < 1 && p > 0 ? p.toFixed(2) : p.toFixed(1)}%`;
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default function Monitoring() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [proc, setProc] = useState<ProcSample[]>([]);
  const [interval, setIntervalLabel] = useState<IntervalLabel>("1s");
  const [paused, setPaused] = useState(false);
  const [down, setDown] = useState(false);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const [queries, setQueries] = useState<QueryRow[]>([]);
  const [creating, setCreating] = useState<string | null>(null);

  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const poll = useCallback(async () => {
    try {
      // The metrics endpoint returns the snapshot bare, not in a `{ data }` envelope.
      const s = await api.get<Snapshot & ApiResponse<never>>("/api/v1/_/metrics");
      if (!alive.current) return;
      if (!s || !Array.isArray(s.series)) { setDown(true); return; }
      setSnap(s);
      setDown(false);
      setLastAt(Date.now());
      void api.get<ApiResponse<QueryRow[]>>("/api/v1/_/metrics/queries").then((q) => {
        if (alive.current && q?.data) setQueries(q.data);
      }).catch(() => { /* keep the last list */ });
      setProc((prev) => {
        const next = prev.concat({
          t: Math.floor(Date.now() / 1000),
          cpu: s.process.cpu_percent,
          lag: s.process.event_loop_lag_ms,
          rss: s.process.rss_bytes,
          heap: s.process.heap_used_bytes,
        });
        return next.length > HISTORY ? next.slice(next.length - HISTORY) : next;
      });
    } catch {
      if (alive.current) setDown(true);
    }
  }, []);

  useEffect(() => {
    if (paused) return;
    const ms = INTERVALS.find((i) => i.label === interval)!.ms;
    void poll();
    const id = setInterval(() => {
      // Skip ticks while the tab is hidden; resume on the next visible one.
      if (document.visibilityState === "visible") void poll();
    }, ms);
    return () => clearInterval(id);
  }, [interval, paused, poll]);

  const reset = async () => {
    const ok = await confirm({
      title: "Reset metrics",
      message: "Clear every histogram, counter and the per-second series on this process? Uptime restarts from zero.",
      confirmLabel: "Reset",
      danger: true,
    });
    if (!ok) return;
    await api.post("/api/v1/_/metrics/reset", {});
    setProc([]);
    setQueries([]);
    void poll();
  };

  const createIndex = async (q: QueryRow) => {
    if (!q.suggestion) return;
    setCreating(q.id);
    try {
      const res = await api.post<ApiResponse<{ name: string }>>(
        `/api/v1/admin/collections/${q.collection}/indexes`,
        { fields: q.suggestion.fields },
      );
      if (res.error) { toast(res.error, "info"); return; }
      toast(`Index ${res.data?.name ?? q.suggestion.name} created`);
      void poll();
    } finally {
      setCreating(null);
    }
  };

  // ── Derived values ─────────────────────────────────────────────────────────
  const series = snap?.series ?? [];
  // The newest slot is the second still in progress; the one before it is
  // the last complete second.
  const last = series.length >= 2 ? series[series.length - 2]! : null;
  const st = snap?.status ?? { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
  const statusTotal = st["2xx"] + st["3xx"] + st["4xx"] + st["5xx"];
  const writesTotal = snap?.writes.count ?? 0;
  const readsTotal = snap?.reads.count ?? 0;
  const p = snap?.process;
  const sql = snap?.sqlite ?? null;
  const dbs = snap?.database ?? null;
  const onPostgres = dbs?.driver === "postgres";
  const peakRps = series.reduce((m, s) => Math.max(m, s.reqs), 0);
  const windowReqs = series.slice(0, -1).reduce((a, s) => a + s.reqs, 0);
  const windowWrites = series.slice(0, -1).reduce((a, s) => a + s.writes, 0);
  const windowSecs = Math.max(1, series.length - 1);
  // Charts plot complete seconds only; the in-progress one would dip.
  const done = series.slice(0, -1);

  return (
    <div className="vb-dash vb-mon">
      {/* ── Topbar ─────────────────────────────────────────────────────── */}
      <div className="vb-dash__bar">
        <span className="vb-dash__title">Monitoring</span>
        <span className="vb-dash__sub">
          Live request, latency, resource and storage metrics for this process.
        </span>
        <span className="vb-dash__spacer" />
        <span className="vb-dash__status">
          <span className={"vb-dash__dot" + (down ? " vb-dash__dot--down" : paused ? " vb-mon__dot--paused" : " vb-mon__dot--live")} />
          <strong>{down ? "unreachable" : paused ? "paused" : "live"}</strong>
          {p && (
            <>
              <span>·</span>
              <span>pid {p.pid}{p.worker_id ? ` · worker ${p.worker_id}` : ""}</span>
              <span>·</span>
              <span>up {uptime(snap!.uptime_seconds)}</span>
            </>
          )}
          {lastAt && <><span>·</span><span>{new Date(lastAt).toTimeString().slice(0, 8)}</span></>}
        </span>
        <div className="vb-dash__range" role="group" aria-label="Refresh interval">
          {INTERVALS.map((i) => (
            <button
              key={i.label}
              type="button"
              aria-pressed={!paused && i.label === interval}
              onClick={() => { setIntervalLabel(i.label); setPaused(false); }}
            >
              {i.label}
            </button>
          ))}
          <button type="button" aria-pressed={paused} onClick={() => setPaused((v) => !v)}>
            {paused ? "resume" : "pause"}
          </button>
        </div>
        <button type="button" className="vb-mon__btn" onClick={() => void reset()}>
          Reset
        </button>
      </div>

      {/* ── Stat tiles ─────────────────────────────────────────────────── */}
      <div className="vb-dash__stats vb-mon__stats">
        <Stat
          label="REQ / S"
          value={last ? nf.format(last.reqs) : "—"}
          sub={`${(windowReqs / windowSecs).toFixed(1)} avg · peak ${nf.format(peakRps)}`}
        />
        <Stat
          label="WRITES / S"
          value={last ? nf.format(last.writes) : "—"}
          sub={`${(windowWrites / windowSecs).toFixed(1)} avg · ${nf.format(writesTotal)} total`}
        />
        <Stat
          label="P99 LATENCY"
          value={snap ? dur(snap.total.p99_us) : "—"}
          sub={snap ? `p50 ${dur(snap.total.p50_us)} · max ${dur(snap.total.max_us)}` : "—"}
        />
        <Stat
          label="5XX ERRORS"
          value={nf.format(st["5xx"])}
          sub={`${pct(st["5xx"], statusTotal)} · 4xx ${nf.format(st["4xx"])}`}
          alert={st["5xx"] > 0}
        />
        <Stat
          label="CPU"
          value={p ? `${p.cpu_percent.toFixed(1)}%` : "—"}
          sub={p ? `loop lag ${p.event_loop_lag_ms} ms` : "—"}
          alert={!!p && p.event_loop_lag_ms > 100}
        />
        <Stat
          label="MEMORY"
          value={p ? bytes(p.rss_bytes) : "—"}
          sub={p ? `heap ${bytes(p.heap_used_bytes)} / ${bytes(p.heap_total_bytes)}` : "—"}
        />
      </div>

      {/* ── Charts ─────────────────────────────────────────────────────── */}
      <div className="vb-dash__grid">
        <ChartPanel
          title="Throughput"
          meta="per second · last 2 min"
          xs={done.map((s) => s.t)}
          lines={[
            { label: "requests", color: "var(--vb-fg-2)", values: done.map((s) => s.reqs), fmt: nf.format, area: true },
            { label: "writes", color: "var(--vb-mon-write)", values: done.map((s) => s.writes), fmt: nf.format },
            { label: "5xx", color: "var(--vb-accent)", values: done.map((s) => s.errors), fmt: nf.format },
          ]}
          yFmt={(v) => nf.format(Math.round(v))}
        />
        <ChartPanel
          title="Latency"
          meta="end-to-end, per second"
          xs={done.map((s) => s.t)}
          lines={[
            { label: "mean", color: "var(--vb-fg-2)", values: done.map((s) => s.mean_us), fmt: dur, area: true },
            { label: "max", color: "var(--vb-mon-write)", values: done.map((s) => s.max_us), fmt: dur },
          ]}
          yFmt={dur}
        />
        <ChartPanel
          title="CPU & event loop"
          meta={`per poll · ${interval}`}
          xs={proc.map((s) => s.t)}
          lines={[
            { label: "cpu %", color: "var(--vb-fg-2)", values: proc.map((s) => s.cpu), fmt: (v) => `${v.toFixed(1)}%`, area: true },
            { label: "lag ms", color: "var(--vb-accent)", values: proc.map((s) => s.lag), fmt: (v) => `${v} ms` },
          ]}
          yFmt={(v) => v.toFixed(0)}
        />
        <ChartPanel
          title="Memory"
          meta={`per poll · ${interval}`}
          xs={proc.map((s) => s.t)}
          lines={[
            { label: "rss", color: "var(--vb-fg-2)", values: proc.map((s) => s.rss), fmt: bytes, area: true },
            { label: "heap used", color: "var(--vb-mon-write)", values: proc.map((s) => s.heap), fmt: bytes },
          ]}
          yFmt={bytes}
        />

        {/* ── Step breakdown ───────────────────────────────────────────── */}
        <section className="vb-dash__panel vb-mon__wide">
          <PanelHead title="Request pipeline" meta={`${nf.format(snap?.requests_total ?? 0)} requests since reset`} />
          <div className="vb-dash__th vb-mon__t--steps">
            {["STEP", "COUNT", "P50", "P90", "P99", "P99.9", "MAX", "MEAN"].map((h, i) => (
              <span key={h} className={i ? "vb-dash__num" : ""}>{h}</span>
            ))}
          </div>
          {snap ? (
            <>
              <HistRow label="total" h={snap.total} strong />
              <HistRow label="reads" h={snap.reads} />
              <HistRow label="writes" h={snap.writes} />
              {Object.entries(snap.steps)
                .filter(([, h]) => h.count > 0)
                .map(([k, h]) => <HistRow key={k} label={STEP_LABELS[k] ?? k} h={h} dim />)}
            </>
          ) : (
            <><div className="vb-dash__skel" /><div className="vb-dash__skel" /></>
          )}
        </section>

        {/* ── List queries ─────────────────────────────────────────────── */}
        <section className="vb-dash__panel vb-mon__wide">
          <PanelHead
            title="List queries"
            meta={queries.length ? `${nf.format(queries.length)} shapes by total time` : "by total time"}
          />
          <div className="vb-dash__th vb-mon__t--queries">
            {["COLLECTION", "QUERY", "CALLS", "MEAN", "MAX", "TOTAL", "SUGGESTED INDEX"].map((h, i) => (
              <span key={h} className={i >= 2 && i <= 5 ? "vb-dash__num" : ""}>{h}</span>
            ))}
          </div>
          {queries.length === 0 ? (
            <div className="vb-mon__note">
              No list requests since the last reset. Shapes that scan a table of {nf.format(1000)}+ rows
              or sort in memory get an index suggestion here.
            </div>
          ) : (
            queries.map((q) => <QueryRowView key={q.id} q={q} busy={creating === q.id} onCreate={() => void createIndex(q)} />)
          )}
        </section>

        {/* ── Traffic mix ──────────────────────────────────────────────── */}
        <section className="vb-dash__panel">
          <PanelHead title="Traffic mix" meta={`${nf.format(statusTotal)} classified`} />
          <div className="vb-dash__th vb-mon__t--kv">
            <span>CLASS</span><span className="vb-dash__num">COUNT</span><span className="vb-dash__num">SHARE</span>
          </div>
          <KvRow k="reads" v={readsTotal} total={readsTotal + writesTotal} />
          <KvRow k="writes" v={writesTotal} total={readsTotal + writesTotal} />
          {(["2xx", "3xx", "4xx", "5xx"] as const).map((c) => (
            <KvRow key={c} k={c} v={st[c]} total={statusTotal} err={c === "5xx" && st[c] > 0} />
          ))}
          {Object.entries(snap?.methods ?? {})
            .sort((a, b) => b[1] - a[1])
            .map(([m, n]) => <KvRow key={m} k={m} v={n} total={statusTotal} />)}
        </section>

        {/* ── Storage & connections ────────────────────────────────────── */}
        <section className="vb-dash__panel">
          <PanelHead title="Storage & connections" meta={onPostgres ? "Postgres" : "SQLite · WAL"} />
          <div className="vb-dash__th vb-mon__t--kv2">
            <span>METRIC</span><span className="vb-dash__num">VALUE</span>
          </div>
          {onPostgres ? (
            <>
              <Kv2 k="database size" v={bytes(dbs!.size_bytes)} />
              <Kv2 k="connections · active" v={dbs!.connections ? `${nf.format(dbs!.connections.total)} · ${nf.format(dbs!.connections.active)}` : "—"} />
            </>
          ) : (
            <>
              <Kv2 k="database file" v={sql ? bytes(sql.db_bytes) : "—"} />
              <Kv2 k="WAL file" v={sql ? bytes(sql.wal_bytes) : "—"} />
              <Kv2 k="WAL pages pending" v={sql ? nf.format(sql.wal_pages) : "—"} />
              <Kv2 k="pages × size" v={sql ? `${nf.format(sql.page_count)} × ${nf.format(sql.page_size)} B` : "—"} />
              <Kv2
                k="checkpointer"
                v={sql?.checkpoint ? `${sql.checkpoint.mode} · ${nf.format(sql.checkpoint.passes)} passes` : "—"}
              />
              <Kv2
                k="WAL rewinds · slowest"
                v={sql?.checkpoint ? `${nf.format(sql.checkpoint.restarts)} · ${sql.checkpoint.max_restart_ms} ms` : "—"}
              />
            </>
          )}
          <Kv2 k="realtime connections" v={p ? nf.format(p.realtime_connections) : "—"} />
          <Kv2
            k="read workers · forwarded"
            v={snap?.read_workers ? (snap.read_workers.workers ? `${snap.read_workers.workers} · ${nf.format(snap.read_workers.forwarded)}${snap.read_workers.dropped ? ` · ${snap.read_workers.dropped} dropped` : ""}` : "off") : "—"}
          />
          <Kv2 k="requests total" v={snap ? nf.format(snap.requests_total) : "—"} />
          <Kv2 k="1-min avg RPS" v={snap ? nf.format(snap.rps_1min) : "—"} />
        </section>
      </div>
    </div>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────
function Stat({ label, value, sub, alert }: { label: string; value: string; sub: string; alert?: boolean }) {
  return (
    <div className="vb-dash__stat">
      <span className="vb-dash__stat-label">{label}</span>
      <span className={"vb-dash__stat-value" + (alert ? " vb-dash__stat-value--alert" : "")}>{value}</span>
      <span className="vb-dash__stat-sub">{sub}</span>
    </div>
  );
}

function PanelHead({ title, meta, children }: { title: string; meta: string; children?: React.ReactNode }) {
  return (
    <div className="vb-dash__panel-head">
      <span className="vb-dash__panel-title">{title}</span>
      <span className="vb-dash__panel-meta">{meta}</span>
      <span className="vb-dash__spacer" />
      {children}
    </div>
  );
}

function HistRow({ label, h, strong, dim }: { label: string; h: Hist; strong?: boolean; dim?: boolean }) {
  return (
    <div className={"vb-dash__row vb-mon__t--steps" + (strong ? " vb-mon__row--strong" : "")}>
      <span className={dim ? "vb-dash__dim" : "vb-dash__key"}>{label}</span>
      <span className="vb-dash__num">{nf.format(h.count)}</span>
      <span className="vb-dash__num">{dur(h.p50_us)}</span>
      <span className="vb-dash__num">{dur(h.p90_us)}</span>
      <span className="vb-dash__num">{dur(h.p99_us)}</span>
      <span className="vb-dash__num">{dur(h.p99_9_us)}</span>
      <span className="vb-dash__num vb-dash__dim">{dur(h.max_us)}</span>
      <span className="vb-dash__num vb-dash__dim">{dur(h.mean_us)}</span>
    </div>
  );
}

function QueryRowView({ q, busy, onCreate }: { q: QueryRow; busy: boolean; onCreate: () => void }) {
  const flags: string[] = [];
  if (q.search) flags.push("search");
  if (q.deep) flags.push("deep page");
  if (q.scan) flags.push("scan");
  if (q.temp_sort) flags.push("temp sort");
  return (
    <div className="vb-dash__row vb-mon__t--queries" title={q.plan.join("\n")}>
      <span className="vb-dash__key">{q.collection}</span>
      <span className="vb-mon__query">
        <code>{q.filter ?? "*"}{q.sort ? ` · sort ${q.sort}` : ""}</code>
        {flags.length > 0 && (
          <span className="vb-mon__flags">
            {flags.map((f) => <i key={f} className={f === "scan" || f === "temp sort" ? "vb-mon__flag vb-mon__flag--warn" : "vb-mon__flag"}>{f}</i>)}
          </span>
        )}
      </span>
      <span className="vb-dash__num">{nf.format(q.count)}</span>
      <span className="vb-dash__num">{dur(q.mean_us)}</span>
      <span className="vb-dash__num vb-dash__dim">{dur(q.max_us)}</span>
      <span className="vb-dash__num">{dur(q.total_us)}</span>
      <span className="vb-mon__suggest">
        {q.suggestion ? (
          <>
            <code>({q.suggestion.fields.join(", ")})</code>
            <button type="button" className="vb-mon__btn" disabled={busy} onClick={onCreate}>
              {busy ? "creating…" : "Create index"}
            </button>
          </>
        ) : (
          <span className="vb-dash__dim">—</span>
        )}
      </span>
    </div>
  );
}

function KvRow({ k, v, total, err }: { k: string; v: number; total: number; err?: boolean }) {
  return (
    <div className="vb-dash__row vb-mon__t--kv">
      <span className="vb-dash__key">{k}</span>
      <span className={"vb-dash__num" + (err ? " vb-dash__err" : "")}>{nf.format(v)}</span>
      <span className="vb-dash__bar-cell vb-mon__share">
        <span className="vb-dash__bar-track">
          <span className="vb-dash__bar-fill" style={{ width: total ? `${(v / total) * 100}%` : "0%" }} />
        </span>
        <span className="vb-dash__num vb-dash__dim">{pct(v, total)}</span>
      </span>
    </div>
  );
}

function Kv2({ k, v }: { k: string; v: string }) {
  return (
    <div className="vb-dash__row vb-mon__t--kv2">
      <span className="vb-dash__key">{k}</span>
      <span className="vb-dash__num">{v}</span>
    </div>
  );
}

// ── Chart ────────────────────────────────────────────────────────────────────
interface Line {
  label: string;
  color: string;
  values: number[];
  fmt: (v: number) => string;
  area?: boolean;
}

const CH = 168; // plot height, px
const PAD_L = 56;
const PAD_R = 12;
const PAD_T = 10;
const PAD_B = 22;

/**
 * Plain SVG line chart. Measures its own width (ResizeObserver) so strokes
 * stay 1.5px instead of stretching with a viewBox. Hover shows a crosshair and
 * the values of the nearest sample.
 */
function ChartPanel({ title, meta, xs, lines, yFmt }: {
  title: string;
  meta: string;
  xs: number[];
  lines: Line[];
  yFmt: (v: number) => string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const n = xs.length;
  const maxV = Math.max(1, ...lines.flatMap((l) => l.values));
  const yMax = niceCeil(maxV);
  const plotW = Math.max(0, w - PAD_L - PAD_R);
  const plotH = CH - PAD_T - PAD_B;
  const x = (i: number) => PAD_L + (n <= 1 ? plotW : (i / (n - 1)) * plotW);
  const y = (v: number) => PAD_T + plotH - (v / yMax) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (n === 0 || plotW <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - rect.left - PAD_L) / plotW;
    setHover(Math.max(0, Math.min(n - 1, Math.round(rel * (n - 1)))));
  };

  const hi = hover !== null && hover < n ? hover : null;

  return (
    <section className="vb-dash__panel">
      <PanelHead title={title} meta={meta}>
        <span className="vb-mon__legend">
          {lines.map((l) => (
            <span key={l.label}>
              <i style={{ background: l.color }} />
              {l.label}
              <b>{n ? l.fmt(l.values[hi ?? n - 1] ?? 0) : "—"}</b>
            </span>
          ))}
        </span>
      </PanelHead>
      <div className="vb-mon__chart" ref={wrap}>
        {w > 0 && (
          <svg width={w} height={CH} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img" aria-label={`${title} chart`}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD_L} x2={w - PAD_R} y1={y(t)} y2={y(t)} className="vb-mon__grid" />
                <text x={PAD_L - 8} y={y(t)} className="vb-mon__axis" textAnchor="end" dominantBaseline="middle">
                  {yFmt(t)}
                </text>
              </g>
            ))}
            {n > 1 && (
              <>
                <text x={PAD_L} y={CH - 6} className="vb-mon__axis">{clock(xs[0]!)}</text>
                <text x={w - PAD_R} y={CH - 6} className="vb-mon__axis" textAnchor="end">{clock(xs[n - 1]!)}</text>
              </>
            )}
            {n > 1 && lines.map((l) => {
              const pts = l.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
              return (
                <g key={l.label}>
                  {l.area && (
                    <polygon
                      points={`${x(0)},${y(0)} ${pts} ${x(n - 1)},${y(0)}`}
                      fill={l.color}
                      className="vb-mon__area"
                    />
                  )}
                  <polyline points={pts} fill="none" stroke={l.color} strokeWidth={1.5} strokeLinejoin="round" />
                </g>
              );
            })}
            {hi !== null && (
              <g>
                <line x1={x(hi)} x2={x(hi)} y1={PAD_T} y2={PAD_T + plotH} className="vb-mon__cross" />
                {lines.map((l) => (
                  <circle key={l.label} cx={x(hi)} cy={y(l.values[hi] ?? 0)} r={3} fill={l.color} />
                ))}
                <text
                  x={Math.min(x(hi) + 6, w - PAD_R)}
                  y={PAD_T + 10}
                  className="vb-mon__axis vb-mon__axis--hi"
                  textAnchor={x(hi) + 60 > w - PAD_R ? "end" : "start"}
                >
                  {clock(xs[hi]!)}
                </text>
              </g>
            )}
            {n <= 1 && (
              <text x={w / 2} y={CH / 2} className="vb-mon__axis" textAnchor="middle">collecting samples…</text>
            )}
          </svg>
        )}
      </div>
    </section>
  );
}

/** Round up to 1 / 2 / 2.5 / 5 × 10^k so the y-axis ticks read cleanly. */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (v <= m * pow) return m * pow;
  }
  return 10 * pow;
}
