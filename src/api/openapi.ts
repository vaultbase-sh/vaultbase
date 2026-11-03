import Elysia from "elysia";
import { listCollections } from "../core/collections.ts";
import { buildOpenApi } from "../core/openapi.ts";
import { adminOnlyRule } from "../core/records.ts";
import { adminFromRequest } from "./_admin.ts";
import { getSetting } from "./settings.ts";

/**
 * `GET /api/v1/openapi.json`. Admins get every collection. Anyone else gets
 * it only when `api.openapi_public` is "1", and then without collections
 * whose list, view and create rules are all admin-only: their names and
 * fields stay private.
 */
export function makeOpenApiPlugin(jwtSecret: string) {
  return new Elysia({ name: "openapi" })
    .get("/openapi.json", async ({ request, set }) => {
      const isAdmin = (await adminFromRequest(request, jwtSecret)) !== null;
      if (!isAdmin && getSetting("api.openapi_public", "0") !== "1") {
        set.status = 401;
        return { error: "Unauthorized", code: 401 };
      }
      const all = await listCollections();
      // A blank rule ("  ", "\t") denies non-admins just as "" does.
      const visible = isAdmin
        ? all
        : all.filter((c) => !(adminOnlyRule(c.list_rule) && adminOnlyRule(c.view_rule) && adminOnlyRule(c.create_rule)));
      set.headers["Cache-Control"] = "no-store";
      return buildOpenApi(visible);
    });
}
