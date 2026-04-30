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

// ── Registry ────────────────────────────────────────────────────────────────

export interface MetricsSnapshot {
  uptime_seconds: number;
  requests_total: number;
  rps_1min: number;
  steps: Record<Step, ReturnType<Histogram["snapshot"]>>;
}

export class MetricsRegistry {
  private readonly histograms: Record<Step, Histogram> = Object.create(null);
  private readonly rps = new RpsTracker();
  private requestsTotal = 0;
  private startedAt = Date.now();

  constructor() {
    for (const s of STEPS) this.histograms[s] = new Histogram();
  }

  recordStep(step: Step, us: number): void {
    const h = this.histograms[step];
    if (h) h.record(us);
  }

  finalizeRequest(): void {
    this.requestsTotal++;
    this.rps.bump();
  }

  reset(): void {
    for (const s of STEPS) this.histograms[s]!.reset();
    this.requestsTotal = 0;
    this.startedAt = Date.now();
  }

  snapshot(): MetricsSnapshot {
    const stepsOut = Object.create(null) as MetricsSnapshot["steps"];
    for (const s of STEPS) stepsOut[s] = this.histograms[s]!.snapshot();
    return {
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
      requests_total: this.requestsTotal,
      rps_1min: this.rps.rps1min(),
      steps: stepsOut,
    };
  }
}

export const globalMetrics = new MetricsRegistry();

// ── Per-request timer ───────────────────────────────────────────────────────

export class RequestTimer {
  /** Per-step accumulated microseconds (a step can be recorded multiple times in one request). */
  private readonly stepUs: Partial<Record<Step, number>> = Object.create(null);

  /** Add `us` to a step's tally for this request. */
  add(step: Step, us: number): void {
    this.stepUs[step] = (this.stepUs[step] ?? 0) + us;
  }

  /** Roll into the global histograms. Call exactly once at request end. */
  finish(): void {
    for (const s of STEPS) {
      const v = this.stepUs[s];
      if (v !== undefined) globalMetrics.recordStep(s, v);
    }
    globalMetrics.finalizeRequest();
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
