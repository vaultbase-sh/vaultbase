import Elysia, { t } from "elysia";
import type { Config } from "./config.ts";
import * as jose from "jose";
import { dataPrincipal, extractBearer, rememberPeer, perClientLimitIp, securityHeaders, trustedClientIp, verifyAuthToken } from "./core/sec.ts";
import { getAllSettings } from "./api/settings.ts";
import { setLogsDir } from "./core/file-logger.ts";
import { applyCorsHeaders, handleCorsPreflight } from "./core/cors.ts";
import { setUploadDir } from "./core/storage.ts";
import { setSandboxDir, pruneStaleSandboxes } from "./core/sql-sandbox.ts";
import { makeAuthPlugin } from "./api/auth.ts";
import { makeCollectionsPlugin } from "./api/collections.ts";
import { makeRecordsPlugin } from "./api/records.ts";
import { makeFilesPlugin, pruneFileTokenUses } from "./api/files.ts";
import { makeAdminPlugin } from "./admin/index.ts";
import { makeAuthPagesPlugin } from "./admin/auth-pages.ts";
import { makeLogsPlugin } from "./api/logs.ts";
import { makeAdminsPlugin } from "./api/admins.ts";
import { makeBackupPlugin } from "./api/backup.ts";
import { makeOpenApiPlugin } from "./api/openapi.ts";
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
import { makeAuditLogPlugin } from "./api/audit-log.ts";
import { makeApiTokensPlugin } from "./api/api-tokens.ts";
import { makeMcpPlugin } from "./api/mcp.ts";
import { makeMcpAdminPlugin } from "./api/mcp-admin.ts";
import { makeSqlPlugin } from "./api/sql.ts";
import { startApiTokenUsageFlusher, recordApiTokenUsage, pruneExpiredApiTokens } from "./core/api-tokens.ts";
import { pruneHistory } from "./core/maintenance.ts";
import { setBackupsDir, startBackupScheduler } from "./core/backups.ts";
import { startOrphanFileSweeper } from "./core/file-sweep.ts";
import { makeSecurityPlugin } from "./api/security.ts";
import { makeThemePlugin } from "./api/theme.ts";
import { makeFlagsPlugin } from "./api/flags.ts";
import { makeWebhooksPlugin } from "./api/webhooks.ts";
import { makeNotificationsPlugin } from "./api/notifications.ts";
import { startScheduler } from "./core/jobs.ts";
import { startQueueScheduler } from "./core/queues.ts";
import { startUpdateCheckScheduler, getUpdateStatus, runUpdateCheck } from "./core/update-check.ts";
import { startWebhookDispatcher } from "./core/webhooks.ts";
import { registerNotificationsWorker } from "./core/notifications.ts";
import { RequestTimer, attachTimer, detachTimer } from "./core/perf-metrics.ts";
import {
  admitConnection,
  reverifyRealtimeAuth,
  setSSEOwner,
  setWSAuth,
  sseOwnerOf,
  subscribe,
  unsubscribe,
  disconnectAll,
  listSubsFor,
  getSSEClient,
  setSSESubscriptions,
  unregisterSSEClient,
  type WSAuth,
} from "./realtime/manager.ts";
import { openSSEStream } from "./realtime/sse.ts";

interface ClientMessage {
  type: "subscribe" | "unsubscribe" | "auth" | "list-subs";
  /** Preferred field name. */
  topics?: string[];
  /** Backwards-compat alias for topics. */
  collections?: string[];
  /** When type === "auth": the bearer token to attach to this connection. */
  token?: string;
}

async function verifyTokenForWS(token: string, jwtSecret: string): Promise<WSAuth | null> {
  // Subscriptions only read; API tokens need the `read` (or `admin`) scope.
  const verified = await verifyAuthToken(token, jwtSecret);
  const p = dataPrincipal(verified, "read");
  if (!p) return null;
  // Keep the token and its expiry: the connection outlives the check, so
  // the manager drops auth at expiry and re-verifies the token on a timer.
  const out: WSAuth = { id: p.id, type: p.type, token };
  if (p.email) out.email = p.email;
  if (typeof verified?.exp === "number") out.exp = verified.exp;
  return out;
}

/** How often open realtime connections have their tokens re-verified. */
const REALTIME_REVERIFY_MS = 60_000;

/**
 * The caller may change an SSE client: once the client has authenticated,
 * only a token for that same principal will do (in the Authorization header
 * or the body). An unauthenticated client is managed by its clientId alone,
 * as before — there is nothing behind it to take over.
 */
async function mayManageSSEClient(clientId: string, request: Request, bodyToken: string | undefined, jwtSecret: string): Promise<boolean> {
  const owner = sseOwnerOf(clientId);
  if (!owner) return true;
  for (const token of [extractBearer(request), bodyToken]) {
    if (!token) continue;
    const auth = await verifyTokenForWS(token, jwtSecret);
    if (auth && `${auth.type}:${auth.id}` === owner) return true;
  }
  return false;
}

/**
 * True if `origin` is in the configured allowlist. Empty/missing settings →
 * deny cross-origin (WS upgrades from any non-same-origin caller fail).
 * Comma-separated list under `security.allowed_origins`.
 *
 * Null Origin → allowed. Browsers always send Origin on WS/EventSource, so
 * the allowlist is what stops cross-site use. A missing header means a
 * non-browser client (server-side SDK, scripts); those can send any Origin
 * they like, so requiring one blocks nothing but honest clients. They still
 * authenticate by token. Covered by realtime-origin.test.ts.
 */
function isOriginAllowed(origin: string | null, request?: Request): boolean {
  if (!origin) return true;
  // The page this server itself serves (the admin, the hosted auth pages, an
  // app served from the same host) is never cross-site.
  if (request) {
    try {
      if (new URL(origin).host === request.headers.get("host")) return true;
    } catch { /* malformed Origin: fall through to the list */ }
  }
  const settings = getAllSettings();
  const raw = settings["security.allowed_origins"] ?? "";
  if (!raw) return false;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) || list.includes("*");
}

/**
 * Prune `vaultbase_file_token_uses` rows older than 24h once per hour. Runs
 * once at boot (delayed) so a long-running process never accumulates more
 * than ~1 day of replay-guard state, which is itself capped by the file-token
 * window (default 1h) — so the table can't grow without bound.
 */
function startFileTokenUsesPrune(): void {
  const HOUR_MS = 60 * 60 * 1000;
  setTimeout(() => { void pruneFileTokenUses(); }, 60 * 1000).unref?.();
  setInterval(() => { void pruneFileTokenUses(); }, HOUR_MS).unref?.();
}

export function createServer(config: Config) {
  setLogsDir(config.logsDir);
  setUploadDir(config.uploadDir);
  setSandboxDir(`${config.dataDir}/sandboxes`);
  setBackupsDir(`${config.dataDir}/backups`);
  // Built-in `_notify` queue worker — must register BEFORE startQueueScheduler
  // so the first scheduler tick finds it. Idempotent on re-call (cluster
  // workers each call createServer).
  registerNotificationsWorker();
  startScheduler();
  startQueueScheduler();
  startUpdateCheckScheduler();
  startWebhookDispatcher();
  startFileTokenUsesPrune();
  setInterval(() => {
    void reverifyRealtimeAuth((token) => verifyTokenForWS(token, config.jwtSecret)).catch(() => { /* next tick */ });
  }, REALTIME_REVERIFY_MS).unref?.();
  startBackupScheduler();
  startOrphanFileSweeper();
  startApiTokenUsageFlusher();
  // Prune expired/long-revoked API token rows once a day.
  setTimeout(() => { void pruneExpiredApiTokens(); }, 5 * 60 * 1000).unref?.();
  setInterval(() => { void pruneExpiredApiTokens(); }, 24 * 60 * 60 * 1000).unref?.();
  // Finished jobs / webhook deliveries past retention, expired revocations
  // and one-time auth tokens (see core/maintenance.ts).
  setTimeout(() => { void pruneHistory().catch(() => { /* retried tomorrow */ }); }, 10 * 60 * 1000).unref?.();
  setInterval(() => { void pruneHistory().catch(() => { /* retried tomorrow */ }); }, 24 * 60 * 60 * 1000).unref?.();
  // Sweep idle SQL sandboxes hourly. They're per-admin, so a forgotten
  // tab snapshots the DB and never resets — the prune keeps disk usage
  // bounded.
  setInterval(() => { try { pruneStaleSandboxes(); } catch { /* swallow */ } }, 60 * 60 * 1000).unref?.();
  // Client realtime messages are small JSON commands; Bun closes a socket
  // sending anything larger (1009). This is server-wide websocket config —
  // a limit on the .ws() route is ignored.
  return new Elysia({ websocket: { maxPayloadLength: 64 * 1024 } })
    // Phase 0: register a per-request timer. WeakMap-keyed by Request, so
    // any handler / records-core call site can record steps via `timeFor`.
    .onRequest(({ request, server }) => {
      attachTimer(request, new RequestTimer());
      // Record the socket peer so every client-IP reader applies the
      // trusted-proxy rule (sec.ts clientIp) instead of trusting headers.
      rememberPeer(request, (server as { requestIP?: (r: Request) => { address: string } | null } | null)?.requestIP?.(request)?.address ?? null);
    })
    // CORS preflight short-circuit — must run before any normal route.
    .onRequest(({ request }) => {
      const res = handleCorsPreflight(request);
      if (res) return res;
    })
    // Attach security headers globally. CSP applies to non-API surface.
    .onAfterHandle(({ request, set }) => {
      const path = new URL(request.url).pathname;
      const isApi = path.startsWith("/api/");
      const headers = securityHeaders({ isApi });
      for (const [k, v] of Object.entries(headers)) {
        if (!set.headers[k]) set.headers[k] = v;
      }
      // Admin and auth responses carry secrets (settings, tokens, sessions):
      // never let a browser or shared proxy cache them. Record reads under
      // /api/v1/<collection> keep their ETag revalidation, so not all of /api.
      if (/^\/api\/(v1\/)?(admin|auth)\//.test(path) && !set.headers["cache-control"] && !set.headers["Cache-Control"]) {
        set.headers["Cache-Control"] = "no-store";
      }
      // CORS response headers on every request — same envelope as security.
      applyCorsHeaders(request, set as { headers: Record<string, string | undefined> });

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
    .use(makeRateLimitPlugin(config.jwtSecret))
    // ── API-token usage telemetry ────────────────────────────────────
    // Fires AFTER the handler so we don't add latency to the hot path.
    // Records last_used_at + IP + UA for any request that arrived
    // bearing a vbat_-prefixed token. Pure observability — failures
    // never block a request.
    .onAfterHandle({ as: "global" }, ({ request, server }) => {
      const auth = request.headers.get("authorization") ?? "";
      const m = /^Bearer\s+vbat_([A-Za-z0-9._\-]+)/i.exec(auth);
      if (!m) return;
      // Verify the signature before recording: an unsigned look at the jti
      // let a forged token overwrite a real token's last-used IP / UA.
      // Off the response path; failures are ignored.
      const jwt = m[1] ?? "";
      const peerIp = (server as { requestIP?: (r: Request) => { address: string } | null } | null)
        ?.requestIP?.(request)?.address ?? null;
      void jose.jwtVerify(jwt, new TextEncoder().encode(config.jwtSecret), { issuer: "vaultbase", audience: "api" })
        .then(({ payload }) => {
          if (typeof payload.jti !== "string") return;
          recordApiTokenUsage(payload.jti, trustedClientIp(request, peerIp), request.headers.get("user-agent"));
        })
        .catch(() => { /* invalid token — nothing to record */ });
    })
    // ── Versioned API surface ───────────────────────────────────────────
    // Every plugin route is declared without the `/api/...` prefix; the
    // group below adds `/api/v1`. Future v2 lives in a sibling group.
    .group("/api/v1", (app) => app
      .use(makeLogsPlugin(config.jwtSecret))
      .use(makeAuthPlugin(config.jwtSecret))
      .use(makeAdminsPlugin(config.jwtSecret))
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
      .use(makeAuditLogPlugin(config.jwtSecret))
      .use(makeApiTokensPlugin(config.jwtSecret))
      .use(makeMcpPlugin(config.jwtSecret))
      .use(makeMcpAdminPlugin(config.jwtSecret))
      .use(makeSqlPlugin(config.jwtSecret, config.dbPath))
      .use(makeSecurityPlugin(config.jwtSecret, config.encryptionKey))
      .use(makeThemePlugin())
      .use(makeFlagsPlugin(config.jwtSecret))
      .use(makeWebhooksPlugin(config.jwtSecret))
      .use(makeNotificationsPlugin(config.jwtSecret))
      .use(makeCollectionsPlugin(config.jwtSecret))
      .use(makeOpenApiPlugin(config.jwtSecret))
      .use(makeFilesPlugin(config.uploadDir, config.jwtSecret))
      .use(makeRecordsPlugin(config.jwtSecret))
    )
    .use(makeAdminPlugin())
    .use(makeAuthPagesPlugin())
    .get("/api/health", async () => {
      const { VAULTBASE_VERSION } = await import("./core/version.ts");
      return { data: { status: "ok", version: VAULTBASE_VERSION } };
    })
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
    // `POST /api/v1/realtime` for setting subscriptions.
    .get("/api/v1/realtime", ({ request, server, set }) => {
      const origin = request.headers.get("origin");
      // Browsers always send Origin, so a present Origin must be allow-listed
      // (blocks cross-site use). A missing Origin is a non-browser client
      // (server-side SDK, scripts): requiring one adds nothing since those
      // can send any value, and protected data still needs a token.
      if (!isOriginAllowed(origin, request)) {
        set.status = 403;
        return { error: "Origin not allowed", code: 403 };
      }
      const peer = (server as { requestIP?: (r: Request) => { address: string } | null } | null)?.requestIP?.(request)?.address ?? null;
      const sse = openSSEStream(perClientLimitIp(request, peer));
      if (!sse) { set.status = 503; return { error: "Too many realtime connections", code: 503 }; }
      set.headers["content-type"] = "text/event-stream; charset=utf-8";
      return sse.response;
    })
    .post(
      "/api/v1/realtime",
      async ({ body, request, set }) => {
        const adapter = getSSEClient(body.clientId);
        if (!adapter) { set.status = 404; return { error: "Unknown clientId — open GET /api/v1/realtime first", code: 404 }; }
        if (!(await mayManageSSEClient(body.clientId, request, body.token, config.jwtSecret))) {
          set.status = 403; return { error: "Forbidden", code: 403 };
        }
        // Optional fresh auth (parallel to WS `{type:"auth"}`).
        if (body.token) {
          const auth = await verifyTokenForWS(body.token, config.jwtSecret);
          setWSAuth(adapter, auth);
          if (auth) setSSEOwner(body.clientId, `${auth.type}:${auth.id}`);
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
    .delete("/api/v1/realtime/:clientId", async ({ params, request, set }) => {
      if (!(await mayManageSSEClient(params.clientId, request, undefined, config.jwtSecret))) {
        set.status = 403; return { error: "Forbidden", code: 403 };
      }
      unregisterSSEClient(params.clientId);
      return { data: null };
    })
    .ws("/realtime", {
      async open(ws) {
        const req = (ws.data as { request?: Request } | undefined)?.request;
        if (req) {
          const origin = req.headers.get("origin");
          // Same policy as SSE: present Origin must be allow-listed, missing
          // Origin (non-browser client) is allowed and authenticates by token.
          if (!isOriginAllowed(origin, req)) {
            ws.send(JSON.stringify({ type: "error", reason: "origin_not_allowed" }));
            ws.close();
            return;
          }
        }
        // Mint a stable per-connection id and stash it in Bun's persistent
        // `ws.data` slot. The realtime manager keys subscriptions by this
        // id, not by the `ws` object reference — Bun/Elysia hands different
        // wrappers to `open` vs `message`, so identity-based keying drops
        // unsubscribe + disconnectAll on the floor.
        const wsAny = ws as unknown as { data: { connId?: string } | undefined };
        const newId = crypto.randomUUID();
        if (!wsAny.data || typeof wsAny.data !== "object") {
          (wsAny as { data: object }).data = { connId: newId };
        } else {
          wsAny.data.connId = newId;
        }
        const peer = (ws as unknown as { remoteAddress?: string }).remoteAddress ?? null;
        if (!admitConnection(newId, perClientLimitIp(req ?? null, peer))) {
          ws.send(JSON.stringify({ type: "error", reason: "too_many_connections" }));
          ws.close();
          return;
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
        // Debug introspection: tell the client which topics THIS connection
        // is subscribed to. Useful when unsubscribe returns an empty array
        // and the client wants to confirm what's actually attached.
        if (msg.type === "list-subs") {
          ws.send(JSON.stringify({ type: "subs", topics: listSubsFor(ws) }));
          return;
        }
        const topics = msg.topics ?? msg.collections;
        if (!Array.isArray(topics)) {
          ws.send(JSON.stringify({ type: "error", code: "invalid_topics", message: "topics must be a string array" }));
          return;
        }
        if (msg.type === "subscribe") {
          const accepted = subscribe(ws, topics);
          ws.send(JSON.stringify({ type: "subscribed", topics: accepted }));
        } else if (msg.type === "unsubscribe") {
          const removed = unsubscribe(ws, topics);
          ws.send(JSON.stringify({ type: "unsubscribed", topics: removed }));
        }
      },
      close(ws) {
        disconnectAll(ws);
      },
    });
}
