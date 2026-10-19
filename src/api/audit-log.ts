import Elysia, { t } from "elysia";
import { listAuditEntries, recordAuditEntry } from "../core/audit-log.ts";
import { isAdminApiPath, normalizeApiPath } from "../core/api-paths.ts";
import { adminFromRequest, adminGuard } from "./_admin.ts";

/** Admin paths, plus collections: admin-only, but outside /admin. */
function isAuditedPath(pathname: string): boolean {
  if (isAdminApiPath(pathname)) return true;
  const p = normalizeApiPath(pathname);
  return p === "/api/collections" || p.startsWith("/api/collections/");
}

export function makeAuditLogPlugin(jwtSecret: string) {
  return new Elysia({ name: "audit-log" })
    .use(adminGuard(jwtSecret))
    // ── Globally-scoped onAfterHandle: capture every state-changing
    //    /api/v1/admin/* request. Only writes on AUDITED_METHODS — read GETs
    //    are skipped inside recordAuditEntry.
    .onAfterHandle({ as: "global" }, async ({ request, set }) => {
      // No need to skip non-admin paths here — recordAuditEntry filters.
      const url = new URL(request.url);
      if (!isAuditedPath(url.pathname)) return;

      const status = Number(set.status ?? 200);
      // Same token sources as the admin UI, the session cookie included, so
      // actions taken there are attributed.
      const actor = await adminFromRequest(request, jwtSecret, { cookie: true });
      // Body is already consumed by the handler — we don't try to capture
      // it. The action label + target id from the path is sufficient for
      // most audit needs; full request bodies belong in the file logger.
      void recordAuditEntry({ request, status, actor }).catch(() => { /* swallow */ });
    })
    .onError({ as: "global" }, async ({ request, error }) => {
      const url = new URL(request.url);
      if (!isAuditedPath(url.pathname)) return;
      const status = "status" in error ? Number((error as { status: number }).status) : 500;
      const actor = await adminFromRequest(request, jwtSecret, { cookie: true });
      void recordAuditEntry({ request, status, actor }).catch(() => { /* swallow */ });
    })

    // ── Read API ────────────────────────────────────────────────────────
    .get(
      "/admin/audit-log",
      async ({ query }) => {
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
        requireAdmin: { cookie: true },
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
