/**
 * The 403 body for a refused record or file request. Says which operation
 * was refused and why, never the rule expression:
 *
 *   token_invalid  only on the 401 below since 0.44 (0.42 and 0.43 sent it
 *                  on a 403 and ran the request as anonymous).
 *   admin_only     the rule is "" (admins only)
 *   not_signed_in  no token, and the rule needs a signed-in caller
 *   rule_denied    signed in, and the rule said no
 */
import type { AuthContext } from "../core/rules.ts";
import { dataPrincipal, headerBearer, verifyAuthToken, type VerifiedAuth } from "../core/sec.ts";

/**
 * A request's Bearer token, verified once: the 401 check and the handler
 * both need it, and a verification reads the database.
 */
const verifiedByRequest = new WeakMap<Request, Promise<VerifiedAuth | null>>();
export function verifiedFor(request: Request, jwtSecret: string): Promise<VerifiedAuth | null> {
  let p = verifiedByRequest.get(request);
  if (!p) {
    const token = headerBearer(request);
    p = token ? verifyAuthToken(token, jwtSecret) : Promise.resolve(null);
    verifiedByRequest.set(request, p);
  }
  return p;
}

/**
 * Why a request's Bearer token gives it no principal, or null when it sent
 * none or the token is good for `access`: "invalid" (expired, revoked,
 * malformed) or "scope" (an API token without the scope for this request).
 * Since 0.44 such a request answers 401 instead of running as anonymous
 * (0.42 and 0.43 warned with `reason: "token_invalid"` on the 403).
 */
export async function tokenRejection(request: Request, jwtSecret: string, access: "read" | "write"): Promise<"invalid" | "scope" | null> {
  if (!headerBearer(request)) return null;
  const verified = await verifiedFor(request, jwtSecret);
  if (!verified) return "invalid";
  return dataPrincipal(verified, access) ? null : "scope";
}

export interface InvalidTokenBody { error: string; code: 401; reason: "token_invalid" | "insufficient_scope" }

/** The 401 for a token that wasn't accepted. Checked before anything is looked up, so it says nothing about what exists. */
export function invalidToken(set: { status?: number | string }, why: "invalid" | "scope"): InvalidTokenBody {
  set.status = 401;
  // Two reasons, so a client needn't read the message: signing in again
  // fixes `token_invalid`; only a token with more scopes fixes the other.
  return why === "scope"
    ? { error: "This API token doesn't have the scope for this request", code: 401, reason: "insufficient_scope" }
    : { error: "Token expired or invalid", code: 401, reason: "token_invalid" };
}

export type RefusedOperation = "list" | "view" | "create" | "update" | "delete";
export type RefusalReason = "admin_only" | "not_signed_in" | "rule_denied";

export interface ForbiddenBody {
  error: "Forbidden";
  code: 403;
  operation: RefusedOperation;
  reason: RefusalReason;
}

export function refusalReason(auth: AuthContext | null | undefined, rule: string | null | undefined): RefusalReason {
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
  return { error: "Forbidden", code: 403, operation, reason: refusalReason(auth, rule) };
}
