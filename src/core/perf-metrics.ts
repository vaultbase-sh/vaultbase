/**
 * Per-request performance instrumentation — Phase 0 of the perf sprint.
 *
 * Design:
 *   - One {@link RequestTimer} per HTTP request, propagated via AsyncLocalStorage
 *     so any nested call can {@link markStep} without threading state through.
 *   - On request finish, the timer's recorded steps roll into per-step
 *     {@link Histogram}s held in the global {@link MetricsRegistry}.
 *   - Histograms are bucketed (4 sub-buckets per power of two from 1µs upward)
 *     — fast enough that always-on recording adds <100 ns per step record.
 *   - `/_/metrics` reads a snapshot — no allocations on the request path.
 *
 * All timing is in microseconds (`performance.now() * 1000`). Wall-clock from
 * `performance.now()` is monotonic and good to ~1µs on Bun.
 */

/** Steps the records hot path passes through. Order = roughly chronological. */
export type Step =
  | "route_match"
  | "auth_verify"
  | "collection_load"
  | "rule_compile"
  | "db_exec"
  | "record_write"
  | "row_decode"
  | "serialize"
  | "compress"
  | "log_write";

export const STEPS: readonly Step[] = [
  "route_match",
  "auth_verify",
  "collection_load",
  "rule_compile",
  "db_exec",
  "record_write",
  "row_decode",
  "serialize",
  "compress",
  "log_write",
];

// ── Histogram ───────────────────────────────────────────────────────────────

/**
 * Bucketed-histogram with 4 sub-buckets per power of two starting at 1 µs.
 * 1 µs → 60 s = 26 powers of two × 4 ≈ 104 buckets. Quantile interpolation
 * within a bucket yields ±~19% error — fine for steering optimization decisions
 * (we care about "did p99 drop in half" not "is p99 47.3 µs").
 */
const SUBBUCKETS_PER_POW2 = 4;
const MAX_POW2 = 26; // 2^26 µs ≈ 67 s — anything slower bins into the last bucket
const NUM_BUCKETS = SUBBUCKETS_PER_POW2 * (MAX_POW2 + 1);

function bucketIndex(us: number): number {
  if (us <= 0) return 0;
  // log2(us) * 4, clamped
  const b = Math.floor((Math.log(us) / Math.LN2) * SUBBUCKETS_PER_POW2);
  if (b < 0) return 0;
  if (b >= NUM_BUCKETS) return NUM_BUCKETS - 1;
  return b;
}

function bucketLowerBoundUs(idx: number): number {
  return Math.pow(2, idx / SUBBUCKETS_PER_POW2);
}

function bucketUpperBoundUs(idx: number): number {
  return Math.pow(2, (idx + 1) / SUBBUCKETS_PER_POW2);
}

/** A histogram's buckets as plain numbers (what a read worker posts). */
export interface HistogramParts {
  counts: number[];
  count: number;
  sum_us: number;
  max_us: number;
}

export class Histogram {
  private readonly counts = new Uint32Array(NUM_BUCKETS);
  private _count = 0;
  private _maxUs = 0;
  /** Reservoir for total — used to compute mean. */
  private _sumUs = 0;

  record(us: number): void {
    if (us < 0 || !Number.isFinite(us)) return;
    const idx = bucketIndex(us);
    this.counts[idx] = (this.counts[idx] ?? 0) + 1;
    this._count++;
    this._sumUs += us;
    if (us > this._maxUs) this._maxUs = us;
  }

  /** Returns the value at quantile `q` ∈ [0, 1] in µs, interpolated within the target bucket. */
  quantile(q: number): number {
    if (this._count === 0) return 0;
    const target = q * this._count;
    let cum = 0;
    for (let i = 0; i < NUM_BUCKETS; i++) {
      const c = this.counts[i] ?? 0;
      if (c === 0) continue;
      cum += c;
      if (cum >= target) {
        // Linear interpolation within the bucket.
        const lo = bucketLowerBoundUs(i);
        const hi = bucketUpperBoundUs(i);
        const fracIntoBucket = (cum - target) / c;
        return Math.round(hi - fracIntoBucket * (hi - lo));
      }
    }
    return Math.round(this._maxUs);
  }

  count(): number { return this._count; }
  maxUs(): number { return Math.round(this._maxUs); }
  meanUs(): number { return this._count === 0 ? 0 : Math.round(this._sumUs / this._count); }

  /** The raw buckets, for sending to another thread. */
  export_(): HistogramParts {
    return { counts: Array.from(this.counts), count: this._count, sum_us: this._sumUs, max_us: this._maxUs };
  }

  /** This histogram plus `parts`, as a new histogram. */
  plus(parts: HistogramParts): Histogram {
    const h = new Histogram();
    for (let i = 0; i < NUM_BUCKETS; i++) h.counts[i] = (this.counts[i] ?? 0) + (parts.counts[i] ?? 0);
    h._count = this._count + parts.count;
    h._sumUs = this._sumUs + parts.sum_us;
    h._maxUs = Math.max(this._maxUs, parts.max_us);
    return h;
  }

  reset(): void {
    this.counts.fill(0);
    this._count = 0;
    this._maxUs = 0;
    this._sumUs = 0;
  }

  snapshot(): {
    count: number;
    p50_us: number; p90_us: number; p99_us: number; p99_9_us: number; p99_99_us: number;
    max_us: number; mean_us: number;
  } {
    return {
      count: this._count,
      p50_us:    this.quantile(0.5),
      p90_us:    this.quantile(0.9),
      p99_us:    this.quantile(0.99),
      p99_9_us:  this.quantile(0.999),
      p99_99_us: this.quantile(0.9999),
      max_us:    this.maxUs(),
      mean_us:   this.meanUs(),
    };
  }
}

// ── Sliding-window RPS tracker ──────────────────────────────────────────────

/**
 * 60×1-second buckets — counts requests per second so /metrics can report
 * a 1-minute rolling RPS without locking the timer on a global atomic.
 */
class RpsTracker {
  private readonly buckets = new Uint32Array(60);
  private lastTickSec = Math.floor(Date.now() / 1000);

  bump(): void {
    const now = Math.floor(Date.now() / 1000);
    const drift = Math.min(60, now - this.lastTickSec);
    for (let i = 0; i < drift; i++) {
      this.lastTickSec++;
      this.buckets[this.lastTickSec % 60] = 0;
    }
    const idx = now % 60;
    this.buckets[idx] = (this.buckets[idx] ?? 0) + 1;
  }

  rps1min(): number {
    // Force-tick to evict stale buckets.
    this.bump();
    this.buckets[Math.floor(Date.now() / 1000) % 60]!--;
    let total = 0;
    for (let i = 0; i < 60; i++) total += this.buckets[i] ?? 0;
    return Math.round(total / 60);
  }
}

// ── Per-second live series ──────────────────────────────────────────────────

/** One second of traffic, as the admin Metrics page charts it. */
export interface SecondSample {
  /** Unix seconds. */
  t: number;
  reqs: number;
  writes: number;
  errors: number;
  /** Mean end-to-end latency over the second, µs. 0 when idle. */
  mean_us: number;
  max_us: number;
}

const SERIES_SECONDS = 120;

/**
 * Ring of the last {@link SERIES_SECONDS} seconds. Typed arrays indexed by
 * `sec % N`; a slot is cleared lazily the first time a new second lands in
 * it, so recording stays O(1) with no timers.
 */
class SecondSeries {
  private readonly sec = new Float64Array(SERIES_SECONDS);
  private readonly reqs = new Uint32Array(SERIES_SECONDS);
  private readonly writes = new Uint32Array(SERIES_SECONDS);
  private readonly errors = new Uint32Array(SERIES_SECONDS);
  private readonly sumUs = new Float64Array(SERIES_SECONDS);
  private readonly maxUs = new Float64Array(SERIES_SECONDS);

  private slot(now: number): number {
    const i = now % SERIES_SECONDS;
    if (this.sec[i] !== now) {
      this.sec[i] = now;
      this.reqs[i] = 0;
      this.writes[i] = 0;
      this.errors[i] = 0;
      this.sumUs[i] = 0;
      this.maxUs[i] = 0;
    }
    return i;
  }

  record(totalUs: number, write: boolean, error: boolean): void {
    const i = this.slot(Math.floor(Date.now() / 1000));
    this.reqs[i]!++;
    if (write) this.writes[i]!++;
    if (error) this.errors[i]!++;
    this.sumUs[i]! += totalUs;
    if (totalUs > this.maxUs[i]!) this.maxUs[i] = totalUs;
  }

  /** Oldest → newest, one entry per second, idle seconds included as zeros. */
  snapshot(): SecondSample[] {
    const now = Math.floor(Date.now() / 1000);
    const out: SecondSample[] = [];
    for (let t = now - SERIES_SECONDS + 1; t <= now; t++) {
      const i = t % SERIES_SECONDS;
      if (this.sec[i] !== t) {
        out.push({ t, reqs: 0, writes: 0, errors: 0, mean_us: 0, max_us: 0 });
        continue;
      }
      const n = this.reqs[i]!;
      out.push({
        t,
        reqs: n,
        writes: this.writes[i]!,
        errors: this.errors[i]!,
        mean_us: n ? Math.round(this.sumUs[i]! / n) : 0,
        max_us: Math.round(this.maxUs[i]!),
      });
    }
    return out;
  }

  reset(): void {
    this.sec.fill(0);
  }
}

// ── Registry ────────────────────────────────────────────────────────────────

export interface MetricsSnapshot {
  uptime_seconds: number;
  requests_total: number;
  rps_1min: number;
  steps: Record<Step, ReturnType<Histogram["snapshot"]>>;
  /** End-to-end handler latency, all requests. */
  total: ReturnType<Histogram["snapshot"]>;
  /** End-to-end latency split by read (GET/HEAD) vs write (everything else). */
  reads: ReturnType<Histogram["snapshot"]>;
  writes: ReturnType<Histogram["snapshot"]>;
  status: { "2xx": number; "3xx": number; "4xx": number; "5xx": number };
  methods: Record<string, number>;
  series: SecondSample[];
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** A registry's request figures, as a read worker posts them for the requests it accepted itself. */
export interface RequestParts {
  requests_total: number;
  rps_1min: number;
  total: HistogramParts;
  reads: HistogramParts;
  writes: HistogramParts;
  status: MetricsSnapshot["status"];
  methods: Record<string, number>;
  series: SecondSample[];
}

export class MetricsRegistry {
  private readonly histograms: Record<Step, Histogram> = Object.create(null);
  /**
   * Step histograms reported by read worker threads, latest per worker.
   * Forwarded requests are timed end to end on the main thread, so only
   * the steps come from the worker; its own totals are not added.
   */
  private readonly external = new Map<string, Partial<Record<Step, HistogramParts>>>();
  /**
   * Request figures reported by read workers for the connections they
   * accepted themselves (core/worker-listeners.ts), latest per worker.
   * Those requests never reach this thread, so these are added in full.
   */
  private readonly externalRequests = new Map<string, RequestParts>();
  private readonly rps = new RpsTracker();
  private readonly total = new Histogram();
  private readonly reads = new Histogram();
  private readonly writes = new Histogram();
  private readonly series = new SecondSeries();
  private status = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
  private methods: Record<string, number> = Object.create(null);
  private requestsTotal = 0;
  private startedAt = Date.now();

  constructor() {
    for (const s of STEPS) this.histograms[s] = new Histogram();
  }

  recordStep(step: Step, us: number): void {
    const h = this.histograms[step];
    if (h) h.record(us);
  }

  /** The step histograms as parts, for a worker to post. */
  exportSteps(): Partial<Record<Step, HistogramParts>> {
    const out: Partial<Record<Step, HistogramParts>> = {};
    for (const s of STEPS) { const h = this.histograms[s]!; if (h.count() > 0) out[s] = h.export_(); }
    return out;
  }

  /** Replace what one worker last reported. `null` forgets it. */
  setExternalSteps(id: string, steps: Partial<Record<Step, HistogramParts>> | null): void {
    if (steps) this.external.set(id, steps); else this.external.delete(id);
  }

  /** The request figures as parts, for a worker to post. */
  exportRequests(): RequestParts {
    return {
      requests_total: this.requestsTotal,
      rps_1min: this.rps.rps1min(),
      total: this.total.export_(),
      reads: this.reads.export_(),
      writes: this.writes.export_(),
      status: { ...this.status },
      methods: { ...this.methods },
      series: this.series.snapshot(),
    };
  }

  /** Replace the request figures one worker last reported. `null` forgets them. */
  setExternalRequests(id: string, parts: RequestParts | null): void {
    if (parts) this.externalRequests.set(id, parts); else this.externalRequests.delete(id);
  }

  finalizeRequest(totalUs?: number, method?: string, status?: number): void {
    this.requestsTotal++;
    this.rps.bump();
    if (totalUs === undefined) return;
    const m = (method ?? "GET").toUpperCase();
    const write = !READ_METHODS.has(m);
    const code = status ?? 200;
    this.total.record(totalUs);
    (write ? this.writes : this.reads).record(totalUs);
    this.methods[m] = (this.methods[m] ?? 0) + 1;
    if (code >= 500) this.status["5xx"]++;
    else if (code >= 400) this.status["4xx"]++;
    else if (code >= 300) this.status["3xx"]++;
    else this.status["2xx"]++;
    this.series.record(totalUs, write, code >= 500);
  }

  reset(): void {
    for (const s of STEPS) this.histograms[s]!.reset();
    this.external.clear();
    this.externalRequests.clear();
    this.total.reset();
    this.reads.reset();
    this.writes.reset();
    this.series.reset();
    this.status = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0 };
    this.methods = Object.create(null);
    this.requestsTotal = 0;
    this.startedAt = Date.now();
  }

  snapshot(): MetricsSnapshot {
    const stepsOut = Object.create(null) as MetricsSnapshot["steps"];
    for (const s of STEPS) {
      let h = this.histograms[s]!;
      for (const ext of this.external.values()) { const parts = ext[s]; if (parts) h = h.plus(parts); }
      stepsOut[s] = h.snapshot();
    }
    let requestsTotal = this.requestsTotal;
    let rps1min = this.rps.rps1min();
    let total = this.total, reads = this.reads, writes = this.writes;
    const status = { ...this.status };
    const methods: Record<string, number> = { ...this.methods };
    const series = this.series.snapshot();
    for (const ext of this.externalRequests.values()) {
      requestsTotal += ext.requests_total;
      rps1min += ext.rps_1min;
      total = total.plus(ext.total);
      reads = reads.plus(ext.reads);
      writes = writes.plus(ext.writes);
      for (const k of Object.keys(status) as Array<keyof typeof status>) status[k] += ext.status[k];
      for (const [m, n] of Object.entries(ext.methods)) methods[m] = (methods[m] ?? 0) + n;
      mergeSeries(series, ext.series);
    }
    return {
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
      requests_total: requestsTotal,
      rps_1min: rps1min,
      steps: stepsOut,
      total: total.snapshot(),
      reads: reads.snapshot(),
      writes: writes.snapshot(),
      status,
      methods,
      series,
    };
  }
}

/** Add `other`'s seconds into `into`, matched on `t` (both oldest → newest). */
function mergeSeries(into: SecondSample[], other: SecondSample[]): void {
  const byT = new Map(into.map((x) => [x.t, x]));
  for (const o of other) {
    const x = byT.get(o.t);
    if (!x || o.reqs === 0) continue;
    const n = x.reqs + o.reqs;
    x.mean_us = Math.round((x.mean_us * x.reqs + o.mean_us * o.reqs) / n);
    x.reqs = n;
    x.writes += o.writes;
    x.errors += o.errors;
    x.max_us = Math.max(x.max_us, o.max_us);
  }
}

export const globalMetrics = new MetricsRegistry();

// ── Per-request timer ───────────────────────────────────────────────────────

export class RequestTimer {
  /** Per-step accumulated microseconds (a step can be recorded multiple times in one request). */
  private readonly stepUs: Partial<Record<Step, number>> = Object.create(null);
  private readonly startedAt = performance.now();

  /** Add `us` to a step's tally for this request. */
  add(step: Step, us: number): void {
    this.stepUs[step] = (this.stepUs[step] ?? 0) + us;
  }

  /** Roll into the global histograms. Call exactly once at request end. */
  finish(method?: string, status?: number): void {
    for (const s of STEPS) {
      const v = this.stepUs[s];
      if (v !== undefined) globalMetrics.recordStep(s, v);
    }
    globalMetrics.finalizeRequest((performance.now() - this.startedAt) * 1000, method, status);
  }
}

/**
 * Per-Request timer registry. Elysia gives us the live `Request` object in
 * every handler/middleware, so we key by it directly — avoids the
 * AsyncLocalStorage plumbing that would otherwise be required to thread
 * timing context through deep records-core calls.
 *
 * `WeakMap` ensures timers get GC'd if a request is dropped before
 * `finalizeRequest` (rare, but defensive).
 */
const timersByRequest = new WeakMap<Request, RequestTimer>();

export function attachTimer(request: Request, timer: RequestTimer): void {
  timersByRequest.set(request, timer);
}

export function getTimer(request: Request): RequestTimer | undefined {
  return timersByRequest.get(request);
}

export function detachTimer(request: Request): RequestTimer | undefined {
  const t = timersByRequest.get(request);
  if (t) timersByRequest.delete(request);
  return t;
}

/**
 * Time `fn` and accumulate the duration into the request's timer's `step`.
 * No-op (just calls `fn`) when no timer is registered for `request` — safe to
 * use unconditionally on hot paths.
 */
export function timeFor<T>(request: Request | undefined, step: Step, fn: () => T): T {
  const timer = request ? timersByRequest.get(request) : undefined;
  if (!timer) return fn();
  const t0 = performance.now();
  const result = fn();
  if (result && typeof (result as { then?: unknown }).then === "function") {
    return (result as unknown as Promise<unknown>).then(
      (v) => { timer.add(step, (performance.now() - t0) * 1000); return v; },
      (e) => { timer.add(step, (performance.now() - t0) * 1000); throw e; },
    ) as unknown as T;
  }
  timer.add(step, (performance.now() - t0) * 1000);
  return result;
}

/** Manual record by request handle — for cases where the work spans non-callable boundaries. */
export function markStepFor(request: Request | undefined, step: Step, us: number): void {
  const timer = request ? timersByRequest.get(request) : undefined;
  if (timer) timer.add(step, us);
}
