/**
 * A copy of `items` with the item at `from` moved to `to` (both clamped to
 * the list). Used where order matters, such as rate limit rules: the server
 * applies the first rule that matches.
 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const out = [...items];
  if (from < 0 || from >= out.length) return out;
  const target = Math.max(0, Math.min(out.length - 1, to));
  if (target === from) return out;
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item as T);
  return out;
}
