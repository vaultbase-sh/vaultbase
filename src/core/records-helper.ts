/**
 * `helpers.records`: record writes for hooks, custom routes, cron jobs and
 * queue workers that go through the same path as the records API, so they
 * get validation, before- and after-hooks, record history, realtime events
 * and webhooks. `helpers.sql` writes rows directly and gets none of that.
 *
 * Trusted server code: no API rules are applied (like helpers.sql). The
 * writes are attributed to no user (record history shows them as system).
 *
 * A hook that writes to its own collection triggers itself, so nesting is
 * capped: past MAX_DEPTH writes inside one another the call throws instead of
 * looping forever. Nested writes to the record a request is already writing
 * are fine: record locks are re-entrant per request (records.ts lockRecord).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { RecordWithMeta } from "./records.ts";

// records.ts imports hooks.ts, which builds this helper: load it lazily, as
// helpers.find and helpers.query do.
const core = () => import("./records.ts");

export const MAX_RECORDS_HELPER_DEPTH = 5;

const depth = new AsyncLocalStorage<number>();

function nested<T>(what: string, fn: () => Promise<T>): Promise<T> {
  const next = (depth.getStore() ?? 0) + 1;
  if (next > MAX_RECORDS_HELPER_DEPTH) {
    return Promise.reject(new Error(
      `helpers.records.${what}: more than ${MAX_RECORDS_HELPER_DEPTH} writes nested inside one another. ` +
      `A hook is probably writing to its own collection and triggering itself; guard it with a field check.`,
    ));
  }
  return depth.run(next, fn);
}

export interface RecordsHelper {
  /** Create a record. Runs validation and hooks, writes history, sends realtime and webhooks. */
  create(collection: string, data: Record<string, unknown>): Promise<RecordWithMeta>;
  /** Update fields of a record (a partial patch). */
  update(collection: string, id: string, data: Record<string, unknown>): Promise<RecordWithMeta>;
  /** Delete a record (with the collection's cascade rules). */
  delete(collection: string, id: string): Promise<void>;
}

export function makeRecordsHelper(): RecordsHelper {
  return {
    create: (collection, data) => nested("create", async () => (await core()).createRecord(collection, data, null)),
    update: (collection, id, data) => nested("update", async () => (await core()).updateRecord(collection, id, data, null)),
    delete: (collection, id) => nested("delete", async () => (await core()).deleteRecord(collection, id, null)),
  };
}
