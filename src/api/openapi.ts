import Elysia from "elysia";
import { listCollections } from "../core/collections.ts";
import { buildOpenApi } from "../core/openapi.ts";
import { verifyAuthToken } from "../core/sec.ts";
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
      const token = request.headers.get("authorization")?.replace("Bearer ", "");
      const isAdmin = !!token && (await verifyAuthToken(token, jwtSecret, { audience: "admin" })) !== null;
      if (!isAdmin && getSetting("api.openapi_public", "0") !== "1") {
        set.status = 401;
        return { error: "Unauthorized", code: 401 };
      }
      const all = await listCollections();
      const visible = isAdmin
        ? all
        : all.filter((c) => !(c.list_rule === "" && c.view_rule === "" && c.create_rule === ""));
      set.headers["Cache-Control"] = "no-store";
      return buildOpenApi(visible);
    });
}
