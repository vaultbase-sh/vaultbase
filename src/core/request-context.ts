/**
 * Per-request context for things that aren't part of the HTTP envelope but
 * matter for observability — currently rule-evaluation outcomes that the logs
 * plugin attaches to the log entry on flush.
 *
 * Backed by a WeakMap so entries get GC'd with the Request object — no manual
 * cleanup needed.
 */

export type RuleOutcome = "allow" | "deny" | "filter";

export interface RuleEvalEntry {
  /** Which rule slot was evaluated — "list_rule", "view_rule", etc. */
  rule: string;
  collection: string;
  /** The expression text. `null` = public, `""` = admin-only, otherwise the rule. */
  expression: string | null;
  outcome: RuleOutcome;
  /** Human-readable explanation: "public", "admin only", "admin bypass", "rule passed", "rule failed", "applied as filter". */
  reason: string;
}

const ruleEvals = new WeakMap<Request, RuleEvalEntry[]>();

export function recordRuleEval(req: Request, entry: RuleEvalEntry): void {
  let list = ruleEvals.get(req);
  if (!list) {
    list = [];
    ruleEvals.set(req, list);
  }
  list.push(entry);
}

export function getRuleEvals(req: Request): RuleEvalEntry[] {
  return ruleEvals.get(req) ?? [];
}

export function clearRequestContext(req: Request): void {
  ruleEvals.delete(req);
}
