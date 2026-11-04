/**
 * Audit log helpers: which record an entry is about, and where its history
 * opens. Kept out of the page so the tests run without the admin's deps.
 */

/** The record an audit target names (`collection=<name> id=<id>`), or null. */
export function auditRecordRef(target: string | null | undefined): { collection: string; id: string } | null {
  if (!target) return null;
  const collection = /(?:^|\s)collection=(\S+)/.exec(target)?.[1];
  const id = /(?:^|\s)id=(\S+)/.exec(target)?.[1];
  return collection && id ? { collection, id } : null;
}

/** The records page with that record's history open (works for a deleted record too). */
export function recordHistoryHref(collection: string, id: string): string {
  return `/_/collections/${encodeURIComponent(collection)}/records?record=${encodeURIComponent(id)}&history=1`;
}
