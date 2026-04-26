export interface AuthContext {
  id: string;
  type: "user" | "admin";
}

/**
 * @param rule - null = public; "" = admin only; expression string = pattern match
 * @param auth - current request auth context or null
 * @param recordId - the record's owner id field value (for owner-only rules)
 */
export function evaluateRule(
  rule: string | null,
  auth: AuthContext | null,
  recordId: string | null
): boolean {
  if (rule === null) return true;
  if (rule === "") return auth?.type === "admin";
  if (rule === '@request.auth.id != ""') return auth !== null;
  if (rule === "@request.auth.id = id") {
    return auth !== null && recordId !== null && auth.id === recordId;
  }
  return false;
}
