import Elysia, { t } from "elysia";
import * as jose from "jose";
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
  validateViewQuery,
} from "../core/collections.ts";

function isAdmin(request: Request, jwtSecret: string): Promise<boolean> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return Promise.resolve(false);
  const secret = new TextEncoder().encode(jwtSecret);
  return jose
    .jwtVerify(token, secret, { audience: "admin" })
    .then(() => true)
    .catch(() => false);
}

export function makeCollectionsPlugin(jwtSecret: string) {
  return new Elysia({ name: "collections" })
    .get("/collections", async () => {
      const data = await listCollections();
      return { data };
    })
    .get("/collections/:id", async ({ params, set }) => {
      const col = await getCollection(params.id);
      if (!col) { set.status = 404; return { error: "Not found", code: 404 }; }
      return { data: col };
    })
    .post(
      "/collections",
      async ({ body, request, set }) => {
        if (!(await isAdmin(request, jwtSecret))) {
          set.status = 403;
          return { error: "Forbidden", code: 403 };
        }
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
            create_rule: body.create_rule ?? null,
            update_rule: body.update_rule ?? null,
            delete_rule: body.delete_rule ?? null,
          };
          // Only forward list/view rules if explicitly provided so view-collection
          // safe defaults (admin-only) kick in when omitted.
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
      async ({ params, body, request, set }) => {
        if (!(await isAdmin(request, jwtSecret))) {
          set.status = 403;
          return { error: "Forbidden", code: 403 };
        }
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
          throw e;
        }
      },
      {
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
      async ({ body, request, set }) => {
        if (!(await isAdmin(request, jwtSecret))) {
          set.status = 403;
          return { error: "Forbidden", code: 403 };
        }
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
      { body: t.Object({ view_query: t.String() }) }
    )
    // Preview the first N rows a view query would return. Lets the admin UI
    // sanity-check a query before saving the collection — no view is created.
    .post(
      "/admin/collections/preview-view-rows",
      async ({ body, request, set }) => {
        if (!(await isAdmin(request, jwtSecret))) {
          set.status = 403;
          return { error: "Forbidden", code: 403 };
        }
        try {
          const limit = typeof body.limit === "number" ? body.limit : 5;
          const result = previewViewRows(body.view_query, limit);
          return { data: result };
        } catch (e) {
          set.status = 422;
          return { error: e instanceof Error ? e.message : String(e), code: 422 };
        }
      },
      { body: t.Object({ view_query: t.String(), limit: t.Optional(t.Number()) }) }
    )
    .delete("/collections/:id", async ({ params, request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 403;
        return { error: "Forbidden", code: 403 };
      }
      await deleteCollection(params.id);
      return { data: null };
    });
}
