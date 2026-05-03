/**
 * Admin REST surface for API tokens.
 *
 *   GET    /admin/api-tokens          — list (no token values, only metadata)
 *   GET    /admin/api-tokens/:id      — one
 *   POST   /admin/api-tokens          — mint, returns the token ONCE
 *   DELETE /admin/api-tokens/:id      — revoke
 *   GET    /admin/api-tokens/me       — describe the current request's token
 *
 * Routes mount under `/api/v1` via the server's group prefix.
 */
import Elysia, { t } from "elysia";
import {
  DEFAULT_API_TOKEN_TTL_SEC,
  KNOWN_SCOPES,
  MAX_API_TOKEN_TTL_SEC,
  getApiToken,
  listApiTokens,
  mintApiToken,
  revokeApiToken,
} from "../core/api-tokens.ts";
import { extractBearer, verifyAuthToken } from "../core/sec.ts";

interface AdminCtx { id: string; email: string }

async function getAdmin(request: Request, jwtSecret: string): Promise<AdminCtx | null> {
  const token = extractBearer(request);
  if (!token) return null;
  const ctx = await verifyAuthToken(token, jwtSecret, { audience: "admin" });
  if (!ctx) return null;
  return { id: ctx.id, email: ctx.email ?? "" };
}

/** Sanitised row for the wire — never includes a token value. */
function rowForWire(r: Awaited<ReturnType<typeof getApiToken>>) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    scopes: r.scopes,
    created_by: r.created_by,
    created_by_email: r.created_by_email,
    created_at: r.created_at,
    expires_at: r.expires_at,
    revoked_at: r.revoked_at,
    last_used_at: r.last_used_at,
    last_used_ip: r.last_used_ip,
    last_used_ua: r.last_used_ua,
    use_count: r.use_count,
    status: r.revoked_at ? "revoked"
      : r.expires_at < Math.floor(Date.now() / 1000) ? "expired"
      : "active",
  };
}

export function makeApiTokensPlugin(jwtSecret: string) {
  return new Elysia({ name: "api-tokens" })
    .get("/admin/api-tokens", async ({ request, set }) => {
      const me = await getAdmin(request, jwtSecret);
      if (!me) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      const rows = await listApiTokens();
      return { data: rows.map((r) => rowForWire(r)) };
    })
    .get("/admin/api-tokens/me", async ({ request, set }) => {
      // Useful for client tooling to verify what scopes a token has.
      const tok = extractBearer(request);
      if (!tok) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      const ctx = await verifyAuthToken(tok, jwtSecret);
      if (!ctx || !ctx.viaApiToken) { set.status = 400; return { error: "not an api token", code: 400 }; }
      return {
        data: {
          id: ctx.jti,
          name: ctx.tokenName ?? "",
          scopes: ctx.scopes ?? [],
          minter_email: ctx.email ?? "",
          expires_at: ctx.exp ?? 0,
        },
      };
    })
    .get("/admin/api-tokens/:id", async ({ request, params, set }) => {
      const me = await getAdmin(request, jwtSecret);
      if (!me) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      const row = await getApiToken(params.id);
      if (!row) { set.status = 404; return { error: "Token not found", code: 404 }; }
      return { data: rowForWire(row) };
    })
    .post(
      "/admin/api-tokens",
      async ({ request, body, set }) => {
        const me = await getAdmin(request, jwtSecret);
        if (!me) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
        try {
          const ttlSeconds = body.ttl_seconds ?? body.ttlSeconds ?? DEFAULT_API_TOKEN_TTL_SEC;
          const result = await mintApiToken({
            name: body.name,
            scopes: body.scopes,
            ttlSeconds,
            createdBy: me.id,
            createdByEmail: me.email,
          }, jwtSecret);
          // Return the token ONCE. Caller MUST persist it.
          set.status = 201;
          return {
            data: {
              id: result.id,
              token: result.token,
              expires_at: result.expires_at,
              warning: "Save this token now — it will never be shown again.",
            },
          };
        } catch (e) {
          set.status = 422;
          return { error: e instanceof Error ? e.message : "mint failed", code: 422 };
        }
      },
      {
        body: t.Object({
          name: t.String({ minLength: 1, maxLength: 100 }),
          scopes: t.Array(t.String({ minLength: 1, maxLength: 64 }), { minItems: 1 }),
          ttl_seconds: t.Optional(t.Integer({ minimum: 60, maximum: MAX_API_TOKEN_TTL_SEC })),
          ttlSeconds:  t.Optional(t.Integer({ minimum: 60, maximum: MAX_API_TOKEN_TTL_SEC })),
        }),
      },
    )
    .delete("/admin/api-tokens/:id", async ({ request, params, set }) => {
      const me = await getAdmin(request, jwtSecret);
      if (!me) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      const r = await revokeApiToken(params.id);
      if (!r.revoked) { set.status = 404; return { error: "Token not found", code: 404 }; }
      return { data: { revoked: true } };
    })
    .get("/admin/api-tokens-meta/scopes", async ({ request, set }) => {
      const me = await getAdmin(request, jwtSecret);
      if (!me) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
      return { data: { scopes: KNOWN_SCOPES } };
    });
}
