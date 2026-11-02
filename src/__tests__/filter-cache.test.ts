/**
 * Expressions over 4096 characters were cached under their length, so two
 * different ones of the same length shared one parse.
 */
import { describe, expect, it } from "bun:test";
import { cachedParseExpression } from "../core/filter-cache.ts";

describe("filter cache", () => {
  it("two long expressions of the same length keep their own parse", () => {
    const pad = " ".repeat(5000);
    const a = cachedParseExpression(`title = "a"${pad}`);
    const b = cachedParseExpression(`title = "b"${pad}`);
    expect(JSON.stringify(a)).toContain('"a"');
    expect(JSON.stringify(b)).toContain('"b"');
  });
});
