/**
 * What's registered: field types, providers, drivers, the hooks, routes,
 * cron jobs and workers added from code, and the hooks folder's state. Read-only; for the admin
 * UI and for checking that an extension loaded.
 */
import Elysia from "elysia";
import { verifyAuthToken } from "../core/sec.ts";
import { listFieldTypes } from "../core/field-types.ts";
import { listOAuthProviders } from "../core/oauth2.ts";
import { listStorageDrivers } from "../core/storage.ts";
import { listEmailTransports } from "../core/email.ts";
import { listPushProviders } from "../core/notifications.ts";
import { listRegisteredHooks } from "../core/hooks.ts";
import { listRegisteredRoutes } from "../core/routes.ts";
import { listRegisteredJobs } from "../core/jobs.ts";
import { listRegisteredWorkers } from "../core/queues.ts";
import { codeFileErrors, codeFilesDir } from "../core/code-files.ts";

async function isAdmin(request: Request, jwtSecret: string): Promise<boolean> {
  const token = request.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return false;
  return (await verifyAuthToken(token, jwtSecret, { audience: "admin" })) !== null;
}

export function makeExtensionsPlugin(jwtSecret: string) {
  return new Elysia({ name: "extensions" })
    .get("/admin/extensions", async ({ request, set }) => {
      if (!(await isAdmin(request, jwtSecret))) {
        set.status = 401;
        return { error: "Unauthorized", code: 401 };
      }
      return {
        data: {
          fieldTypes: listFieldTypes(),
          oauthProviders: listOAuthProviders(),
          storageDrivers: listStorageDrivers(),
          emailTransports: listEmailTransports(),
          pushProviders: listPushProviders(),
          hooks: listRegisteredHooks(),
          routes: listRegisteredRoutes(),
          jobs: listRegisteredJobs(),
          workers: listRegisteredWorkers(),
          // The hooks folder (null when hooks live in the database) and the
          // files in it that didn't load.
          hookFiles: { dir: codeFilesDir(), errors: codeFileErrors() },
        },
      };
    });
}
