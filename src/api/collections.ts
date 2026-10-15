import Elysia, { t } from "elysia";
import {
  CollectionValidationError,
  createCollection,
  deleteCollection,
  getCollection,
  inferViewColumns,
  inferViewFields,
  previewViewRows,
  listCollections,
  updateCollection,
  userTableName,
  validateViewQuery,
} from "../core/collections.ts";
import { db } from "../db/index.ts";
import { adminGuard } from "./_admin.ts";

export function makeCollectionsPlugin(jwtSecret: string) {
  return new Elysia({ name: "collections" })
    .use(adminGuard(jwtSecret))
    // Collection definitions carry every rule, field and view query — a map
    // of what is protected and how — so reading them is admin-only, like the
    // OpenAPI document.
    .get("/collections", async () => {
      const data = await listCollections();
      return { data };
    }, { requireAdmin: true })
    .get("/collections/:id", async ({ params, set }) => {
      const col = await getCollection(params.id);
      if (!col) { set.status = 404; return { error: "Not found", code: 404 }; }
      return { data: col };
    }, { requireAdmin: true })
    .post(
      "/collections",
      async ({ body, set }) => {
        const type = body.type ?? "base";
        if (type !== "base" && type !== "auth" && type !== "view") {
          set.status = 422;
          return { error: "type must be 'base', 'auth', or 'view'", code: 422 };
        }
        if (type === "view" && !body.view_query) {
          set.status = 422;
          return { error: "view collections require a view_query", code: 422 };
        }
        try {
          const init: Parameters<typeof createCollection>[0] = {
            name: body.name,
            type,
            fields: JSON.stringify(body.fields ?? []),
          };
          // Forward each rule only when the caller actually sent one. `?? null`
          // here used to turn "omitted" into "public" before createCollection's
          // defaults could apply. An explicit `null` still means public.
          if (body.create_rule !== undefined) init.create_rule = body.create_rule;
          if (body.update_rule !== undefined) init.update_rule = body.update_rule;
          if (body.delete_rule !== undefined) init.delete_rule = body.delete_rule;
          if (body.list_rule !== undefined) init.list_rule = body.list_rule;
          if (body.view_rule !== undefined) init.view_rule = body.view_rule;
          if (body.view_query !== undefined) init.view_query = body.view_query;
          if (body.history_enabled !== undefined) init.history_enabled = body.history_enabled ? 1 : 0;
          const col = await createCollection(init);
          return { data: col };
        } catch (e) {
          if (e instanceof CollectionValidationError) {
            set.status = 422;
            return { error: e.message, code: 422, details: e.details };
          }
          if (e instanceof Error && /view query/i.test(e.message)) {
            set.status = 422;
            return { error: e.message, code: 422 };
          }
          // SQLite UNIQUE on collection name → friendly 400 instead of crashing
          if (e instanceof Error && /UNIQUE constraint failed.*collections\.name/i.test(e.message)) {
            set.status = 400;
            return { error: `A collection named '${body.name}' already exists`, code: 400 };
          }
          throw e;
        }
      },
      {
        requireAdmin: true,
        body: t.Object({
          name: t.String(),
          type: t.Optional(t.String()),
          fields: t.Optional(t.Array(t.Any())),
          view_query: t.Optional(t.String()),
          list_rule: t.Optional(t.Nullable(t.String())),
          view_rule: t.Optional(t.Nullable(t.String())),
          create_rule: t.Optional(t.Nullable(t.String())),
          update_rule: t.Optional(t.Nullable(t.String())),
          delete_rule: t.Optional(t.Nullable(t.String())),
          history_enabled: t.Optional(t.Boolean()),
        }),
      }
    )
    .patch(
      "/collections/:id",
      async ({ params, body, set }) => {
        const update: Record<string, unknown> = {};
        if (body.name !== undefined) update["name"] = body.name;
        if (body.fields !== undefined) update["fields"] = JSON.stringify(body.fields);
        if (body.view_query !== undefined) update["view_query"] = body.view_query;
        if ("list_rule" in body) update["list_rule"] = body.list_rule;
        if ("view_rule" in body) update["view_rule"] = body.view_rule;
        if ("create_rule" in body) update["create_rule"] = body.create_rule;
        if ("update_rule" in body) update["update_rule"] = body.update_rule;
        if ("delete_rule" in body) update["delete_rule"] = body.delete_rule;
        if (body.history_enabled !== undefined) update["history_enabled"] = body.history_enabled ? 1 : 0;
        try {
          const col = await updateCollection(
            params.id,
            update as Parameters<typeof updateCollection>[1]
          );
          return { data: col };
        } catch (e) {
          if (e instanceof CollectionValidationError) {
            set.status = 422;
            return { error: e.message, code: 422, details: e.details };
          }
          if (e instanceof Error && /view query/i.test(e.message)) {
            set.status = 422;
            return { error: e.message, code: 422 };
          }
          if (e instanceof Error && /UNIQUE constraint failed.*collections\.name/i.test(e.message)) {
            set.status = 400;
            return { error: `A collection with that name already exists`, code: 400 };
          }
          // Rename: name taken / not a valid identifier.
          if (e instanceof Error && /already exists|^invalid collection name/i.test(e.message)) {
            set.status = 400;
            return { error: e.message, code: 400 };
          }
          throw e;
        }
      },
      {
        requireAdmin: true,
        body: t.Object({
          name: t.Optional(t.String()),
          fields: t.Optional(t.Array(t.Any())),
          view_query: t.Optional(t.String()),
          list_rule: t.Optional(t.Nullable(t.String())),
          view_rule: t.Optional(t.Nullable(t.String())),
          create_rule: t.Optional(t.Nullable(t.String())),
          update_rule: t.Optional(t.Nullable(t.String())),
          delete_rule: t.Optional(t.Nullable(t.String())),
          history_enabled: t.Optional(t.Boolean()),
        }),
      }
    )
    // Dry-run a view query: validate syntax + infer columns. Lets the admin UI
    // surface errors and refresh the field list without actually creating a view.
    .post(
      "/admin/collections/preview-view",
      async ({ body, set }) => {
        try {
          validateViewQuery(body.view_query);
          const columns = inferViewColumns(body.view_query);
          const fields = inferViewFields(body.view_query);
          return { data: { columns, fields } };
        } catch (e) {
          set.status = 422;
          return { error: e instanceof Error ? e.message : String(e), code: 422 };
        }
      },
      { requireAdmin: true, body: t.Object({ view_query: t.String() }) }
    )
    // Preview the first N rows a view query would return. Lets the admin UI
    // sanity-check a query before saving the collection — no view is created.
    .post(
      "/admin/collections/preview-view-rows",
      async ({ body, set }) => {
        try {
          const limit = typeof body.limit === "number" ? body.limit : 5;
          const result = previewViewRows(body.view_query, limit);
          return { data: result };
        } catch (e) {
          set.status = 422;
          return { error: e instanceof Error ? e.message : String(e), code: 422 };
        }
      },
      { requireAdmin: true, body: t.Object({ view_query: t.String(), limit: t.Optional(t.Number()) }) }
    )
    .delete("/collections/:id", async ({ params }) => {
      await deleteCollection(params.id);
      return { data: null };
    }, { requireAdmin: true })

    // Per-collection counts + activity. Backs the Collections page so the
    // "records" + "activity" cells get real values. Admin-only — exposes
    // table-level cardinality.
    .get("/admin/collections/stats", async ({ query }) => {
      const cols = await listCollections();
      const now = Math.floor(Date.now() / 1000);
      // `window` drives `recentWrites` (dashboard range picker). Defaults to
      // 24h, which is what this endpoint always used; clamped to 30d so a
      // caller can't widen it into a full-table scan.
      const rawWindow = Number.parseInt(String(query.window ?? ""), 10);
      const recentWindowSec = Number.isFinite(rawWindow) && rawWindow > 0
        ? Math.min(rawWindow, 30 * 86_400)
        : 24 * 60 * 60;
      const cutoff = now - recentWindowSec;
      // Hard cap on count(*) — large tables stay responsive ("50k+" in UI).
      const COUNT_CAP = 50_000;

      const stats = await Promise.all(cols.map(async (c) => {
        const out = {
          name: c.name,
          type: c.type,
          recordCount: null as number | null,
          recordCountCapped: false,
          lastUpdated: null as number | null,
          recentWrites: 0,
        };
        // View collections — counts work via the underlying SELECT but
        // skipping for now (could be huge / expensive). Activity unknowable.
        if (c.type === "view") return out;
        const tname = `"${userTableName(c.name).replace(/"/g, '""')}"`;
        try {
          // Capped count: SELECT count over a LIMIT'd subquery.
          const r = await db.get<{ n: number }>(
            `SELECT count(*) AS n FROM (SELECT 1 FROM ${tname} LIMIT ?)`,
            [COUNT_CAP + 1],
          );
          if (r) {
            if (r.n > COUNT_CAP) {
              out.recordCount = COUNT_CAP;
              out.recordCountCapped = true;
            } else {
              out.recordCount = r.n;
            }
          }
        } catch { /* table missing — leave null */ }
        try {
          const r = await db.get<{ m: number | null }>(
            `SELECT max(updated_at) AS m FROM ${tname}`,
          );
          if (r?.m != null) out.lastUpdated = r.m;
        } catch { /* skip */ }
        try {
          const r = await db.get<{ n: number }>(
            `SELECT count(*) AS n FROM ${tname} WHERE updated_at > ?`,
            [cutoff],
          );
          if (r) out.recentWrites = r.n;
        } catch { /* skip */ }
        return out;
      }));

      return {
        data: stats,
        windowSec: recentWindowSec,
        cap: COUNT_CAP,
      };
    }, { requireAdmin: true });
}
