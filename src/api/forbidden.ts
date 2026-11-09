/**
 * The 403 body for a refused record or file request. Says which operation
 * was refused and why, never the rule expression:
 *
 *   token_invalid  a Bearer token was sent but not accepted (expired,
 *                  revoked, malformed, or an API token without the scope);
 *                  the request ran as anonymous. Answers 401 from 0.44.
 *   admin_only     the rule is "" (admins only)
 *   not_signed_in  no token, and the rule needs a signed-in caller
 *   rule_denied    signed in, and the rule said no
 */
import type { AuthContext } from "../core/rules.ts";
import { headerBearer } from "../core/sec.ts";

export type RefusedOperation = "list" | "view" | "create" | "update" | "delete";
export type RefusalReason = "token_invalid" | "admin_only" | "not_signed_in" | "rule_denied";

export interface ForbiddenBody {
  error: "Forbidden";
  code: 403;
  operation: RefusedOperation;
  reason: RefusalReason;
}

export function refusalReason(request: Request, auth: AuthContext | null | undefined, rule: string | null | undefined): RefusalReason {
  if (!auth && headerBearer(request)) return "token_invalid";
  if (rule === "") return "admin_only";
  if (!auth) return "not_signed_in";
  return "rule_denied";
}

export function forbidden(
  set: { status?: number | string },
  request: Request,
  operation: RefusedOperation,
  auth: AuthContext | null | undefined,
  rule: string | null | undefined,
): ForbiddenBody {
  set.status = 403;
  return { error: "Forbidden", code: 403, operation, reason: refusalReason(request, auth, rule) };
}
