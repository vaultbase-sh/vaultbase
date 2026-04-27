import Elysia from "elysia";
import * as jose from "jose";
import type { Config } from "./config.ts";
import { setLogsDir } from "./core/file-logger.ts";
import { makeAuthPlugin } from "./api/auth.ts";
import { makeCollectionsPlugin } from "./api/collections.ts";
import { makeRecordsPlugin } from "./api/records.ts";
import { makeFilesPlugin } from "./api/files.ts";
import { makeAdminPlugin } from "./admin/index.ts";
import { makeLogsPlugin } from "./api/logs.ts";
import { makeAdminsPlugin } from "./api/admins.ts";
import { makeAuthUsersPlugin } from "./api/auth-users.ts";
import { makeBackupPlugin } from "./api/backup.ts";
import { makeRateLimitPlugin } from "./api/ratelimit.ts";
import { makeIndexesPlugin } from "./api/indexes.ts";
import { makeSettingsPlugin } from "./api/settings.ts";
import { makeHooksPlugin } from "./api/hooks.ts";
import { makeRoutesPlugin, tryDispatchCustom } from "./api/routes.ts";
import { makeJobsPlugin } from "./api/jobs.ts";
import { makeBatchPlugin } from "./api/batch.ts";
import { makeCsvPlugin } from "./api/csv.ts";
import { makeMigrationsPlugin } from "./api/migrations.ts";
import { startScheduler } from "./core/jobs.ts";
import { setWSAuth, subscribe, unsubscribe, disconnectAll, type WSAuth } from "./realtime/manager.ts";

interface ClientMessage {
  type: "subscribe" | "unsubscribe" | "auth";
  /** Preferred field name. */
  topics?: string[];
  /** Backwards-compat alias for topics. */
  collections?: string[];
  /** When type === "auth": the bearer token to attach to this connection. */
  token?: string;
}

async function verifyTokenForWS(token: string, jwtSecret: string): Promise<WSAuth | null> {
  try {
    const { payload } = await jose.jwtVerify(
      token,
      new TextEncoder().encode(jwtSecret),
    );
    const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
    if (aud !== "user" && aud !== "admin") return null;
    const ctx: WSAuth = {
      id: String(payload["id"] ?? ""),
      type: aud as "user" | "admin",
    };
    if (typeof payload["email"] === "string") ctx.email = payload["email"];
    return ctx;
  } catch {
    return null;
  }
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
    .use(makeAuthUsersPlugin(config.jwtSecret))
    .use(makeBackupPlugin(config.jwtSecret, config.dbPath))
    .use(makeIndexesPlugin(config.jwtSecret))
    .use(makeSettingsPlugin(config.jwtSecret))
    .use(makeHooksPlugin(config.jwtSecret))
    .use(makeRoutesPlugin(config.jwtSecret))
    .use(makeJobsPlugin(config.jwtSecret))
    .use(makeBatchPlugin(config.jwtSecret))
    .use(makeCsvPlugin(config.jwtSecret))
    .use(makeMigrationsPlugin(config.jwtSecret))
    .use(makeCollectionsPlugin(config.jwtSecret))
    .use(makeFilesPlugin(config.uploadDir, config.jwtSecret))
    .use(makeAdminPlugin())
    .get("/api/health", () => ({ data: { status: "ok" } }))
    .use(makeRecordsPlugin(config.jwtSecret))
    .ws("/realtime", {
      async open(ws) {
        // Optional auth via ?token=<jwt> on the upgrade URL. The Bun WS object
        // exposes the original Request via `data.request` on Elysia.
        const req = (ws.data as { request?: Request } | undefined)?.request;
        if (req) {
          const url = new URL(req.url);
          const token = url.searchParams.get("token");
          if (token) {
            const auth = await verifyTokenForWS(token, config.jwtSecret);
            if (auth) setWSAuth(ws, auth);
          }
        }
        ws.send(JSON.stringify({ type: "connected" }));
      },
      async message(ws, message) {
        let msg: ClientMessage;
        try {
          msg = (typeof message === "string" ? JSON.parse(message) : message) as ClientMessage;
        } catch {
          return;
        }
        // Auth ad-hoc — lets clients refresh credentials over an open connection.
        if (msg.type === "auth") {
          if (typeof msg.token !== "string") return;
          const auth = await verifyTokenForWS(msg.token, config.jwtSecret);
          setWSAuth(ws, auth);
          return;
        }
        const topics = msg.topics ?? msg.collections;
        if (!Array.isArray(topics)) return;
        if (msg.type === "subscribe") subscribe(ws, topics);
        else if (msg.type === "unsubscribe") unsubscribe(ws, topics);
      },
      close(ws) {
        disconnectAll(ws);
      },
    });
}
