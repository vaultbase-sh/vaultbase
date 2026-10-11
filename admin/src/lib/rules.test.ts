/**
 * The admin editor's rule mapping.
 *
 * `null` (public) and `""` (admin-only) are opposites server-side, and the
 * editor used to render both as an empty string and write `value || null` on
 * save — so opening any collection and pressing Save republished every
 * admin-only rule on it. These tests pin the three states apart, and pin the
 * round trip that regression broke.
 */
import { describe, expect, it } from "bun:test";
import {
  AUTH_ONLY_EXPR,
  describeRule,
  fromRuleSet,
  fromRuleValue,
  toRuleSet,
  toRuleValue,
  type StoredRules,
} from "./rules.ts";

describe("toRuleValue", () => {
  it("reads null as public", () => {
    expect(toRuleValue(null)).toEqual({ mode: "public", expr: "" });
  });

  it("reads a missing rule as public, matching the API's own absence", () => {
    expect(toRuleValue(undefined)).toEqual({ mode: "public", expr: "" });
  });

  it("reads the empty string as admin-only — not as public", () => {
    expect(toRuleValue("")).toEqual({ mode: "admin", expr: "" });
  });

  it("reads anything else as an expression", () => {
    expect(toRuleValue(AUTH_ONLY_EXPR)).toEqual({ mode: "expr", expr: AUTH_ONLY_EXPR });
  });
});

describe("fromRuleValue", () => {
  it("writes public as null", () => {
    expect(fromRuleValue({ mode: "public", expr: "" })).toBeNull();
  });

  it("writes admin as the empty string", () => {
    expect(fromRuleValue({ mode: "admin", expr: "" })).toBe("");
  });

  it("writes an expression verbatim", () => {
    expect(fromRuleValue({ mode: "expr", expr: 'a = "b"' })).toBe('a = "b"');
  });

  it("resolves a blank custom expression to admin-only, never to public", () => {
    // Ambiguous input must deny rather than publish.
    expect(fromRuleValue({ mode: "expr", expr: "   " })).toBe("");
  });

  it("keeps a retained expression out of the payload when the mode is not expr", () => {
    // Switching to Public must not smuggle the old expression back.
    expect(fromRuleValue({ mode: "public", expr: 'a = "b"' })).toBeNull();
    expect(fromRuleValue({ mode: "admin", expr: 'a = "b"' })).toBe("");
  });
});

describe("round trip", () => {
  const cases: StoredRules[] = [
    { list_rule: "", view_rule: "", create_rule: "", update_rule: "", delete_rule: "" },
    { list_rule: null, view_rule: null, create_rule: null, update_rule: null, delete_rule: null },
    {
      list_rule: AUTH_ONLY_EXPR,
      view_rule: "",
      create_rule: null,
      update_rule: 'owner = @request.auth.id',
      delete_rule: "",
    },
  ];

  for (const [i, stored] of cases.entries()) {
    it(`load → save is lossless for case ${i + 1}`, () => {
      expect(fromRuleSet(toRuleSet(stored))).toEqual(stored);
    });
  }

  it("an admin-only collection survives an open-and-save with no edits", () => {
    // The exact regression: every rule "" in, every rule "" out.
    const stored: StoredRules = {
      list_rule: "", view_rule: "", create_rule: "", update_rule: "", delete_rule: "",
    };
    const afterSave = fromRuleSet(toRuleSet(stored));
    expect(afterSave.list_rule).toBe("");
    expect(afterSave.view_rule).toBe("");
    expect(afterSave.create_rule).toBe("");
    expect(afterSave.update_rule).toBe("");
    expect(afterSave.delete_rule).toBe("");
    // Specifically: none of them became null.
    expect(Object.values(afterSave).some((v) => v === null)).toBe(false);
  });
});

describe("describeRule", () => {
  it("never calls an admin-only rule public", () => {
    expect(describeRule({ mode: "admin", expr: "" })).toBe("// admin only");
    expect(describeRule({ mode: "public", expr: "" })).toContain("public");
    expect(describeRule({ mode: "expr", expr: 'a = "b"' })).toBe('a = "b"');
  });
});
