import { registerSSEClient, unregisterSSEClient, type WSLike } from "./manager.ts";

/**
 * Server-Sent Events fallback for clients that can't use WebSockets (locked-down
 * proxies, some browser environments, etc.). Mirrors the topic-based fan-out
 * logic of the WebSocket endpoint by wrapping a `ReadableStream` controller in
 * the same `WSLike` interface the manager already speaks.
 *
 * Pairs with `POST /api/v1/realtime` to set the per-client topic list — see
 * `setSSESubscriptions` in `manager.ts`.
 */

const HEARTBEAT_MS = 30_000;
const encoder = new TextEncoder();

function formatEvent(eventType: string | null, data: string): Uint8Array {
  const lines: string[] = [];
  if (eventType) lines.push(`event: ${eventType}`);
  // Split data on newlines per the SSE spec (each line gets its own "data:" prefix).
  for (const line of data.split("\n")) lines.push(`data: ${line}`);
  lines.push("", ""); // trailing blank line dispatches the event
  return encoder.encode(lines.join("\n"));
}

interface SSEHandle {
  /** The Response to return from the route handler. */
  response: Response;
  /** Server-minted id the client uses to manage subscriptions over POST. */
  clientId: string;
}

/**
 * Open an SSE stream and register a client with the realtime manager.
 * Returns a Response whose body streams events until the client disconnects.
 */
export function openSSEStream(): SSEHandle {
  const clientId = crypto.randomUUID();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
    unregisterSSEClient(clientId);
    try { controller?.close(); } catch { /* already closed */ }
    controller = null;
  };

  const adapter: WSLike = {
    send(data: string) {
      if (closed || !controller) throw new Error("SSE stream closed");
      try {
        controller.enqueue(formatEvent("message", data));
      } catch (e) {
        // Client disconnected mid-write — manager will catch the throw and
        // evict us from the topic set on its next iteration.
        cleanup();
        throw e;
      }
    },
  };

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      registerSSEClient(clientId, adapter);

      // Initial frame carries the clientId so the caller can address it via
      // POST /api/v1/realtime { clientId, topics: [...] }.
      const greeting = JSON.stringify({ type: "connected", clientId });
      c.enqueue(formatEvent("connect", greeting));

      // Heartbeat keeps the connection alive through proxies / load balancers
      // that may otherwise idle-out a long-lived stream. SSE comments (lines
      // starting with `:`) are ignored by clients but produce traffic.
      heartbeat = setInterval(() => {
        if (closed || !controller) return;
        try { controller.enqueue(encoder.encode(`: ping\n\n`)); }
        catch { cleanup(); }
      }, HEARTBEAT_MS);
    },
    cancel() {
      cleanup();
    },
  });

  const response = new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no", // disable buffering on nginx-style proxies
    },
  });

  return { response, clientId };
}
