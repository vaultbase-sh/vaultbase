/**
 * URL-path helpers for the version-prefixed API.
 *
 * The HTTP API is mounted at `/api/v1/...` only: `/api/collections` without
 * the version is a 404. Custom routes are the exception: the dispatcher
 * matches them from `onRequest` through {@link customInnerPath}, so
 * `/api/custom/...` and `/api/v<n>/custom/...` both reach them.
 *
 * These helpers normalise a path by folding `/api/v\d+/...` down to
 * `/api/...`, so path-introspection sites (audit log, rate-limit detector,
 * maintenance mode, custom-route dispatch) only match one shape.
 */

/** Strip a `/v\d+` segment between `/api/` and the rest of the path. */
export function normalizeApiPath(pathname: string): string {
  return pathname.replace(/^\/api\/v\d+\//, "/api/");
}

/** Match `/api/admin/...` or `/api/v\d+/admin/...`. */
export function isAdminApiPath(pathname: string): boolean {
  return normalizeApiPath(pathname).startsWith("/api/admin/");
}

/**
 * Return everything after the `/api/custom` prefix (with leading slash
 * if any). Used by the custom-route dispatcher to route the inner
 * user-defined path. Returns null if `pathname` is not under custom.
 */
export function customInnerPath(pathname: string): string | null {
  const norm = normalizeApiPath(pathname);
  if (!norm.startsWith("/api/custom")) return null;
  return norm.slice("/api/custom".length) || "/";
}
