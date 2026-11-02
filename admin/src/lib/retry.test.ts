import { describe, expect, it } from "bun:test";
import { retryDelay } from "./retry.ts";

describe("retryDelay", () => {
  it("starts at 2 s and doubles", () => {
    expect([0, 1, 2, 3].map(retryDelay)).toEqual([2_000, 4_000, 8_000, 16_000]);
  });

  it("caps at 30 s, even for huge or bad attempt counts", () => {
    expect(retryDelay(4)).toBe(30_000);
    expect(retryDelay(1_000)).toBe(30_000);
    expect(retryDelay(-3)).toBe(2_000);
  });
});
