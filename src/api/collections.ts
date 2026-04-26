import Elysia, { t } from "elysia";
import * as jose from "jose";
import {
  createCollection,
  deleteCollection,
  getCollection,
  listCollections,
  updateCollection,
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
    .get("/api/collections", async () => {
      const data = await listCollections();
      return { data };
    })
    .get("/api/collections/:id", async ({ params, set }) => {
      const col = await getCollection(params.id);
      if (!col) { set.status = 404; return { error: "Not found", code: 404 }; }
      return { data: col };
    })
    .post(
      "/api/collections",
      async ({ body, request, set }) => {
        if (!(await isAdmin(request, jwtSecret))) {
          set.status = 403;
          return { error: "Forbidden", code: 403 };
        }
        const col = await createCollection({
          name: body.name,
          fields: JSON.stringify(body.fields ?? []),
          list_rule: body.list_rule ?? null,
          view_rule: body.view_rule ?? null,
          create_rule: body.create_rule ?? null,
          update_rule: body.update_rule ?? null,
          delete_rule: body.delete_rule ?? null,
        });
        return { data: col };
      },
      {
        body: t.Object({
          name: t.String(),
          fields: t.Optional(t.Array(t.Any())),
          list_rule: t.Optional(t.Nullable(t.String())),
          view_rule: t.Optional(t.Nullable(t.String())),
          create_rule: t.Optional(t.Nullable(t.String())),
          update_rule: t.Optional(t.Nullable(t.String())),
          delete_rule: t.Optional(t.Nullable(t.String())),
        }),
      }
    )
    .patch(
      "/api/collections/:id",
      async ({ params, body, request, set }) => {
        if (!(await isAdmin(request, jwtSecret))) {
          set.status = 403;
          return { error: "Forbidden", code: 403 };
        }
        const update: Record<string, unknown> = {};
        if (body.name !== undefined) update["name"] = body.name;
        if (body.fields !== undefined) update["fields"] = JSON.stringify(body.fields);
        if ("list_rule" in body) update["list_rule"] = body.list_rule;
        if ("view_rule" in body) update["view_rule"] = body.view_rule;
        if ("create_rule" in body) update["create_rule"] = body.create_rule;
        if ("update_rule" in body) update["update_rule"] = body.update_rule;
        if ("delete_rule" in body) update["delete_rule"] = body.delete_rule;
        const col = await updateCollection(
          params.id,
          update as Parameters<typeof updateCollection>[1]
        );
        return { data: col };
      },
      {
        body: t.Object({
          name: t.Optional(t.String()),
          fields: t.Optional(t.Array(t.Any())),
          list_rule: t.Optional(t.Nullable(t.String())),
          view_rule: t.Optional(t.Nullable(t.String())),
          create_rule: t.Optional(t.Nullable(t.String())),
          update_rule: t.Optional(t.Nullable(t.String())),
          delete_rule: t.Optional(t.Nullable(t.String())),
        }),
      }
    )
    .delete("/api/collections/:id", async ({ params, request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 403;
        return { error: "Forbidden", code: 403 };
      }
      await deleteCollection(params.id);
      return { data: null };
    });
}
