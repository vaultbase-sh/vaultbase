import { getDb } from "../db/client.ts";

/**
 * A short-lived cache for small, hot lookups (enabled hooks, webhooks,
 * relation maps) that would otherwise hit SQLite on every record write.
 *
 * - Expires after `ttlMs`, so other `vaultbase cluster` workers (which can't
 *   receive our invalidations) pick up changes within that window.
 * - Tied to the current DB handle: a re-opened database never sees rows
 *   cached from the previous one.
 * - `invalidate()` drops it immediately for changes made in this process.
 */
export function dbScopedTtlCache<T>(ttlMs: number, load: () => PromiseLike<T>) {
  let entry: { db: unknown; at: number; value: Promise<T> } | null = null;
  return {
    get(): Promise<T> {
      const db = getDb();
      if (entry && entry.db === db && Date.now() - entry.at < ttlMs) return entry.value;
      // Settle the load once and cache the outcome. A drizzle query builder
      // is a lazy thenable that re-runs its SQL on every `await`; cached
      // as-is, the hooks lookup hit SQLite twice per record write.
      const value = Promise.resolve(load());
      const fresh = { db, at: Date.now(), value };
      entry = fresh;
      // Don't keep a failed load around.
      value.catch(() => { if (entry === fresh) entry = null; });
      return value;
    },
    invalidate(): void {
      entry = null;
    },
  };
}
