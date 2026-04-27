import { describe, expect, it } from "bun:test";
import {
  clearRequestContext,
  getRuleEvals,
  recordRuleEval,
} from "../core/request-context.ts";

function makeReq(): Request {
  return new Request("http://test/x");
}

describe("request-context rule eval collector", () => {
  it("starts empty for a fresh request", () => {
    const req = makeReq();
    expect(getRuleEvals(req)).toEqual([]);
  });

  it("accumulates entries in insertion order", () => {
    const req = makeReq();
    recordRuleEval(req, { rule: "list_rule",   collection: "posts", expression: null, outcome: "allow",  reason: "public" });
    recordRuleEval(req, { rule: "view_rule",   collection: "posts", expression: "@request.auth.id != \"\"", outcome: "deny", reason: "rule failed" });
    const out = getRuleEvals(req);
    expect(out.length).toBe(2);
    expect(out[0]?.rule).toBe("list_rule");
    expect(out[1]?.rule).toBe("view_rule");
  });

  it("isolates entries per request", () => {
    const a = makeReq();
    const b = makeReq();
    recordRuleEval(a, { rule: "list_rule", collection: "posts", expression: null, outcome: "allow", reason: "public" });
    expect(getRuleEvals(a).length).toBe(1);
    expect(getRuleEvals(b).length).toBe(0);
  });

  it("clearRequestContext removes the entries", () => {
    const req = makeReq();
    recordRuleEval(req, { rule: "list_rule", collection: "posts", expression: null, outcome: "allow", reason: "public" });
    clearRequestContext(req);
    expect(getRuleEvals(req)).toEqual([]);
  });
});
