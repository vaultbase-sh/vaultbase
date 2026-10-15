/**
 * Cluster mode (`vaultbase cluster`) runs N copies of the server, each with
 * its own schedulers. Work that must happen once per install — cron jobs,
 * daily prunes, the update check, the orphan-file sweep — runs only on
 * worker 0 (and always when not clustered). Queue jobs, webhook deliveries
 * and scheduled backups claim each run in the database and run anywhere.
 */
export function runsSingletonDuties(env: Record<string, string | undefined> = process.env): boolean {
  const id = env["VAULTBASE_WORKER_ID"];
  return id === undefined || id === "" || id === "0";
}

/** True when this process is one worker of `vaultbase cluster`. */
export function isClusterWorker(env: Record<string, string | undefined> = process.env): boolean {
  return !!env["VAULTBASE_WORKER_ID"];
}

export const CLUSTER_LIMITS_WARNING =
  "vaultbase: cluster mode is deprecated: a single process now serves record reads on worker threads (one per spare core by default) and will replace it. " +
  "Each cluster worker keeps its own caches, realtime connections and rate limits. " +
  "Realtime events only reach clients on the worker that made the change, rate limits apply per worker, " +
  "and collection/hook/route changes reach other workers only after a restart. Online restore is disabled.\n";
