import Elysia from "elysia";
import type { Config } from "./config.ts";
import { setLogsDir } from "./core/file-logger.ts";
import { makeAuthPlugin } from "./api/auth.ts";
import { makeCollectionsPlugin } from "./api/collections.ts";
import { makeRecordsPlugin } from "./api/records.ts";
import { makeFilesPlugin } from "./api/files.ts";
import { makeAdminPlugin } from "./admin/index.ts";
import { makeLogsPlugin } from "./api/logs.ts";
import { makeAdminsPlugin } from "./api/admins.ts";
import { makeBackupPlugin } from "./api/backup.ts";
import { makeRateLimitPlugin } from "./api/ratelimit.ts";
import { makeIndexesPlugin } from "./api/indexes.ts";
import { makeSettingsPlugin } from "./api/settings.ts";
import { makeHooksPlugin } from "./api/hooks.ts";
import { makeRoutesPlugin, tryDispatchCustom } from "./api/routes.ts";
import { makeJobsPlugin } from "./api/jobs.ts";
import { makeBatchPlugin } from "./api/batch.ts";
import { startScheduler } from "./core/jobs.ts";
import { subscribe, unsubscribe, disconnectAll } from "./realtime/manager.ts";

interface ClientMessage {
  type: "subscribe" | "unsubscribe";
  collections: string[];
}

export function createServer(config: Config) {
  setLogsDir(config.logsDir);
  startScheduler();
  return new Elysia()
    // Custom user routes fire before built-in route resolution so they can't
    // collide with /api/:collection or any other built-in pattern.
    .onRequest(async ({ request }) => {
      const res = await tryDispatchCustom(request, config.jwtSecret);
      if (res) return res;
    })
    .use(makeRateLimitPlugin())
    .use(makeLogsPlugin(config.jwtSecret))
    .use(makeAuthPlugin(config.jwtSecret))
    .use(makeAdminsPlugin(config.jwtSecret))
    .use(makeBackupPlugin(config.jwtSecret, config.dbPath))
    .use(makeIndexesPlugin(config.jwtSecret))
    .use(makeSettingsPlugin(config.jwtSecret))
    .use(makeHooksPlugin(config.jwtSecret))
    .use(makeRoutesPlugin(config.jwtSecret))
    .use(makeJobsPlugin(config.jwtSecret))
    .use(makeBatchPlugin(config.jwtSecret))
    .use(makeCollectionsPlugin(config.jwtSecret))
    .use(makeFilesPlugin(config.uploadDir))
    .use(makeAdminPlugin())
    .get("/api/health", () => ({ data: { status: "ok" } }))
    .use(makeRecordsPlugin(config.jwtSecret))
    .ws("/realtime", {
      open(ws) {
        ws.send(JSON.stringify({ type: "connected" }));
      },
      message(ws, message) {
        let msg: ClientMessage;
        try {
          msg = (typeof message === "string" ? JSON.parse(message) : message) as ClientMessage;
        } catch {
          return;
        }
        if (!Array.isArray(msg.collections)) return;
        if (msg.type === "subscribe") subscribe(ws, msg.collections);
        else if (msg.type === "unsubscribe") unsubscribe(ws, msg.collections);
      },
      close(ws) {
        disconnectAll(ws);
      },
    });
}
