import Elysia, { t } from "elysia";
import { listAuditEntries, recordAuditEntry } from "../core/audit-log.ts";
import { verifyAuthToken } from "../core/sec.ts";
import { isAdminApiPath } from "../core/api-paths.ts";

async function getAdmin(request: Request, jwtSecret: string): Promise<{ id: string; email: string } | null> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return null;
  const ctx = await verifyAuthToken(token, jwtSecret, { audience: "admin" });
  if (!ctx) return null;
  return { id: ctx.id, email: ctx.email ?? "" };
}

export function makeAuditLogPlugin(jwtSecret: string) {
  return new Elysia({ name: "audit-log" })
    // ── Globally-scoped onAfterHandle: capture every state-changing
    //    /api/admin/* request. Only writes on AUDITED_METHODS — read GETs
    //    are skipped inside recordAuditEntry.
    .onAfterHandle({ as: "global" }, async ({ request, set }) => {
      // No need to skip non-admin paths here — recordAuditEntry filters.
      const url = new URL(request.url);
      if (!isAdminApiPath(url.pathname)) return;

      const status = Number(set.status ?? 200);
      const actor = await getAdmin(request, jwtSecret);
      // Body is already consumed by the handler — we don't try to capture
      // it. The action label + target id from the path is sufficient for
      // most audit needs; full request bodies belong in the file logger.
      void recordAuditEntry({ request, status, actor }).catch(() => { /* swallow */ });
    })
    .onError({ as: "global" }, async ({ request, error }) => {
      const url = new URL(request.url);
      if (!isAdminApiPath(url.pathname)) return;
      const status = "status" in error ? Number((error as { status: number }).status) : 500;
      const actor = await getAdmin(request, jwtSecret);
      void recordAuditEntry({ request, status, actor }).catch(() => { /* swallow */ });
    })

    // ── Read API ────────────────────────────────────────────────────────
    .get(
      "/admin/audit-log",
      async ({ request, query, set }) => {
        const me = await getAdmin(request, jwtSecret);
        if (!me) { set.status = 401; return { error: "Unauthorized", code: 401 }; }
        const opts: Parameters<typeof listAuditEntries>[0] = {};
        if (query.page) opts.page = parseInt(query.page);
        if (query.perPage) opts.perPage = parseInt(query.perPage);
        if (query.actorId) opts.actorId = query.actorId;
        if (query.actionPrefix) opts.actionPrefix = query.actionPrefix;
        if (query.from) opts.from = parseInt(query.from);
        if (query.to) opts.to = parseInt(query.to);
        const result = await listAuditEntries(opts);
        return { data: result };
      },
      {
        query: t.Object({
          page: t.Optional(t.String()),
          perPage: t.Optional(t.String()),
          actorId: t.Optional(t.String()),
          actionPrefix: t.Optional(t.String()),
          from: t.Optional(t.String()),
          to: t.Optional(t.String()),
        }),
      }
    );
}
