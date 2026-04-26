import { describe, expect, it } from "bun:test";
import { evaluateRule } from "../core/rules.ts";

describe("RuleEngine", () => {
  it("null rule = public access", () => {
    expect(evaluateRule(null, null, null)).toBe(true);
  });

  it("empty string = admin only, denied for user", () => {
    expect(evaluateRule("", { id: "u1", type: "user" }, null)).toBe(false);
  });

  it("empty string = admin only, allowed for admin", () => {
    expect(evaluateRule("", { id: "a1", type: "admin" }, null)).toBe(true);
  });

  it("@request.auth.id != '' requires auth", () => {
    expect(evaluateRule('@request.auth.id != ""', null, null)).toBe(false);
    expect(
      evaluateRule('@request.auth.id != ""', { id: "u1", type: "user" }, null)
    ).toBe(true);
  });

  it("@request.auth.id = id matches record owner", () => {
    expect(
      evaluateRule("@request.auth.id = id", { id: "u1", type: "user" }, "u1")
    ).toBe(true);
    expect(
      evaluateRule("@request.auth.id = id", { id: "u1", type: "user" }, "u2")
    ).toBe(false);
  });
});
