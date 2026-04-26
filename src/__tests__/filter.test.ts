import { describe, expect, it } from "bun:test";
import { parseFilter } from "../core/filter.ts";

describe("parseFilter", () => {
  it("returns null for empty string", () => {
    expect(parseFilter("", "vb_t")).toBeNull();
    expect(parseFilter("   ", "vb_t")).toBeNull();
  });

  it("returns null on malformed input", () => {
    expect(parseFilter("???", "vb_t")).toBeNull();
    expect(parseFilter("field", "vb_t")).toBeNull();
  });

  it("parses simple equality", () => {
    const r = parseFilter("title = 'hello'", "vb_t");
    expect(r).not.toBeNull();
    expect(r!.sql).toContain(`"vb_t"."title"`);
    expect(r!.params).toContain("hello");
  });

  it("parses not-equal", () => {
    const r = parseFilter("status != 'draft'", "vb_t");
    expect(r!.sql).toContain("!=");
  });

  it("parses numeric comparisons", () => {
    expect(parseFilter("age > 18", "vb_t")).not.toBeNull();
    expect(parseFilter("age >= 18", "vb_t")).not.toBeNull();
    expect(parseFilter("age < 100", "vb_t")).not.toBeNull();
    expect(parseFilter("age <= 100", "vb_t")).not.toBeNull();
  });

  it("parses LIKE with ~ operator", () => {
    const r = parseFilter("title ~ 'search'", "vb_t");
    expect(r!.sql).toContain("LIKE");
    expect(r!.params.some((p) => String(p).includes("search"))).toBe(true);
  });

  it("parses AND (&&)", () => {
    const r = parseFilter("age > 18 && published = true", "vb_t");
    expect(r!.sql).toContain("AND");
  });

  it("parses OR (||)", () => {
    const r = parseFilter("status = 'active' || status = 'pending'", "vb_t");
    expect(r!.sql).toContain("OR");
  });

  it("parses parenthesized groups", () => {
    const r = parseFilter("(status = 'active' || status = 'pending') && age >= 21", "vb_t");
    expect(r!.sql).toContain("AND");
    expect(r!.sql).toContain("OR");
  });

  it("emits column ref for id", () => {
    const r = parseFilter("id = 'abc123'", "vb_t");
    expect(r!.sql).toContain(`"vb_t"."id"`);
  });

  it("emits column ref for created/updated", () => {
    const r = parseFilter("created > 1700000000", "vb_t");
    expect(r!.sql).toContain(`"vb_t"."created"`);
  });

  it("coerces bool true to 1, false to 0", () => {
    expect(parseFilter("published = true", "vb_t")!.params).toContain(1);
    expect(parseFilter("published = false", "vb_t")!.params).toContain(0);
  });

  it("handles null comparison", () => {
    const r = parseFilter("author = null", "vb_t");
    expect(r!.sql).toContain("IS NULL");
  });

  it("substitutes @request.auth.id", () => {
    const r = parseFilter("author = @request.auth.id", "vb_t", { id: "u_123", type: "user" });
    expect(r!.params).toContain("u_123");
  });

  it("substitutes @request.auth.email", () => {
    const r = parseFilter("owner_email = @request.auth.email", "vb_t", {
      id: "u_1", type: "user", email: "alice@x.com",
    });
    expect(r!.params).toContain("alice@x.com");
  });

  it("substitutes @request.auth.type", () => {
    const r = parseFilter("@request.auth.type = 'user'", "vb_t", { id: "u_1", type: "user" });
    expect(r!.params).toContain("user");
  });
});
