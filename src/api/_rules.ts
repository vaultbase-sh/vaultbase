import type { Collection } from "../db/schema.ts";
import type { AuthContext } from "../core/rules.ts";
import { compileRule, evaluateRule } from "../core/rules.ts";
import { recordRuleEval, type RuleOutcome } from "../core/request-context.ts";
import type { RequestContextLike } from "../core/filter.ts";
import { viewParamsFromUrl } from "../core/view-params.ts";

/** Sensitive headers that NEVER reach the rule engine. */
const REDACTED_HEADERS: ReadonlySet<string> = new Set([
  "authorization", "cookie", "set-cookie",
  "x-setup-key", "x-api-key", "x-auth-token",
  "proxy-authorization",
]);

/**
 * Build a RequestContext for rule evaluation.
 *
 * Hardening:
 *   - Authorization, Cookie, Set-Cookie, and X-Setup-Key headers are stripped
 *     entirely before exposure (rules cannot read auth credentials).
 *   - Header keys are lowercased + hyphens→underscores so rules can write
 *     `@request.headers.x_org` without case sensitivity.
 *   - Body is the parsed JSON only — no raw stream re-read.
 *   - For UPDATE rule eval, callers pass `existing` so `:changed` works.
 */
export function buildRequestContext(
  request: Request,
  body?: Record<string, unknown> | null,
  existing?: Record<string, unknown> | null,
  context?: string,
): RequestContextLike {
  const headers: Record<string, string> = {};
  for (const [k, v] of request.headers.entries()) {
    const lower = k.toLowerCase();
    if (REDACTED_HEADERS.has(lower)) continue;
    headers[lower.replace(/-/g, "_")] = v;
  }
  const url = new URL(request.url);
  const query: Record<string, string> = {};
  url.searchParams.forEach((v, k) => { query[k] = v; });
  // View parameters (`params[name]=…`) as `@request.query.params.name` sees
  // them. A literal `params.x` key in the URL isn't one: it would let a rule
  // check a value the view never reads. Reads of a view replace these with
  // the values the query really uses (records.ts readSource).
  for (const k of Object.keys(query)) if (k.startsWith("params.")) delete query[k];
  for (const [name, v] of Object.entries(viewParamsFromUrl(url.searchParams) ?? {})) query[`params.${name}`] = v;

  return {
    method: request.method.toUpperCase(),
    context: context ?? "default",
    headers,
    query,
    body: body ?? null,
    existing: existing ?? null,
  };
}

/**
 * Rule-deny error — thrown by checkRuleOrThrow so callers (records HTTP, batch
 * transaction, etc.) can map to 403 + roll back atomically.
 */
export class RuleDeniedError extends Error {
  ruleName: string;
  constructor(ruleName: string) {
    super("Forbidden");
    this.ruleName = ruleName;
  }
}

/**
 * Run evaluateRule and record the outcome on the request for the logs plugin
 * to flush. Returns the same boolean evaluateRule returns.
 *
 * Centralized so every call site (records, batch, hooks, etc.) gets the same
 * human-readable reason in the request log.
 */
export function checkRule(
  request: Request,
  ruleName: string,
  collectionName: string,
  rule: string | null,
  auth: AuthContext | null,
  record: Record<string, unknown> | null,
  reqCtx?: RequestContextLike
): boolean {
  let outcome: RuleOutcome;
  let reason: string;
  let allowed: boolean;
  if (rule === null) {
    allowed = true;
    outcome = "allow";
    reason = "public";
  } else if (auth?.type === "admin") {
    allowed = true;
    outcome = "allow";
    reason = "admin bypass";
  } else if (rule === "") {
    allowed = false;
    outcome = "deny";
    reason = "admin only";
  } else {
    const ctx = reqCtx ?? buildRequestContext(request, null, record);
    allowed = evaluateRule(rule, auth, record, ctx);
    outcome = allowed ? "allow" : "deny";
    reason = allowed ? "rule passed" : "rule failed";
  }
  recordRuleEval(request, {
    rule: ruleName,
    collection: collectionName,
    expression: rule,
    outcome,
    reason,
  });
  return allowed;
}

/**
 * checkRule over many records, for a non-admin and a rule expression (the
 * versions of a record's history): the rule is parsed and the request
 * context built once, each record standing in as `existing`, and the request
 * log gets one entry saying how many passed, not one per record.
 */
export function ruleFilter(
  request: Request,
  ruleName: string,
  collectionName: string,
  rule: string,
  auth: AuthContext | null,
): { visible: (record: Record<string, unknown>) => boolean; log: () => void } {
  const check = compileRule(rule);
  const base = buildRequestContext(request, null, null);
  let seen = 0;
  let passed = 0;
  return {
    visible: (record) => {
      seen++;
      const ok = check(auth, record, { ...base, existing: record });
      if (ok) passed++;
      return ok;
    },
    log: () => recordRuleEval(request, {
      rule: ruleName,
      collection: collectionName,
      expression: rule,
      outcome: "filter",
      reason: `rule passed on ${passed} of ${seen}`,
    }),
  };
}

/**
 * Update rules are evaluated twice: against the record as it stands, and
 * against the record the patch would produce.
 *
 * Checking only the prior state lets an owner hand a record to somebody else —
 * `owner = @request.auth.id` passes against the existing row, and nothing
 * re-checks the row the write actually creates. The built-in `notifications`
 * rule had exactly this shape, so a user could move their own notification
 * into another user's inbox with a title of their choosing.
 *
 * Logged as one evaluation; `reason` says which side refused.
 */
export function checkUpdateRule(
  request: Request,
  collectionName: string,
  rule: string | null,
  auth: AuthContext | null,
  existing: Record<string, unknown>,
  body: Record<string, unknown> | null,
): boolean {
  let outcome: RuleOutcome;
  let reason: string;
  let allowed: boolean;
  if (rule === null) {
    allowed = true; outcome = "allow"; reason = "public";
  } else if (auth?.type === "admin") {
    allowed = true; outcome = "allow"; reason = "admin bypass";
  } else if (rule === "") {
    allowed = false; outcome = "deny"; reason = "admin only";
  } else {
    const ctx = buildRequestContext(request, body, existing);
    // The patch is a partial: anything it omits keeps its current value.
    const merged = { ...existing, ...(body ?? {}) };
    const onExisting = evaluateRule(rule, auth, existing, ctx);
    const onMerged = onExisting ? evaluateRule(rule, auth, merged, ctx) : false;
    allowed = onExisting && onMerged;
    outcome = allowed ? "allow" : "deny";
    reason = allowed
      ? "rule passed on current and resulting record"
      : onExisting
        ? "rule failed on the resulting record"
        : "rule failed on the current record";
  }
  recordRuleEval(request, {
    rule: "update_rule",
    collection: collectionName,
    expression: rule,
    outcome,
    reason,
  });
  return allowed;
}

/** Convenience: check then throw RuleDeniedError on failure. */
export function checkRuleOrThrow(
  request: Request,
  ruleName: string,
  collectionName: string,
  rule: string | null,
  auth: AuthContext | null,
  record: Record<string, unknown> | null,
  reqCtx?: RequestContextLike
): void {
  if (!checkRule(request, ruleName, collectionName, rule, auth, record, reqCtx)) {
    throw new RuleDeniedError(ruleName);
  }
}

/**
 * List rules are applied as SQL filters when set; record that fact so logs
 * surface the behavior. Admin bypass surfaces separately. Returns true if the
 * caller is allowed to list at all (only false when rule === "" and not admin).
 */
export function recordListRule(
  request: Request,
  collectionName: string,
  rule: string | null,
  auth: AuthContext | null
): boolean {
  let outcome: RuleOutcome;
  let reason: string;
  let allowed: boolean;
  if (rule === null) {
    outcome = "allow"; reason = "public"; allowed = true;
  } else if (auth?.type === "admin") {
    outcome = "allow"; reason = "admin bypass"; allowed = true;
  } else if (rule === "") {
    outcome = "deny"; reason = "admin only"; allowed = false;
  } else {
    outcome = "filter"; reason = "applied as SQL filter"; allowed = true;
  }
  recordRuleEval(request, {
    rule: "list_rule",
    collection: collectionName,
    expression: rule,
    outcome,
    reason,
  });
  return allowed;
}

/**
 * The cascade check for a delete made by `auth`: each row the delete would
 * remove (or null out) through a relation must pass that collection's own
 * delete (or update) rule. Admins skip it, as they skip the rules.
 */
export function cascadeRuleCheck(
  request: Request,
  auth: AuthContext | null,
): ((col: Collection, record: Record<string, unknown>, change: Record<string, unknown> | null) => boolean) | undefined {
  if (auth?.type === "admin") return undefined;
  return (col, record, change) => change === null
    ? checkRule(request, "delete_rule", col.name, col.delete_rule, auth, record)
    : checkUpdateRule(request, col.name, col.update_rule, auth, record, change);
}
