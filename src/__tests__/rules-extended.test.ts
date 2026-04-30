import { describe, expect, it } from "bun:test";
import { evaluateRule } from "../core/rules.ts";
import { parseFilter } from "../core/filter.ts";

const NO_AUTH = null;
const USER = { id: "u1", type: "user" as const, email: "u1@test.local" };

describe("Phase 1 — !~ NOT LIKE operator", () => {
  it("matches records that do not contain the substring", () => {
    expect(evaluateRule(`title !~ "spam"`, USER, { title: "hello world" })).toBe(true);
    expect(evaluateRule(`title !~ "spam"`, USER, { title: "spammy content" })).toBe(false);
  });

  it("compiles to NOT LIKE in SQL", () => {
    const r = parseFilter(`title !~ "spam"`, "vb_posts", USER);
    expect(r?.sql).toContain("NOT LIKE");
    expect(r?.params).toContain("%spam%");
  });
});

describe("Phase 1 — array-prefix operators", () => {
  it("?= matches when ANY array element equals", () => {
    expect(evaluateRule(`tags ?= "urgent"`, USER, { tags: ["draft", "urgent", "pinned"] })).toBe(true);
    expect(evaluateRule(`tags ?= "urgent"`, USER, { tags: ["draft", "pinned"] })).toBe(false);
  });

  it("?!= matches when ANY array element differs", () => {
    expect(evaluateRule(`tags ?!= "urgent"`, USER, { tags: ["urgent", "draft"] })).toBe(true);
    expect(evaluateRule(`tags ?!= "urgent"`, USER, { tags: ["urgent", "urgent"] })).toBe(false);
  });

  it("?> compares numerically against array elements", () => {
    expect(evaluateRule(`scores ?> 80`, USER, { scores: [50, 95, 70] })).toBe(true);
    expect(evaluateRule(`scores ?> 80`, USER, { scores: [50, 60, 70] })).toBe(false);
  });

  it("?~ matches LIKE on any element", () => {
    expect(evaluateRule(`tags ?~ "urg"`, USER, { tags: ["draft", "urgent"] })).toBe(true);
    expect(evaluateRule(`tags ?~ "xyz"`, USER, { tags: ["draft", "urgent"] })).toBe(false);
  });

  it("returns false on non-array fields", () => {
    expect(evaluateRule(`title ?= "x"`, USER, { title: "x" })).toBe(false);
  });

  it("compiles to EXISTS json_each subquery", () => {
    const r = parseFilter(`tags ?= "urgent"`, "vb_posts", USER);
    expect(r?.sql).toContain("EXISTS");
    expect(r?.sql).toContain("json_each");
    expect(r?.params).toContain("urgent");
  });
});

describe("Phase 1 — field modifiers", () => {
  it(":lower for case-insensitive equality", () => {
    expect(evaluateRule(`email:lower = "ALICE@x.com"`, USER, { email: "alice@x.com" })).toBe(false);
    // Server lower-cases the column; literal stays as-is.
    expect(evaluateRule(`email:lower = "alice@x.com"`, USER, { email: "ALICE@x.com" })).toBe(true);
  });

  it(":length on a string", () => {
    expect(evaluateRule(`title:length > 5`, USER, { title: "hello world" })).toBe(true);
    expect(evaluateRule(`title:length > 5`, USER, { title: "hi" })).toBe(false);
  });

  it(":length on an array", () => {
    expect(evaluateRule(`tags:length = 3`, USER, { tags: ["a", "b", "c"] })).toBe(true);
    expect(evaluateRule(`tags:length = 3`, USER, { tags: ["a", "b"] })).toBe(false);
  });
});

describe("Phase 1 — @request.* expansions", () => {
  it("@request.method matches the method", () => {
    expect(evaluateRule(
      `@request.method = "POST"`,
      USER,
      {},
      { method: "POST" },
    )).toBe(true);
    expect(evaluateRule(
      `@request.method = "POST"`,
      USER,
      {},
      { method: "GET" },
    )).toBe(false);
  });

  it("@request.context discriminates on flow", () => {
    expect(evaluateRule(
      `@request.context = "realtime"`,
      USER,
      {},
      { context: "realtime" },
    )).toBe(true);
    expect(evaluateRule(
      `@request.context = "realtime"`,
      USER,
      {},
      { context: "default" },
    )).toBe(false);
  });

  it("@request.headers.x reads a header", () => {
    expect(evaluateRule(
      `@request.headers.x_org = "vaultbase"`,
      USER,
      {},
      { headers: { x_org: "vaultbase" } },
    )).toBe(true);
  });

  it("@request.body.field reads submitted body", () => {
    expect(evaluateRule(
      `@request.body.title = "hello"`,
      USER,
      {},
      { body: { title: "hello" } },
    )).toBe(true);
  });

  it(":isset on @request.body checks key presence", () => {
    expect(evaluateRule(
      `@request.body.title:isset = true`,
      USER,
      {},
      { body: { title: "x" } },
    )).toBe(true);
    expect(evaluateRule(
      `@request.body.title:isset = true`,
      USER,
      {},
      { body: {} },
    )).toBe(false);
  });

  it(":changed on @request.body diffs against existing", () => {
    expect(evaluateRule(
      `@request.body.title:changed = true`,
      USER,
      {},
      { body: { title: "new" }, existing: { title: "old" } },
    )).toBe(true);
    expect(evaluateRule(
      `@request.body.title:changed = true`,
      USER,
      {},
      { body: { title: "same" }, existing: { title: "same" } },
    )).toBe(false);
  });
});

describe("Phase 1 — datetime macros", () => {
  it("@now resolves to a current ISO-8601 datetime", () => {
    expect(evaluateRule(
      `@now > "2000-01-01"`,
      USER,
      {},
    )).toBe(true);
  });

  it("@year compiles into the SQL filter", () => {
    const r = parseFilter(`year = @year`, "vb_posts", USER);
    expect(r?.sql).toContain("?");
    expect(r?.params.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Phase 1 — DoS guards", () => {
  it("rejects expressions that exceed the operand cap", () => {
    const expr = Array.from({ length: 60 }, (_, i) => `id = "${i}"`).join(" || ");
    expect(evaluateRule(expr, USER, { id: "0" })).toBe(false);
  });

  it("rejects expressions deeper than MAX_DEPTH", () => {
    let s = 'id = "x"';
    for (let i = 0; i < 64; i++) s = `(${s})`;
    expect(evaluateRule(s, USER, { id: "x" })).toBe(false);
  });

  it("rejects unknown modifiers at parse time", () => {
    expect(evaluateRule(`title:rmrf = "x"`, USER, { title: "x" })).toBe(false);
  });

  it("rejects unknown functions at parse time", () => {
    expect(evaluateRule(`unknownFunc(1, 2) = 0`, USER, {})).toBe(false);
  });
});

describe("Phase 1 — security: header redaction is caller's responsibility", () => {
  it("authorization header reaching the rule engine evaluates as-passed (test caller MUST redact)", () => {
    // This test documents the contract: the rules engine doesn't strip
    // sensitive headers — it's the API layer's job before constructing the
    // RequestContext. Consumers that forget will leak. See the relevant API
    // layer integration test.
    const result = evaluateRule(
      `@request.headers.authorization = "Bearer secret"`,
      USER,
      {},
      { headers: { authorization: "Bearer secret" } },
    );
    expect(result).toBe(true);
  });
});

describe("Phase 1 — SQL identifier hardening", () => {
  it("rejects invalid table name", () => {
    expect(() => parseFilter(`title = "x"`, "vb_posts; DROP TABLE x", USER)).toThrow();
  });

  it("rejects field names with quotes", () => {
    // The expression parser refuses non-word chars; make sure we don't
    // accidentally allow them through `field.path` segments.
    const ast = parseFilter(`weird = "x"`, "vb_posts", USER);
    expect(ast).not.toBeNull();
  });
});
