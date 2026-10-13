/**
 * /api/v1/admin/security/* — backs the **Settings → Security** tab.
 */
import Elysia, { t } from "elysia";
import { securityHeaders } from "../core/sec.ts";
import {
  listAdminSessions,
  revokeAdminSession,
  forceLogoutAllAdmins,
  shortFingerprint,
} from "../core/security.ts";
import { adminGuard } from "./_admin.ts";

export function makeSecurityPlugin(jwtSecret: string, encryptionKey: string | undefined) {
  return new Elysia({ name: "security" })
    .use(adminGuard(jwtSecret))
    .get("/admin/security/sessions", async ({ query }) => {
      const activeOnly = query.activeOnly !== "0";
      const sessions = await listAdminSessions({ activeOnly });
      return { data: sessions };
    }, {
      requireAdmin: true,
      query: t.Object({ activeOnly: t.Optional(t.String()) }),
    })

    .delete("/admin/security/sessions/:jti", async ({ params }) => {
      await revokeAdminSession(params.jti);
      return { data: { revoked: params.jti } };
    }, { requireAdmin: true })

    .post("/admin/security/force-logout-all", async () => {
      const result = await forceLogoutAllAdmins();
      return { data: result };
    }, { requireAdmin: true })

    .get("/admin/security/fingerprints", async () => {
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
    }, { requireAdmin: true })

    .get("/admin/security/headers-preview", async () => {
      return {
        data: {
          api: securityHeaders({ isApi: true }),
          ui:  securityHeaders({ isApi: false }),
        },
      };
    }, { requireAdmin: true });
}
