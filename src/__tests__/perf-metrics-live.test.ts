import { describe, expect, test } from "bun:test";
import { MetricsRegistry } from "../core/perf-metrics.ts";

describe("MetricsRegistry live fields", () => {
  test("splits reads and writes, counts status classes and methods", () => {
    const m = new MetricsRegistry();
    m.finalizeRequest(100, "GET", 200);
    m.finalizeRequest(200, "POST", 201);
    m.finalizeRequest(300, "PATCH", 404);
    m.finalizeRequest(400, "DELETE", 500);
    const s = m.snapshot();
    expect(s.total.count).toBe(4);
    expect(s.reads.count).toBe(1);
    expect(s.writes.count).toBe(3);
    expect(s.status).toEqual({ "2xx": 2, "3xx": 0, "4xx": 1, "5xx": 1 });
    expect(s.methods).toEqual({ GET: 1, POST: 1, PATCH: 1, DELETE: 1 });
  });

  test("series covers 120 seconds and holds this second's traffic", () => {
    const m = new MetricsRegistry();
    m.finalizeRequest(1_000, "POST", 200);
    m.finalizeRequest(3_000, "GET", 503);
    const series = m.snapshot().series;
    expect(series).toHaveLength(120);
    const now = series[series.length - 1]!;
    expect(now.t).toBe(Math.floor(Date.now() / 1000));
    expect(now).toMatchObject({ reqs: 2, writes: 1, errors: 1, mean_us: 2_000, max_us: 3_000 });
    expect(series[0]!.reqs).toBe(0);
  });

  test("reset clears the live fields", () => {
    const m = new MetricsRegistry();
    m.finalizeRequest(500, "POST", 200);
    m.reset();
    const s = m.snapshot();
    expect(s.writes.count).toBe(0);
    expect(s.methods).toEqual({});
    expect(s.series.every((x) => x.reqs === 0)).toBe(true);
  });

  test("bare finalizeRequest keeps the old counter-only behaviour", () => {
    const m = new MetricsRegistry();
    m.finalizeRequest();
    const s = m.snapshot();
    expect(s.requests_total).toBe(1);
    expect(s.total.count).toBe(0);
  });
});

describe("steps reported by read workers", () => {
  test("a worker's histogram parts add into the snapshot and reset forgets them", () => {
    const m = new MetricsRegistry();
    m.recordStep("db_exec", 100);
    const worker = new MetricsRegistry();
    worker.recordStep("db_exec", 300);
    worker.recordStep("db_exec", 500);
    worker.recordStep("serialize", 40);
    m.setExternalSteps("w0", worker.exportSteps());
    let s = m.snapshot();
    expect(s.steps.db_exec.count).toBe(3);
    expect(s.steps.db_exec.max_us).toBe(500);
    expect(s.steps.db_exec.mean_us).toBe(300);
    expect(s.steps.serialize.count).toBe(1);
    // Totals are the main thread's own: the worker's requests were timed here.
    expect(s.total.count).toBe(0);
    m.setExternalSteps("w0", null);
    expect(m.snapshot().steps.db_exec.count).toBe(1);
    m.setExternalSteps("w0", worker.exportSteps());
    m.reset();
    s = m.snapshot();
    expect(s.steps.db_exec.count).toBe(0);
  });
});
