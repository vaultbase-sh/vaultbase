import { describe, expect, it } from "bun:test";
import { evaluateRule } from "../core/rules.ts";
import { parseFilter, type CollectionLookup } from "../core/filter.ts";

const USER = { id: "u1", type: "user" as const, email: "u1@test.local" };
const ADMIN = { id: "a1", type: "admin" as const };

describe("Phase 1.x — :each modifier", () => {
  it(":each = matches when EVERY element equals", () => {
    expect(evaluateRule(`tags:each = "ok"`, USER, { tags: ["ok", "ok"] })).toBe(true);
    expect(evaluateRule(`tags:each = "ok"`, USER, { tags: ["ok", "oops"] })).toBe(false);
  });

  it(":each > 0 matches when EVERY element > 0", () => {
    expect(evaluateRule(`scores:each > 0`, USER, { scores: [1, 2, 3] })).toBe(true);
    expect(evaluateRule(`scores:each > 0`, USER, { scores: [1, 0, 3] })).toBe(false);
  });

  it(":each on empty array → false", () => {
    expect(evaluateRule(`tags:each = "ok"`, USER, { tags: [] })).toBe(false);
  });

  it("compiles to a NOT EXISTS subquery", () => {
    const r = parseFilter(`tags:each = "ok"`, "vb_posts", USER);
    expect(r?.sql).toContain("NOT EXISTS");
    expect(r?.sql).toContain("json_each");
  });
});

describe("Phase 1.x — _via_ back-relations", () => {
  it("parser recognizes the infix and emits a viaRelation operand", () => {
    // We can't easily eval this in single-record mode (it returns null), but
    // SQL compilation should produce a recognizable subquery.
    const lookup: CollectionLookup = (n) => n === "comments"
      ? { viewRule: null, hasField: (f) => f === "post" }
      : null;
    const r = parseFilter(`comments_via_post:length > 0`, "vb_posts", { auth: USER, lookup });
    expect(r).not.toBeNull();
    expect(r?.sql).toContain("vb_comments");
    expect(r?.sql).toContain("json_group_array");
    expect(r?.sql).toContain('"vb_comments"."post" = "vb_posts"."id"');
  });

  it("inherits the joined collection's view_rule (non-admin)", () => {
    const lookup: CollectionLookup = (n) => n === "comments"
      ? { viewRule: 'visibility = "public"', hasField: (f) => f === "post" || f === "visibility" }
      : null;
    const r = parseFilter(`comments_via_post:length > 0`, "vb_posts", { auth: USER, lookup });
    // The compiled SQL must reference the inherited rule.
    expect(r?.sql).toContain('"vb_comments"."visibility" = ?');
    expect(r?.params).toContain("public");
  });

  it("inherits admin-only view_rule → forces 1=0 for non-admin", () => {
    const lookup: CollectionLookup = (n) => n === "comments"
      ? { viewRule: "", hasField: (f) => f === "post" }
      : null;
    const r = parseFilter(`comments_via_post:length > 0`, "vb_posts", { auth: USER, lookup });
    expect(r?.sql).toContain("1=0");
  });

  it("admin auth bypasses joined view_rule", () => {
    const lookup: CollectionLookup = (n) => n === "comments"
      ? { viewRule: "", hasField: (f) => f === "post" }
      : null;
    const r = parseFilter(`comments_via_post:length > 0`, "vb_posts", { auth: ADMIN, lookup });
    expect(r?.sql).not.toContain("1=0");
  });

  it("rejects unknown ref field via lookup", () => {
    const lookup: CollectionLookup = (n) => n === "comments"
      ? { viewRule: null, hasField: () => false }
      : null;
    expect(() => parseFilter(`comments_via_post = "x"`, "vb_posts", { auth: USER, lookup })).toThrow();
  });

  it("rejects identifiers with shell metacharacters", () => {
    // The expression parser refuses `;` inside identifiers, so it doesn't
    // even reach the SQL compiler.
    expect(parseFilter(`comments;DROP_via_post = 1`, "vb_posts", USER)).toBeNull();
  });
});

describe("Phase 1.x — @collection.* view_rule inheritance", () => {
  it("non-admin without lookup → conservative deny via 1=0", () => {
    const r = parseFilter(`@collection.posts.title = "x"`, "vb_users", USER);
    expect(r?.sql).toContain("1=0");
  });

  it("admin without lookup → no 1=0 guard", () => {
    const r = parseFilter(`@collection.posts.title = "x"`, "vb_users", ADMIN);
    expect(r?.sql).not.toContain("1=0");
  });

  it("non-admin WITH lookup that exposes a view_rule → inherits", () => {
    const lookup: CollectionLookup = (n) => n === "posts"
      ? { viewRule: 'published = true', hasField: () => true }
      : null;
    const r = parseFilter(`@collection.posts.title = "x"`, "vb_users", { auth: USER, lookup });
    expect(r?.sql).toContain('"vb_posts"."published" = ?');
  });

  it("max join depth enforced", () => {
    const lookup: CollectionLookup = () => ({
      viewRule: `@collection.posts.title = "x"`,
      hasField: () => true,
    });
    // A view_rule that recursively references @collection.posts will exceed
    // MAX_JOIN_DEPTH and fall through to the parser's null-on-throw.
    expect(() => parseFilter(`@collection.posts.title = "y"`, "vb_users", { auth: USER, lookup })).toThrow();
  });
});
