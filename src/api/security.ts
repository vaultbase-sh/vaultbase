/**
 * /api/v1/admin/security/* — backs the **Settings → Security** tab.
 */
import Elysia, { t } from "elysia";
import { verifyAuthToken } from "../core/sec.ts";
import { securityHeaders } from "../core/sec.ts";
import {
  listAdminSessions,
  revokeAdminSession,
  forceLogoutAllAdmins,
  shortFingerprint,
} from "../core/security.ts";

async function requireAdmin(request: Request, jwtSecret: string): Promise<boolean> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return false;
  return (await verifyAuthToken(token, jwtSecret, { audience: "admin" })) !== null;
}

export function makeSecurityPlugin(jwtSecret: string, encryptionKey: string | undefined) {
  return new Elysia({ name: "security" })
    .get("/admin/security/sessions", async ({ request, query, set }) => {
      if (!(await requireAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      const activeOnly = query.activeOnly !== "0";
      const sessions = await listAdminSessions({ activeOnly });
      return { data: sessions };
    }, {
      query: t.Object({ activeOnly: t.Optional(t.String()) }),
    })

    .delete("/admin/security/sessions/:jti", async ({ request, params, set }) => {
      if (!(await requireAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      await revokeAdminSession(params.jti);
      return { data: { revoked: params.jti } };
    })

    .post("/admin/security/force-logout-all", async ({ request, set }) => {
      if (!(await requireAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      const result = await forceLogoutAllAdmins();
      return { data: result };
    })

    .get("/admin/security/fingerprints", async ({ request, set }) => {
      if (!(await requireAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      const [jwtFp, aesFp] = await Promise.all([
        shortFingerprint(jwtSecret),
        encryptionKey ? shortFingerprint(encryptionKey) : Promise.resolve("—"),
      ]);
      return {
        data: {
          jwt_secret_fingerprint: jwtFp,
          encryption_key_fingerprint: aesFp,
          encryption_key_present: Boolean(encryptionKey),
        },
      };
    })

    .get("/admin/security/headers-preview", async ({ request, set }) => {
      if (!(await requireAdmin(request, jwtSecret))) {
        set.status = 401; return { error: "Unauthorized", code: 401 };
      }
      return {
        data: {
          api: securityHeaders({ isApi: true }),
          ui:  securityHeaders({ isApi: false }),
        },
      };
    });
}
