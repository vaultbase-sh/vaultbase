import Elysia from "elysia";
import type { Config } from "./config.ts";
import { makeAuthPlugin } from "./api/auth.ts";
import { makeCollectionsPlugin } from "./api/collections.ts";
import { makeRecordsPlugin } from "./api/records.ts";
import { makeFilesPlugin } from "./api/files.ts";
import { makeAdminPlugin } from "./admin/index.ts";

export function createServer(config: Config) {
  return new Elysia()
    .use(makeAuthPlugin(config.jwtSecret))
    .use(makeCollectionsPlugin(config.jwtSecret))
    .use(makeRecordsPlugin(config.jwtSecret))
    .use(makeFilesPlugin(config.uploadDir))
    .use(makeAdminPlugin())
    .ws("/api/realtime", {
      open(ws) {
        ws.send(JSON.stringify({ type: "connected" }));
      },
      message() {},
      close() {},
    })
    .get("/api/health", () => ({ data: { status: "ok" } }));
}
