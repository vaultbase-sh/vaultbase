/**
 * The in-process rule engine — view/update/delete by id, file access,
 * realtime delivery — can't run cross-collection lookups, so `@collection.*`
 * and `_via_` resolved to NULL there. The code meant that to deny, but a
 * negated comparison turned it into a pass: `@collection.bans.user !=
 * @request.auth.id` let a banned user view, update or delete by id (and
 * receive the record over realtime), while the SQL list path refused them.
 * Each comparison with such an operand is now false in single-record
 * evaluation, so it can only narrow access.
 */
import { describe, expect, it } from "bun:test";
import { evaluateRule, type AuthContext } from "../core/rules.ts";

const banned: AuthContext = { id: "u_banned", type: "user" };
const rec = { id: "r1", status: "public" };

describe("single-record rules with @collection / _via_", () => {
  it("a negated cross-collection comparison does not pass", () => {
    expect(evaluateRule('status = "public" && @collection.bans.user != @request.auth.id', banned, rec)).toBe(false);
    expect(evaluateRule("@collection.bans.user !~ @request.auth.id", banned, rec)).toBe(false);
    expect(evaluateRule('comments_via_post.author != @request.auth.id', banned, rec)).toBe(false);
    expect(evaluateRule('@collection.bans.user:each != @request.auth.id', banned, rec)).toBe(false);
    expect(evaluateRule('@collection.bans.user ?!= @request.auth.id', banned, rec)).toBe(false);
  });

  it("an OR branch that doesn't need the lookup still decides (legitimate path)", () => {
    expect(evaluateRule('status = "public" || @collection.members.user ?= @request.auth.id', banned, rec)).toBe(true);
    expect(evaluateRule('status = "public"', banned, rec)).toBe(true);
  });
});

describe("~ case handling matches list queries (review 15 F-4)", () => {
  it("ignores ASCII case, as SQLite's LIKE does", () => {
    const doc = { id: "d1", title: "CONFIDENTIAL plan" };
    expect(evaluateRule('title !~ "confidential"', banned, doc)).toBe(false);
    expect(evaluateRule('title ~ "confidential"', banned, doc)).toBe(true);
  });

  it("leaves non-ASCII case alone, as LIKE does", () => {
    expect(evaluateRule('title ~ "é"', banned, { id: "d2", title: "É" })).toBe(false);
  });
});
