import type { AuthContext } from "../core/rules.ts";
import { evaluateRule } from "../core/rules.ts";
import { recordRuleEval, type RuleOutcome } from "../core/request-context.ts";
import type { RequestContextLike } from "../core/filter.ts";

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
