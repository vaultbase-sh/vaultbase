/**
 * Cluster mode (decision: restrict and document). Every worker ran the cron
 * scheduler, which has no run claim, so each cron job ran once per worker;
 * daily prunes and update checks likewise. These now run on worker 0 only.
 */
import { describe, expect, it } from "bun:test";
import { isClusterWorker, runsSingletonDuties } from "../core/cluster-role.ts";

describe("cluster roles", () => {
  it("only worker 0 runs once-per-install duties", () => {
    expect(runsSingletonDuties({ VAULTBASE_WORKER_ID: "0" })).toBe(true);
    expect(runsSingletonDuties({ VAULTBASE_WORKER_ID: "1" })).toBe(false);
    expect(runsSingletonDuties({ VAULTBASE_WORKER_ID: "3" })).toBe(false);
  });

  it("a single process runs them (legitimate path)", () => {
    expect(runsSingletonDuties({})).toBe(true);
    expect(isClusterWorker({})).toBe(false);
    expect(isClusterWorker({ VAULTBASE_WORKER_ID: "0" })).toBe(true);
  });
});
