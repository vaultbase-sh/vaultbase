/**
 * Periodic cleanup of bookkeeping tables that otherwise grow forever.
 * Only finished / expired rows are removed; nothing a running job, pending
 * delivery or live token depends on.
 */
import { getRawClient } from "../db/client.ts";

/** Finished jobs and webhook deliveries are kept this long for inspection. */
export const RETENTION_DAYS = 30;
/** Expired tokens linger a day so clock skew can't resurrect a revoked one. */
const EXPIRY_GRACE_SECONDS = 24 * 60 * 60;

export interface PruneResult {
  jobs: number;
  webhookDeliveries: number;
  tokenRevocations: number;
  authTokens: number;
}

export async function pruneHistory(): Promise<PruneResult> {
  const client = getRawClient();
  const now = Math.floor(Date.now() / 1000);
  const retentionCutoff = now - RETENTION_DAYS * 24 * 60 * 60;
  const expiredCutoff = now - EXPIRY_GRACE_SECONDS;
  const run = (sql: string, ...params: number[]) => client.prepare(sql).run(...params).changes;
  return {
    jobs: run(
      `DELETE FROM vaultbase_jobs_log
        WHERE status IN ('succeeded', 'failed', 'dead') AND finished_at IS NOT NULL AND finished_at < ?`,
      retentionCutoff,
    ),
    webhookDeliveries: run(
      `DELETE FROM vaultbase_webhook_deliveries
        WHERE status IN ('succeeded', 'dead') AND created_at < ?`,
      retentionCutoff,
    ),
    // A revocation only matters while the token could still verify.
    tokenRevocations: run(`DELETE FROM vaultbase_token_revocations WHERE expires_at < ?`, expiredCutoff),
    // Verify / reset / OTP tokens are useless once expired, used or not.
    authTokens: run(`DELETE FROM vaultbase_auth_tokens WHERE expires_at < ?`, expiredCutoff),
  };
}
