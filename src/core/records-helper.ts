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

export function nested<T>(what: string, fn: () => Promise<T>): Promise<T> {
  const next = (depth.getStore() ?? 0) + 1;
  if (next > MAX_RECORDS_HELPER_DEPTH) {
    return Promise.reject(new Error(
      `helpers.${what}: more than ${MAX_RECORDS_HELPER_DEPTH} writes nested inside one another. ` +
      `A hook is probably writing to its own collection and triggering itself; guard it with a field check.`,
    ));
  }
  return depth.run(next, fn);
}

/** A conditional write: only when the record matches `filter` (records filter syntax). */
export interface RecordsWriteOpts {
  filter?: string;
}

export interface RecordsHelper {
  /** Create a record. Runs validation and hooks, writes history, sends realtime and webhooks. */
  create(collection: string, data: Record<string, unknown>): Promise<RecordWithMeta>;
  /**
   * Update fields of a record (a partial patch). With `filter`, only when the
   * record matches it at the time of the write; null when it doesn't (or is
   * gone). Without one, a missing record throws.
   */
  update(collection: string, id: string, data: Record<string, unknown>, opts: RecordsWriteOpts & { filter: string }): Promise<RecordWithMeta | null>;
  update(collection: string, id: string, data: Record<string, unknown>, opts?: RecordsWriteOpts): Promise<RecordWithMeta>;
  /**
   * Delete a record (with the collection's cascade rules). True when a record
   * was deleted; false when there was none, or it didn't match `filter`.
   */
  delete(collection: string, id: string, opts?: RecordsWriteOpts): Promise<boolean>;
}

function filterOf(what: string, opts: RecordsWriteOpts | undefined): string | null {
  if (opts?.filter === undefined) return null;
  if (typeof opts.filter !== "string" || opts.filter.trim() === "") {
    throw new Error(`helpers.${what}: filter must be a non-empty string`);
  }
  return opts.filter;
}

export function makeRecordsHelper(): RecordsHelper {
  return {
    create: (collection, data) => nested("records.create", async () => (await core()).createRecord(collection, data, null)),
    update: ((collection: string, id: string, data: Record<string, unknown>, opts?: RecordsWriteOpts) => nested("records.update", async () => {
      const filter = filterOf("records.update", opts);
      const r = await core();
      if (filter === null) return r.updateRecord(collection, id, data, null);
      try {
        return await r.updateRecord(collection, id, data, null, { match: { filter } });
      } catch (e) {
        if (e instanceof r.NoMatchError) return null;
        throw e;
      }
    })) as RecordsHelper["update"],
    delete: (collection, id, opts) => nested("records.delete", async () => {
      const filter = filterOf("records.delete", opts);
      const r = await core();
      if (filter === null) {
        // Deleting a missing record does nothing, as before; it just answers false.
        if (!(await r.getRecord(collection, id))) return false;
        await r.deleteRecord(collection, id, null);
        return true;
      }
      try {
        await r.deleteRecord(collection, id, null, { match: { filter } });
        return true;
      } catch (e) {
        if (e instanceof r.NoMatchError) return false;
        throw e;
      }
    }),
  };
}
