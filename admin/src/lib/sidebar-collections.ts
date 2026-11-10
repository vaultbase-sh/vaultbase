/**
 * The collections listed under "Collections" in the sidebar: by name, at
 * most `limit` of them, the rest reached through "All collections". The
 * open collection is always listed, even past the limit.
 */
export interface SidebarCollection { id: string; name: string; type: string }

export const SIDEBAR_COLLECTIONS_LIMIT = 15;

export function sidebarCollections<T extends SidebarCollection>(
  list: readonly T[],
  activeId: string | null,
  limit = SIDEBAR_COLLECTIONS_LIMIT,
): { shown: T[]; hidden: number } {
  const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name));
  if (sorted.length <= limit) return { shown: sorted, hidden: 0 };
  const shown = sorted.slice(0, limit);
  const active = activeId ? sorted.find((c) => c.id === activeId) : undefined;
  if (active && !shown.includes(active)) shown.push(active);
  return { shown, hidden: sorted.length - shown.length };
}

/** The collection id in an admin path like /_/collections/<id>/records, or null. */
export function collectionIdFromPath(pathname: string): string | null {
  const m = /^\/_\/collections\/([^/]+)\/(records|edit)\/?$/.exec(pathname);
  return m ? decodeURIComponent(m[1]!) : null;
}
