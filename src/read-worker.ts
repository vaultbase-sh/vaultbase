/**
 * Read worker thread entry (see core/read-pool.ts). Step 1: answers every
 * forwarded request with a fixed echo so the forwarding path can be
 * measured; step 2 boots the app and serves list / get-one for real.
 */
import type { ForwardRequest, ForwardReply } from "./core/read-pool.ts";

interface WorkerScope {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  close(): void;
}
const scope = globalThis as unknown as WorkerScope;

type Incoming = { type: "start" } | { type: "stop" } | ForwardRequest;

const WORKER_ID = process.env["VAULTBASE_READ_WORKER"] ?? "";
const ECHO = new TextEncoder().encode(JSON.stringify({ data: [], echo: true, worker: WORKER_ID }));

scope.onmessage = (e: MessageEvent) => {
  const m = e.data as Incoming;
  if (m.type === "start") {
    scope.postMessage({ type: "ready" });
    return;
  }
  if (m.type === "stop") {
    scope.close();
    return;
  }
  if (m.type === "request") {
    const body = ECHO.slice().buffer;
    const reply: ForwardReply = {
      type: "reply",
      id: m.id,
      status: 200,
      headers: [["content-type", "application/json"], ["x-vaultbase-read-worker", WORKER_ID]],
      body,
    };
    scope.postMessage(reply, [body]);
  }
};
