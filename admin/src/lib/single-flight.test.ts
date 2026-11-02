import { describe, expect, it } from "bun:test";
import { singleFlight } from "./single-flight.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("singleFlight", () => {
  it("joins calls made while a run is in flight", async () => {
    const gates = [deferred()];
    let runs = 0;
    const load = singleFlight(() => { runs++; return gates[runs - 1]!.promise; });
    const a = load();
    const b = load();
    expect(runs).toBe(1);
    gates[0]!.resolve();
    await Promise.all([a, b]);
    expect(runs).toBe(1);
  });

  it("runs once more after the current run when a rerun is asked mid-flight", async () => {
    const gates = [deferred(), deferred()];
    let runs = 0;
    const load = singleFlight(() => { runs++; return gates[runs - 1]!.promise; });
    const first = load();
    const forced = load(true);
    const forcedAgain = load(true);
    expect(forcedAgain).toBe(forced);
    gates[0]!.resolve();
    await first;
    await Promise.resolve();
    expect(runs).toBe(2);
    gates[1]!.resolve();
    await forced;
    expect(runs).toBe(2);
  });

  it("does not stay stuck after a failed run", async () => {
    let runs = 0;
    const load = singleFlight(async () => { runs++; if (runs === 1) throw new Error("boom"); });
    await expect(load()).rejects.toThrow("boom");
    await load();
    expect(runs).toBe(2);
  });
});
