/**
 * Percentage rollouts reach the share they say: the bucket hash multiplied
 * past 2^53 and lost bits, so a 10 % rollout reached about 11 %. And a
 * `regex` rule runs a cached pattern against bounded input.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { evaluate, invalidateFlagCache, upsertFlag } from "../core/flags.ts";

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  invalidateFlagCache();
});
afterEach(() => closeDb());

describe("rollout", () => {
  it("a 10 % rollout reaches 10 % of users, within half a point", async () => {
    await upsertFlag({ key: "beta", type: "bool", enabled: true, default_value: false, rules: [{ id: "r1", rollout: { value: 10, sticky: "user.id" }, variation: "true" }] } as never);
    let on = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      // Fixed ids: the same buckets every run (random ones made the check flaky).
      const r = await evaluate("beta", { user: { id: `user-${i}` } } as never);
      if (r.reason === "rule_match") on++;
    }
    expect(Math.abs(on / n - 0.1)).toBeLessThan(0.005);
  });
});

describe("regex rules", () => {
  it("match a short value, and refuse a value over the length cap", async () => {
    await upsertFlag({ key: "corp", type: "bool", enabled: true, default_value: false, rules: [{ id: "r1", when: { attr: "user.email", op: "regex", value: "@corp\\.com$" }, variation: "true" }] } as never);
    expect((await evaluate("corp", { user: { email: "a@corp.com" } } as never)).reason).toBe("rule_match");
    expect((await evaluate("corp", { user: { email: "a".repeat(5000) + "@corp.com" } } as never)).reason).not.toBe("rule_match");
  });
});
