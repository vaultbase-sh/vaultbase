import { describe, expect, it } from "bun:test";
import {
  getActiveHookRequest,
  makeHookHelpers,
  runWithHookRequest,
  type HookHelpers,
} from "../core/hooks.ts";
import { getRuleEvals } from "../core/request-context.ts";

function makeReq(): Request {
  return new Request("http://test/api/posts");
}

describe("helpers.recordRule", () => {
  it("records an eval onto the active request when one is provided", () => {
    const req = makeReq();
    const helpers = makeHookHelpers({
      collection: "posts",
      event: "beforeCreate",
      request: req,
    });
    helpers.recordRule({
      rule: "x",
      outcome: "deny",
      reason: "over quota",
    });
    const evals = getRuleEvals(req);
    expect(evals.length).toBe(1);
    expect(evals[0]).toEqual({
      rule: "x",
      collection: "posts",
      expression: null,
      outcome: "deny",
      reason: "over quota",
    });
  });

  it("simulated beforeCreate: hook runs under runWithHookRequest and rules accumulate alongside an HTTP-layer eval", () => {
    const req = makeReq();
    // Pretend the records-API layer already recorded its own create_rule eval.
    const { recordRuleEval } = require("../core/request-context.ts") as typeof import("../core/request-context.ts");
    recordRuleEval(req, {
      rule: "create_rule",
      collection: "posts",
      expression: null,
      outcome: "allow",
      reason: "public",
    });

    // Simulate `runBeforeHook` dispatch: it builds helpers under the ALS scope.
    runWithHookRequest(req, () => {
      // Confirm ALS is wired.
      expect(getActiveHookRequest()).toBe(req);
      // Helpers built without an explicit `request` should still pick the
      // ALS-tracked one — this is the records-core path.
      const helpers: HookHelpers = makeHookHelpers({
        collection: "posts",
        event: "beforeCreate",
        name: "quota-guard",
      });
      helpers.recordRule({
        rule: "x",
        outcome: "deny",
        reason: "over quota",
      });
    });

    const evals = getRuleEvals(req);
    expect(evals.length).toBe(2);
    expect(evals[0]?.rule).toBe("create_rule");
    expect(evals[1]).toEqual({
      rule: "x",
      collection: "posts",
      expression: null,
      outcome: "deny",
      reason: "over quota",
    });
  });

  it("multiple recordRule calls accumulate in insertion order", () => {
    const req = makeReq();
    const helpers = makeHookHelpers({ collection: "posts", request: req });
    helpers.recordRule({ rule: "a", outcome: "allow", reason: "ok" });
    helpers.recordRule({ rule: "b", outcome: "filter", reason: "narrowed" });
    helpers.recordRule({
      rule: "c",
      collection: "comments",
      expression: "owner = @request.auth.id",
      outcome: "deny",
      reason: "not owner",
    });

    const evals = getRuleEvals(req);
    expect(evals.length).toBe(3);
    expect(evals.map((e) => e.rule)).toEqual(["a", "b", "c"]);
    // Per-call collection override is honored, default falls back to ctx.
    expect(evals[0]?.collection).toBe("posts");
    expect(evals[1]?.collection).toBe("posts");
    expect(evals[2]?.collection).toBe("comments");
    expect(evals[2]?.expression).toBe("owner = @request.auth.id");
    expect(evals[1]?.outcome).toBe("filter");
  });

  it("is a silent no-op when there is no active Request", () => {
    // No ctx.request, no ALS scope.
    const helpers = makeHookHelpers({});
    expect(() =>
      helpers.recordRule({ rule: "x", outcome: "deny", reason: "no req" })
    ).not.toThrow();
    // And of course no runtime side-effect we can observe — the contract is
    // simply "don't blow up". For belt-and-suspenders, a fresh Request stays
    // empty even if the same hook ran.
    const probe = makeReq();
    expect(getRuleEvals(probe)).toEqual([]);
  });

  it("collection defaults to ctx.collection when omitted, and stays empty when neither is set", () => {
    const req = makeReq();
    const h1 = makeHookHelpers({ request: req }); // no collection in ctx
    h1.recordRule({ rule: "no-col", outcome: "allow", reason: "no ctx" });
    const out = getRuleEvals(req);
    expect(out.length).toBe(1);
    expect(out[0]?.collection).toBe("");
  });
});
