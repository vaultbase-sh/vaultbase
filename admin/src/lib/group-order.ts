/**
 * Split ranked items into groups shown in `order`, keeping each group's
 * ranking. `flat` is the order the items appear on screen, which is the
 * order keyboard navigation must follow.
 */
export function groupInOrder<G extends string, T extends { group: G }>(
  items: readonly T[],
  order: readonly G[],
): { groups: Array<{ group: G; items: T[] }>; flat: T[] } {
  const groups = order
    .map((group) => ({ group, items: items.filter((it) => it.group === group) }))
    .filter((g) => g.items.length > 0);
  return { groups, flat: groups.flatMap((g) => g.items) };
}
