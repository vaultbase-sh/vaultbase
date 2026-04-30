import { parseExpression, type Expr } from "./expression.ts";

/**
 * AST cache for filter / rule strings. The parse path is the most expensive
 * step in `parseFilter` after the SQLite query itself; caching the AST keeps
 * hot endpoints (records list, list_rule eval) at p50 < 1ms.
 *
 * LRU bound at 512 entries — typical apps have <50 distinct rules but tests
 * with thousands of generated expressions don't blow up the cache.
 *
 * The cache stores the parsed AST. Compilation to SQL still runs per-call
 * because params depend on the live request context (auth, query, body).
 */

const MAX_ENTRIES = 512;
const cache = new Map<string, Expr | null>();

export function cachedParseExpression(expr: string): Expr | null {
  const key = expr.length > 4096 ? `__too_long__${expr.length}` : expr;
  if (cache.has(key)) {
    const v = cache.get(key)!;
    // Refresh LRU order
    cache.delete(key);
    cache.set(key, v);
    return v;
  }
  const ast = parseExpression(expr);
  if (cache.size >= MAX_ENTRIES) {
    // Evict the oldest entry (first inserted). Map iteration order = insertion.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, ast);
  return ast;
}

export function clearFilterCache(): void {
  cache.clear();
}
