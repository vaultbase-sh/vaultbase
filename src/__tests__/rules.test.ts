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

describe("rule engine agrees with the SQL", () => {
  it("`@request.auth.id = null` holds for a caller who isn't signed in", () => {
    expect(evaluateRule("@request.auth.id = null", null, {})).toBe(true);
    expect(evaluateRule("@request.auth.id != null", null, {})).toBe(false);
    expect(evaluateRule("@request.auth.id = null", { id: "u1", type: "user" }, {})).toBe(false);
  });

  it("an owner check still refuses anonymous callers (legitimate path)", () => {
    expect(evaluateRule("@request.auth.id = owner", null, { owner: null })).toBe(false);
  });

  it("strftime reads %% as a literal percent", () => {
    expect(evaluateRule(`strftime('%Y%%', '2024-05-01') = "2024%"`, { id: "u1", type: "user" }, {})).toBe(true);
  });
});

describe("~ with wildcards written in the rule", () => {
  const u = { id: "u1", type: "user" as const };
  it("% and _ match as they do in the SQL", () => {
    expect(evaluateRule(`email ~ "%@corp.com"`, u, { email: "a@corp.com" })).toBe(true);
    expect(evaluateRule(`code ~ "a_c"`, u, { code: "xABCx" })).toBe(true);
    expect(evaluateRule(`email ~ "%@corp.com"`, u, { email: "a@other.com" })).toBe(false);
    expect(evaluateRule(`email !~ "%@corp.com"`, u, { email: "a@other.com" })).toBe(true);
  });

  it("a value from the request stays plain text (legitimate path)", () => {
    expect(evaluateRule(`email ~ @request.query.q`, u, { email: "a@corp.com" }, { query: { q: "%corp" } } as never)).toBe(false);
  });
});

describe("comparisons agree with the SQL", () => {
  const u = { id: "u1", type: "user" as const };
  it("text compares by code point, without turning digits into numbers", () => {
    expect(evaluateRule(`name > "a"`, u, { name: "B" })).toBe(false);
    expect(evaluateRule(`code > "9"`, u, { code: "10" })).toBe(false);
    expect(evaluateRule(`code < "9"`, u, { code: "10" })).toBe(true);
  });

  it("an empty string isn't 0", () => {
    expect(evaluateRule(`n = 0`, u, { n: "" })).toBe(false);
  });

  it("numbers still compare as numbers (legitimate path)", () => {
    expect(evaluateRule(`n > 9`, u, { n: 10 })).toBe(true);
  });
});
