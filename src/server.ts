import Elysia, { t } from "elysia";
import type { Config } from "./config.ts";
import { securityHeaders, verifyAuthToken } from "./core/sec.ts";
import { getAllSettings } from "./api/settings.ts";
import { setLogsDir } from "./core/file-logger.ts";
import { setUploadDir } from "./core/storage.ts";
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
import { makeQueuesPlugin } from "./api/queues.ts";
import { makeBatchPlugin } from "./api/batch.ts";
import { makeCsvPlugin } from "./api/csv.ts";
import { makeMigrationsPlugin } from "./api/migrations.ts";
import { makeMetricsPlugin } from "./api/metrics.ts";
import { startScheduler } from "./core/jobs.ts";
import { startQueueScheduler } from "./core/queues.ts";
import { RequestTimer, attachTimer, detachTimer } from "./core/perf-metrics.ts";
import {
  setWSAuth,
  subscribe,
  unsubscribe,
  disconnectAll,
  getSSEClient,
  setSSESubscriptions,
  unregisterSSEClient,
  type WSAuth,
} from "./realtime/manager.ts";
import { openSSEStream } from "./realtime/sse.ts";

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
  const ctx = await verifyAuthToken(token, jwtSecret);
  if (!ctx) return null;
  if (ctx.type !== "user" && ctx.type !== "admin") return null;
  const out: WSAuth = { id: ctx.id, type: ctx.type };
  if (ctx.email) out.email = ctx.email;
  return out;
}

/**
 * True if `origin` is in the configured allowlist. Empty/missing settings →
 * deny cross-origin (WS upgrades from any non-same-origin caller fail).
 * Comma-separated list under `security.allowed_origins`.
 */
function isOriginAllowed(origin: string | null): boolean {
  if (!origin) return true; // same-origin requests omit Origin in some clients
  const settings = getAllSettings();
  const raw = settings["security.allowed_origins"] ?? "";
  if (!raw) return false;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) || list.includes("*");
}

export function createServer(config: Config) {
  setLogsDir(config.logsDir);
  setUploadDir(config.uploadDir);
  startScheduler();
  startQueueScheduler();
  return new Elysia()
    // Phase 0: register a per-request timer. WeakMap-keyed by Request, so
    // any handler / records-core call site can record steps via `timeFor`.
    .onRequest(({ request }) => {
      attachTimer(request, new RequestTimer());
    })
    // Attach security headers globally. CSP applies to non-API surface.
    .onAfterHandle(({ request, set }) => {
      const isApi = new URL(request.url).pathname.startsWith("/api/");
      const headers = securityHeaders({ isApi });
      for (const [k, v] of Object.entries(headers)) {
        if (!set.headers[k]) set.headers[k] = v;
      }

      // ⚠ In-process gzip was removed in the perf sprint Phase 1. It blocked
      // the event loop on `Bun.gzipSync`, regressed RPS by ~14% under load,
      // and doubled p99.9. Production deployments terminate compression at
      // the reverse proxy layer (nginx / Caddy / Cloudflare) — see README.md
      // "Production deployment".

      // Roll the request's per-step timings into the global histograms.
      const t = detachTimer(request);
      if (t) t.finish();
    })
    .onError(({ request }) => {
      // Make sure we don't leak timers on error paths.
      const t = detachTimer(request);
      if (t) t.finish();
    })
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
    .use(makeQueuesPlugin(config.jwtSecret))
    .use(makeBatchPlugin(config.jwtSecret))
    .use(makeCsvPlugin(config.jwtSecret))
    .use(makeMigrationsPlugin(config.jwtSecret))
    .use(makeMetricsPlugin(config.jwtSecret))
    .use(makeCollectionsPlugin(config.jwtSecret))
    .use(makeFilesPlugin(config.uploadDir, config.jwtSecret))
    .use(makeAdminPlugin())
    .get("/api/health", () => ({ data: { status: "ok" } }))
    // Cluster health probe — admin proxies / load-balancers hit this. Worker
    // id (if running under cluster mode) helps debug which worker answered.
    .get("/_/health", () => ({
      data: {
        status: "ok",
        worker_id: process.env["VAULTBASE_WORKER_ID"] ?? null,
        pid: process.pid,
        uptime_s: Math.floor(process.uptime()),
      },
    }))
    // SSE fallback for clients that can't open WebSockets. Pairs with
    // `POST /api/realtime` (below) for setting subscriptions.
    .get("/api/realtime", ({ request, set }) => {
      const origin = request.headers.get("origin");
      if (!isOriginAllowed(origin)) {
        set.status = 403;
        return { error: "Origin not allowed", code: 403 };
      }
      const { response } = openSSEStream();
      set.headers["content-type"] = "text/event-stream; charset=utf-8";
      return response;
    })
    .post(
      "/api/realtime",
      async ({ body, set }) => {
        const adapter = getSSEClient(body.clientId);
        if (!adapter) { set.status = 404; return { error: "Unknown clientId — open GET /api/realtime first", code: 404 }; }
        // Optional fresh auth (parallel to WS `{type:"auth"}`).
        if (body.token) {
          const auth = await verifyTokenForWS(body.token, config.jwtSecret);
          setWSAuth(adapter, auth);
        }
        const topics = body.topics ?? body.subscriptions ?? body.collections ?? [];
        setSSESubscriptions(body.clientId, topics);
        return { data: { clientId: body.clientId, topics } };
      },
      {
        body: t.Object({
          clientId: t.String(),
          topics: t.Optional(t.Array(t.String())),
          subscriptions: t.Optional(t.Array(t.String())),  // PB-compat alias
          collections: t.Optional(t.Array(t.String())),    // legacy alias
          token: t.Optional(t.String()),
        }),
      }
    )
    .delete("/api/realtime/:clientId", ({ params }) => {
      unregisterSSEClient(params.clientId);
      return { data: null };
    })
    .use(makeRecordsPlugin(config.jwtSecret))
    .ws("/realtime", {
      async open(ws) {
        const req = (ws.data as { request?: Request } | undefined)?.request;
        if (req) {
          const origin = req.headers.get("origin");
          if (!isOriginAllowed(origin)) {
            ws.send(JSON.stringify({ type: "error", reason: "origin_not_allowed" }));
            ws.close();
            return;
          }
        }
        // Auth via {type:"auth", token} message. Tokens in the URL query are
        // no longer accepted (logs/Referer leak risk).
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
