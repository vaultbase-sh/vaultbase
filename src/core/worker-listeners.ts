/**
 * Read workers that accept connections themselves (Linux).
 *
 * With a read pool running, every request used to arrive on the main
 * thread, which forwarded record reads to a worker and wrote the reply out:
 * past a few workers the main thread's share (HTTP parsing, socket writes,
 * the message hop) capped reads. Here each worker also listens on the
 * public port with `reusePort`, so the kernel spreads connections over the
 * main thread and the workers.
 *
 * A worker serves record reads (list, get-one) itself. Everything else it
 * receives (writes, auth, admin, files, SSE, realtime WebSockets, custom
 * routes) goes to the main thread over loopback: an internal listener
 * (`startInternalListener` in server.ts) that takes only requests carrying
 * this process's secret, with the client's socket peer in a header, so
 * client addresses, trusted proxies and per-client limits work as if the
 * main thread had accepted the connection.
 *
 * What stays on the main thread: the rate-limit buckets (a worker picks the
 * bucket and takes the token over a message, so there is one set), API-token
 * usage (posted), and everything that writes.
 *
 * Only on Linux by default: macOS and Windows accept `reusePort` but don't
 * spread connections, so one listener would take them all.
 * `VAULTBASE_WORKER_LISTENERS=0` turns it off, `=1` on.
 */
import type { Server } from "bun";
import { readTarget } from "./read-pool.ts";
import { customInnerPath } from "./api-paths.ts";
import { rateLimitCharge, rateLimitRefusal, rateLimitedResponse } from "../api/ratelimit.ts";
import { rememberPeer, trustedClientIp } from "./sec.ts";
import { verifyHs256 } from "./jwt-hs256.ts";
import { MetricsRegistry } from "./perf-metrics.ts";
import { MAX_WS_QUEUED_BYTES } from "../realtime/manager.ts";

/** Proves a request on the internal listener came from one of our workers. */
export const INTERNAL_HEADER = "x-vaultbase-internal";
/** The client's socket peer, for a request a worker passes on. */
export const PEER_HEADER = "x-vaultbase-peer";

/** Main → worker: start listening. */
export interface ListenMessage {
  type: "listen";
  port: number;
  hostname?: string;
  idleTimeout: number;
  internalPort: number;
  secret: string;
}

/** Worker → main: take a rate-limit token; answered with `rl-reply`. */
export interface TokenRequest { type: "rl"; id: number; key: string; max: number; windowMs: number }
export interface TokenReply { type: "rl-reply"; id: number; ok: boolean }
/** Worker → main: an API token was used. */
export interface UsageMessage { type: "usage"; jti: string; ip: string; ua: string | null }

/**
 * Whether read workers listen on the public port: `VAULTBASE_WORKER_LISTENERS`
 * when set (`0` off, anything else on), otherwise on Linux only.
 */
export function workerListenersEnabled(env: Record<string, string | undefined>, platform: string): boolean {
  const raw = env["VAULTBASE_WORKER_LISTENERS"]?.trim();
  if (raw) return raw !== "0";
  return platform === "linux";
}

/**
 * Requests a worker accepted itself, counted here and posted with its stats
 * (the ones the main thread forwards are counted there).
 */
export const directMetrics = new MetricsRegistry();

export interface WorkerListenerDeps {
  /** The worker's app (role "reader"). */
  app: { handle(request: Request): Promise<Response> };
  jwtSecret: string;
  workerId: string;
  /** Take a rate-limit token from the main thread's buckets. */
  takeToken(charge: { key: string; max: number; windowMs: number }): Promise<boolean>;
  /** Post a message to the main thread. */
  post(message: UsageMessage): void;
}

/** Headers a WebSocket client sets itself; the rest are passed on. */
const HANDSHAKE_HEADERS = new Set(["connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions", "content-length"]);

interface BridgeData {
  upstream: WebSocket;
  /** Frames from the main thread that arrived before the client's socket opened. */
  early: Array<string | ArrayBuffer | Uint8Array>;
}

/** Start this worker's public listener. */
export function listenOnWorker(spec: ListenMessage, deps: WorkerListenerDeps): Server<BridgeData> {
  const internal = `127.0.0.1:${spec.internalPort}`;

  const serveRead = async (request: Request, peer: string | null): Promise<Response> => {
    const started = performance.now();
    let status = 500;
    try {
      const charge = await rateLimitCharge(request, peer, deps.jwtSecret);
      if (charge && !(await deps.takeToken(charge))) {
        status = 429;
        return rateLimitedResponse(request, rateLimitRefusal(charge));
      }
      rememberPeer(request, peer);
      const res = await deps.app.handle(request);
      status = res.status;
      try { res.headers.set("x-vaultbase-read-worker", deps.workerId); } catch { /* immutable headers */ }
      return res;
    } finally {
      directMetrics.finalizeRequest((performance.now() - started) * 1000, request.method, status);
      recordUsage(request, peer);
    }
  };

  const recordUsage = (request: Request, peer: string | null): void => {
    const m = /^Bearer\s+vbat_([A-Za-z0-9._\-]+)/i.exec(request.headers.get("authorization") ?? "");
    if (!m) return;
    const payload = verifyHs256(m[1] ?? "", deps.jwtSecret, { issuer: "vaultbase", audience: "api" });
    if (!payload || typeof payload["jti"] !== "string") return;
    deps.post({ type: "usage", jti: payload["jti"], ip: trustedClientIp(request, peer), ua: request.headers.get("user-agent") });
  };

  const passOn = async (request: Request, url: URL, peer: string | null): Promise<Response> => {
    const headers = new Headers(request.headers);
    headers.set(INTERNAL_HEADER, spec.secret);
    headers.set(PEER_HEADER, peer ?? "");
    try {
      // `timeout: false`: an SSE stream may sit idle between events.
      return await fetch(`http://${internal}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "manual",
        decompress: false,
        timeout: false,
        signal: request.signal,
      } as RequestInit);
    } catch {
      return new Response(JSON.stringify({ error: "Server unavailable", code: 502 }), { status: 502, headers: { "content-type": "application/json" } });
    }
  };

  const bridge = async (request: Request, url: URL, server: Server<BridgeData>, peer: string | null): Promise<Response | undefined> => {
    const headers: Record<string, string> = { [INTERNAL_HEADER]: spec.secret, [PEER_HEADER]: peer ?? "" };
    request.headers.forEach((v, k) => { if (!HANDSHAKE_HEADERS.has(k)) headers[k] = v; });
    const upstream = new WebSocket(`ws://${internal}${url.pathname}${url.search}`, { headers } as unknown as string[]);
    upstream.binaryType = "arraybuffer";
    const data: BridgeData = { upstream, early: [] };
    upstream.onmessage = (e) => { data.early.push(e.data as string | ArrayBuffer); };
    // The main thread refuses a connection over the cap before the upgrade
    // (503); the client gets the same answer.
    const opened = await new Promise<boolean>((resolve) => {
      upstream.onopen = () => resolve(true);
      upstream.onerror = () => resolve(false);
      upstream.onclose = () => resolve(false);
    });
    if (!opened) {
      return new Response(JSON.stringify({ error: "Too many realtime connections; retry later", code: 503 }), {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "5" },
      });
    }
    if (server.upgrade(request, { data })) return undefined;
    upstream.close();
    return new Response("Upgrade failed", { status: 400 });
  };

  return Bun.serve<BridgeData>({
    port: spec.port,
    ...(spec.hostname ? { hostname: spec.hostname } : {}),
    reusePort: true,
    idleTimeout: spec.idleTimeout,
    async fetch(request, server) {
      const peer = server.requestIP(request)?.address ?? null;
      const url = new URL(request.url);
      if (customInnerPath(url.pathname) === null && readTarget(request.method, url.pathname)) return serveRead(request, peer);
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return bridge(request, url, server, peer);
      return passOn(request, url, peer);
    },
    // The main thread's realtime limits, so a slow client is cut off here
    // rather than buffered.
    websocket: {
      maxPayloadLength: 64 * 1024,
      backpressureLimit: MAX_WS_QUEUED_BYTES,
      closeOnBackpressureLimit: true,
      open(ws) {
        const { upstream, early } = ws.data;
        for (const m of early) ws.send(m);
        early.length = 0;
        upstream.onmessage = (e) => { ws.send(e.data as string | ArrayBuffer); };
        upstream.onclose = (e) => { ws.close(e.code === 1005 || e.code === 1006 ? 1000 : e.code, e.reason); };
        upstream.onerror = () => { ws.close(1011); };
        if (upstream.readyState !== WebSocket.OPEN) ws.close(1011);
      },
      message(ws, message) {
        if (ws.data.upstream.readyState === WebSocket.OPEN) ws.data.upstream.send(message);
      },
      close(ws) {
        ws.data.upstream.close();
      },
    },
  });
}
