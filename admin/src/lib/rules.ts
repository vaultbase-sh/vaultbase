/**
 * Access-rule values: how the server stores them vs. how the editor shows them.
 *
 * `evaluateRule` (src/core/rules.ts) reads three distinct states:
 *
 *   null   → public; no auth required
 *   ""     → admin only
 *   <expr> → evaluate the expression
 *
 * The editor used to collapse `null` and `""` into the same empty string on
 * load, then write `value || null` on save. That had two consequences: an
 * admin-only rule was displayed as "public", and merely opening a collection
 * and pressing Save republished every admin-only rule on it.
 *
 * Keeping the mode explicit is what stops that. `null` and `""` are opposites,
 * so they must never share a representation.
 */

export type RuleMode = "public" | "admin" | "expr";

export interface RuleValue {
  mode: RuleMode;
  /**
   * The expression, meaningful only when `mode === "expr"`. Retained when the
   * user flips to another mode and back so their work isn't lost.
   */
  expr: string;
}

/** The expression the "Auth only" preset writes. */
export const AUTH_ONLY_EXPR = '@request.auth.id != ""';

/** Stored value from the API → editor state. */
export function toRuleValue(stored: string | null | undefined): RuleValue {
  if (stored === null || stored === undefined) return { mode: "public", expr: "" };
  if (stored === "") return { mode: "admin", expr: "" };
  return { mode: "expr", expr: stored };
}

/**
 * Editor state → the value to send back. Never `|| null`.
 *
 * A custom expression left blank is ambiguous — an empty string on the wire
 * means admin-only. Resolving it that way is the safe direction: it denies
 * rather than publishes.
 */
export function fromRuleValue(v: RuleValue): string | null {
  if (v.mode === "public") return null;
  if (v.mode === "admin") return "";
  return v.expr.trim() === "" ? "" : v.expr;
}

/** Round-trip helper for the five rules on a collection. */
export interface StoredRules {
  list_rule: string | null;
  view_rule: string | null;
  create_rule: string | null;
  update_rule: string | null;
  delete_rule: string | null;
}

export type RuleOpId = "list" | "view" | "create" | "update" | "delete";

export type RuleSet = Record<RuleOpId, RuleValue>;

export const RULE_OP_IDS: RuleOpId[] = ["list", "view", "create", "update", "delete"];

export function toRuleSet(c: Partial<StoredRules>): RuleSet {
  return {
    list: toRuleValue(c.list_rule),
    view: toRuleValue(c.view_rule),
    create: toRuleValue(c.create_rule),
    update: toRuleValue(c.update_rule),
    delete: toRuleValue(c.delete_rule),
  };
}

export function fromRuleSet(r: RuleSet): StoredRules {
  return {
    list_rule: fromRuleValue(r.list),
    view_rule: fromRuleValue(r.view),
    create_rule: fromRuleValue(r.create),
    update_rule: fromRuleValue(r.update),
    delete_rule: fromRuleValue(r.delete),
  };
}

/** Human-readable summary for the collapsed rule card. */
export function describeRule(v: RuleValue): string {
  if (v.mode === "public") return "// public — anyone, no auth";
  if (v.mode === "admin") return "// admin only";
  return v.expr.trim() === "" ? "// admin only — empty expression" : v.expr;
}
