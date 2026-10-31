/**
 * The status a request was answered with, for the request log and the
 * metrics. A handler sets it three ways: `set.status`, a returned Response,
 * or `status(code, …)` (the admin guard's refusal), which leaves
 * `set.status` alone and showed as 200.
 */
import { ElysiaCustomStatusResponse } from "elysia";

export function answeredStatus(value: unknown, setStatus: unknown): number {
  if (value instanceof ElysiaCustomStatusResponse) return Number(value.code);
  const set = typeof setStatus === "number" ? setStatus : null;
  // A status set explicitly wins over the Response's default 200.
  if (value instanceof Response) return set !== null && set !== 200 ? set : value.status;
  return set ?? 200;
}

/** The status of a thrown error: `status(code)` thrown, or an error carrying `status`; null if neither. */
export function thrownStatus(error: unknown): number | null {
  if (error instanceof ElysiaCustomStatusResponse) return Number(error.code);
  const own = (error as { status?: unknown } | null)?.status;
  return typeof own === "number" ? own : null;
}
