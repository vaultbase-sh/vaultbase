/**
 * URL-path helpers for the version-prefixed API.
 *
 * The HTTP API is mounted at `/api/v1/...`. A legacy alias keeps
 * `/api/...` (no version) working for back-compat: it serves the same
 * routes.
 *
 * Path-introspection sites (audit log, rate-limit detector, custom-route
 * mount) need to match BOTH forms. These helpers normalise the path by
 * folding `/api/v\d+/...` down to `/api/...` so each matcher only has to
 * care about the canonical shape.
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
