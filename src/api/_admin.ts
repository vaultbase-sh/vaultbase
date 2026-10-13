import Elysia from "elysia";
import { extractBearer, verifyAuthToken } from "../core/sec.ts";

/** The admin behind a request: an admin session, or an API token acting as its minting admin. */
export interface AdminPrincipal {
  id: string;
  email: string;
  viaApiToken: boolean;
  /** Token expiry (unix seconds). */
  exp?: number;
}

export interface AdminFromRequestOpts {
  /**
   * Also accept the `vaultbase_admin_token` cookie (same-origin only, see
   * `extractBearer`). Off by default: a cookie is ambient authority, so only
   * the routes the admin UI calls with it opt in.
   */
  cookie?: boolean;
}

/** Verify the request's admin token. Null when there is none or it doesn't verify. */
export async function adminFromRequest(
  request: Request,
  jwtSecret: string,
  opts: AdminFromRequestOpts = {},
): Promise<AdminPrincipal | null> {
  const token = opts.cookie ? extractBearer(request) : headerToken(request);
  if (!token) return null;
  const ctx = await verifyAuthToken(token, jwtSecret, { audience: "admin" });
  if (!ctx) return null;
  const admin: AdminPrincipal = { id: ctx.id, email: ctx.email ?? "", viaApiToken: ctx.viaApiToken === true };
  if (ctx.exp !== undefined) admin.exp = ctx.exp;
  return admin;
}

function headerToken(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const raw = h.replace(/^Bearer\s+/i, "").trim();
  if (!raw) return null;
  return raw.startsWith("vbat_") ? raw.slice(5) : raw;
}

export interface RequireAdminOpts extends AdminFromRequestOpts {
  /** Refuse API tokens: the route needs an interactive admin session. */
  session?: boolean;
}

/**
 * `requireAdmin` route option. The route answers 401 unless the request
 * carries a valid admin token; the handler receives the caller as `admin`.
 *
 *   .get("/admin/x", ({ admin }) => …, { requireAdmin: true })
 *   .post("/admin/y", …, { requireAdmin: { cookie: true, session: true } })
 *
 * The refusal comes from `beforeHandle`, not `resolve`: a response returned
 * from `resolve` skips the `onAfterHandle` hooks, so the 401 would go out
 * without the security, CORS and no-store headers and without a log entry.
 * `resolve` runs first; if it ever didn't, `beforeHandle` would find no
 * `admin` and still refuse.
 */
export function adminGuard(jwtSecret: string) {
  return new Elysia({ name: "admin-guard", seed: jwtSecret }).macro({
    requireAdmin(opt: true | RequireAdminOpts) {
      const opts: RequireAdminOpts = opt === true ? {} : opt;
      return {
        async resolve({ request }) {
          const admin = await adminFromRequest(request, jwtSecret, opts);
          const allowed = admin && !(opts.session && admin.viaApiToken) ? admin : null;
          // Non-null for every handler that runs: beforeHandle refuses otherwise.
          return { admin: allowed as AdminPrincipal };
        },
        beforeHandle(ctx) {
          if ((ctx as { admin?: AdminPrincipal | null }).admin) return;
          const error = opts.session ? "Unauthorized — interactive admin session required" : "Unauthorized";
          return ctx.status(401, { error, code: 401 });
        },
      };
    },
  });
}
