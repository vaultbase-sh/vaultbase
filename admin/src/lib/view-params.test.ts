import { describe, expect, it } from "bun:test";
import { appendViewParams, draftsFromJson, draftsToPayload, queryParamNames } from "./view-params.ts";

describe("queryParamNames", () => {
  it("finds :name once each, in order", () => {
    expect(queryParamNames("SELECT * FROM t WHERE a >= :since AND b = :status OR c = :since")).toEqual(["since", "status"]);
  });

  it("skips strings, quoted names, comments, casts and array slices", () => {
    expect(queryParamNames(`SELECT ':x', "y:z", a::text, (arr)[1:n] FROM t -- :c\n WHERE d = 1 /* :e */`)).toEqual([]);
  });
});

describe("drafts", () => {
  it("round-trip the stored list", () => {
    const stored = JSON.stringify([
      { name: "since", type: "date", default: Date.UTC(2026, 0, 2) / 1000 },
      { name: "paid", type: "bool", default: 1 },
      { name: "min", type: "number", required: true },
      { name: "me", type: "text", from: "auth.id" },
      { name: "q", type: "text" },
    ]);
    const drafts = draftsFromJson(stored);
    expect(drafts).toEqual([
      { name: "since", type: "date", mode: "default", default: "2026-01-02" },
      { name: "paid", type: "bool", mode: "default", default: "true" },
      { name: "min", type: "number", mode: "required", default: "" },
      { name: "me", type: "text", mode: "auth", default: "" },
      { name: "q", type: "text", mode: "default", default: "" },
    ]);
    expect(draftsToPayload(drafts)).toEqual([
      { name: "since", type: "date", default: "2026-01-02" },
      { name: "paid", type: "bool", default: "true" },
      { name: "min", type: "number", required: true },
      { name: "me", type: "text", from: "auth.id" },
      { name: "q", type: "text" },
    ]);
  });

  it("an unreadable list is none", () => {
    expect(draftsFromJson("not json")).toEqual([]);
    expect(draftsFromJson(null)).toEqual([]);
  });
});

it("appendViewParams sets the filled-in values", () => {
  const s = new URLSearchParams("page=1");
  appendViewParams(s, { since: "2026-01-01", status: " ", min: "5" });
  expect(s.toString()).toBe("page=1&params%5Bsince%5D=2026-01-01&params%5Bmin%5D=5");
});
