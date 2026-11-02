/**
 * Delay before retry number `attempt` (0-based): 2 s, doubling, capped at 30 s.
 * Used by the "Can't reach the server" screen.
 */
export function retryDelay(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt));
  return Math.min(30_000, 2_000 * 2 ** Math.min(n, 10));
}
