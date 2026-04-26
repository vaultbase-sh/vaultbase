import { describe, expect, it } from "bun:test";
import { evaluateRule } from "../core/rules.ts";

describe("evaluateRule — special cases", () => {
  it("null rule = public access", () => {
    expect(evaluateRule(null, null, null)).toBe(true);
  });

  it("empty string = admin only, denied for user", () => {
    expect(evaluateRule("", { id: "u1", type: "user" }, null)).toBe(false);
  });

  it("empty string = admin only, allowed for admin", () => {
    expect(evaluateRule("", { id: "a1", type: "admin" }, null)).toBe(true);
  });

  it("admin bypasses any expression rule", () => {
    expect(evaluateRule(
      "author = @request.auth.id",
      { id: "a1", type: "admin" },
      { id: "rec1", author: "someone-else" }
    )).toBe(true);
  });
});

describe("evaluateRule — @request.auth", () => {
  it("@request.auth.id != \"\" requires auth", () => {
    expect(evaluateRule('@request.auth.id != ""', null, {})).toBe(false);
    expect(evaluateRule('@request.auth.id != ""', { id: "u1", type: "user" }, {})).toBe(true);
  });

  it("@request.auth.id = id matches record owner via id field", () => {
    expect(evaluateRule(
      "@request.auth.id = id",
      { id: "u1", type: "user" },
      { id: "u1" }
    )).toBe(true);
    expect(evaluateRule(
      "@request.auth.id = id",
      { id: "u1", type: "user" },
      { id: "u2" }
    )).toBe(false);
  });

  it("author = @request.auth.id checks author field", () => {
    expect(evaluateRule(
      "author = @request.auth.id",
      { id: "u1", type: "user" },
      { id: "rec1", author: "u1" }
    )).toBe(true);
    expect(evaluateRule(
      "author = @request.auth.id",
      { id: "u1", type: "user" },
      { id: "rec1", author: "u2" }
    )).toBe(false);
  });

  it("@request.auth.email matches", () => {
    expect(evaluateRule(
      "owner_email = @request.auth.email",
      { id: "u1", type: "user", email: "alice@x.com" },
      { owner_email: "alice@x.com" }
    )).toBe(true);
  });

  it("@request.auth.type checks user vs admin", () => {
    expect(evaluateRule(
      "@request.auth.type = 'user'",
      { id: "u1", type: "user" },
      {}
    )).toBe(true);
  });
});

describe("evaluateRule — operators", () => {
  it("equality on bool field", () => {
    expect(evaluateRule("published = true", null, { published: true })).toBe(true);
    expect(evaluateRule("published = true", null, { published: false })).toBe(false);
  });

  it("numeric > and <", () => {
    expect(evaluateRule("age > 18", null, { age: 25 })).toBe(true);
    expect(evaluateRule("age > 18", null, { age: 18 })).toBe(false);
    expect(evaluateRule("age >= 18", null, { age: 18 })).toBe(true);
    expect(evaluateRule("age < 100", null, { age: 50 })).toBe(true);
  });

  it("LIKE (~) operator", () => {
    expect(evaluateRule("title ~ 'hello'", null, { title: "say hello world" })).toBe(true);
    expect(evaluateRule("title ~ 'xyz'", null, { title: "say hello world" })).toBe(false);
  });

  it("null comparison", () => {
    expect(evaluateRule("author = null", null, { author: null })).toBe(true);
    expect(evaluateRule("author != null", null, { author: "u1" })).toBe(true);
  });
});

describe("evaluateRule — boolean composition", () => {
  it("AND (&&)", () => {
    expect(evaluateRule(
      "published = true && @request.auth.id != \"\"",
      { id: "u1", type: "user" },
      { published: true }
    )).toBe(true);
    expect(evaluateRule(
      "published = true && @request.auth.id != \"\"",
      null,
      { published: true }
    )).toBe(false);
  });

  it("OR (||)", () => {
    expect(evaluateRule(
      "author = @request.auth.id || published = true",
      null,
      { author: "u2", published: true }
    )).toBe(true);
    expect(evaluateRule(
      "author = @request.auth.id || published = true",
      null,
      { author: "u2", published: false }
    )).toBe(false);
  });

  it("parenthesized groups", () => {
    expect(evaluateRule(
      "(status = 'published' || status = 'draft') && author = @request.auth.id",
      { id: "u1", type: "user" },
      { status: "published", author: "u1" }
    )).toBe(true);
    expect(evaluateRule(
      "(status = 'published' || status = 'draft') && author = @request.auth.id",
      { id: "u1", type: "user" },
      { status: "archived", author: "u1" }
    )).toBe(false);
  });
});

describe("evaluateRule — error handling", () => {
  it("malformed rule denies access", () => {
    expect(evaluateRule("???", null, {})).toBe(false);
    expect(evaluateRule("field", null, {})).toBe(false);
  });
});
