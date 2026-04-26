import { describe, expect, it } from "bun:test";
import { parseFilter } from "../core/filter.ts";

describe("parseFilter", () => {
  it("returns undefined for empty string", () => {
    expect(parseFilter("")).toBeUndefined();
    expect(parseFilter("   ")).toBeUndefined();
  });

  it("returns undefined on malformed input", () => {
    expect(parseFilter("???")).toBeUndefined();
    expect(parseFilter("field")).toBeUndefined();
  });

  it("parses simple equality", () => {
    expect(parseFilter("title = 'hello'")).toBeDefined();
  });

  it("parses not-equal", () => {
    expect(parseFilter("status != 'draft'")).toBeDefined();
  });

  it("parses numeric comparison", () => {
    expect(parseFilter("age > 18")).toBeDefined();
    expect(parseFilter("age >= 18")).toBeDefined();
    expect(parseFilter("age < 100")).toBeDefined();
    expect(parseFilter("age <= 100")).toBeDefined();
  });

  it("parses LIKE with ~ operator", () => {
    expect(parseFilter("title ~ 'search'")).toBeDefined();
  });

  it("parses AND (&&)", () => {
    expect(parseFilter("age > 18 && published = true")).toBeDefined();
  });

  it("parses OR (||)", () => {
    expect(parseFilter("status = 'active' || status = 'pending'")).toBeDefined();
  });

  it("parses parenthesized groups", () => {
    expect(parseFilter("(status = 'active' || status = 'pending') && age >= 21")).toBeDefined();
  });

  it("parses id field", () => {
    expect(parseFilter("id = 'abc123'")).toBeDefined();
  });

  it("parses created/updated fields", () => {
    expect(parseFilter("created > 1700000000")).toBeDefined();
    expect(parseFilter("updated < 1800000000")).toBeDefined();
  });

  it("parses bool coercion", () => {
    expect(parseFilter("published = true")).toBeDefined();
    expect(parseFilter("published = false")).toBeDefined();
  });

  it("parses null comparison", () => {
    expect(parseFilter("author = null")).toBeDefined();
  });

  it("parses complex multi-level expression", () => {
    expect(parseFilter(
      "(status = 'active' && age > 18) || (role = 'admin' && verified = true)"
    )).toBeDefined();
  });
});
