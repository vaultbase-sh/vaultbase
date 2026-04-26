import Elysia from "elysia";
import type { Config } from "./config.ts";
import { makeAuthPlugin } from "./api/auth.ts";
import { makeCollectionsPlugin } from "./api/collections.ts";
import { makeRecordsPlugin } from "./api/records.ts";
import { makeFilesPlugin } from "./api/files.ts";
import { makeAdminPlugin } from "./admin/index.ts";
import { subscribe, unsubscribe, disconnectAll } from "./realtime/manager.ts";

interface ClientMessage {
  type: "subscribe" | "unsubscribe";
  collections: string[];
}

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
    })
    .get("/api/health", () => ({ data: { status: "ok" } }));
}
