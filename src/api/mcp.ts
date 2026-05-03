/**
 * HTTP + Server-Sent-Events transport for the MCP server.
 *
 *   POST /api/v1/mcp           — JSON-RPC request → response (or 204 for
 *                                 notifications)
 *   GET  /api/v1/mcp/events    — SSE stream of server → client messages
 *                                 (notifications, listChanged hints, …)
 *
 * Both endpoints accept the same `Authorization: Bearer vbat_…` API token
 * as the rest of the admin surface. The token must carry at least one
 * `mcp:*` scope; per-tool scope checks happen inside the registry.
 *
 * Session model: stateless. Each POST is an independent JSON-RPC turn;
 * the SSE leg is purely for server-initiated traffic. A client wanting
 * to drive the server in lockstep with stdio just opens both legs at
 * once — see `@vaultbase/mcp` for a stdio↔HTTP bridge that does this.
 */

import Elysia from "elysia";
import { verifyAuthToken, extractBearer } from "../core/sec.ts";
import { hasScope } from "../core/api-tokens.ts";
import { buildRegistry, createDispatcher } from "../mcp/server.ts";
import { RPC_ERR, type JsonRpcRequest, type JsonRpcResponse } from "../mcp/types.ts";
import type { ToolContext } from "../mcp/tools.ts";
import {
  registerMcpEventClient,
  unregisterMcpEventClient,
  type McpEventClient,
} from "../mcp/events.ts";

const MCP_SCOPES = ["mcp:read", "mcp:write", "mcp:admin", "mcp:sql", "admin"] as const;

interface AuthOk {
  ctx: ToolContext;
}
interface AuthFail {
  status: 401 | 403;
  body: { error: string; code: number };
}

async function authenticate(request: Request, jwtSecret: string): Promise<AuthOk | AuthFail> {
  const token = extractBearer(request);
  if (!token) {
    return { status: 401, body: { error: "Missing bearer token", code: 401 } };
  }
  const verified = await verifyAuthToken(token, jwtSecret, { audience: "api" });
  if (!verified) {
    return { status: 401, body: { error: "Invalid or revoked token", code: 401 } };
  }
  const scopes = verified.scopes ?? [];
  const hasAnyMcp = MCP_SCOPES.some((s) => hasScope(scopes, s));
  if (!hasAnyMcp) {
    return {
      status: 403,
      body: { error: "Token missing mcp:* scope", code: 403 },
    };
  }
  const ctx: ToolContext = {
    tokenId: verified.jti ?? "",
    tokenName: verified.tokenName ?? "(unnamed)",
    scopes,
    adminId: verified.id,
    adminEmail: verified.email ?? "",
  };
  return { ctx };
}

const encoder = new TextEncoder();
const HEARTBEAT_MS = 30_000;

function sseFormat(eventType: string | null, data: string): Uint8Array {
  const lines: string[] = [];
  if (eventType) lines.push(`event: ${eventType}`);
  for (const line of data.split("\n")) lines.push(`data: ${line}`);
  lines.push("", "");
  return encoder.encode(lines.join("\n"));
}

function isJsonRpcRequest(v: unknown): v is JsonRpcRequest {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return o.jsonrpc === "2.0" && typeof o.method === "string";
}

export function makeMcpPlugin(jwtSecret: string) {
  return new Elysia({ name: "mcp-http" })
    .post("/mcp", async ({ request, set, body }) => {
      const auth = await authenticate(request, jwtSecret);
      if ("status" in auth) {
        set.status = auth.status;
        return auth.body;
      }
      if (!isJsonRpcRequest(body)) {
        set.status = 400;
        const err: JsonRpcResponse = {
          jsonrpc: "2.0",
          id: null,
          error: { code: RPC_ERR.InvalidRequest, message: "Not a JSON-RPC 2.0 request" },
        };
        return err;
      }

      // Build a fresh registry per request — collections may have changed
      // since the last request (a previous tools/call could have minted a
      // new collection). This is cheap; the per-collection tool synthesis
      // walks the metadata table only.
      const reg = await buildRegistry(false);
      const dispatcher = createDispatcher(reg, auth.ctx);
      const res = await dispatcher.handle(body);
      if (res === null) {
        set.status = 204;
        return null;
      }
      return res;
    })
    .get("/mcp/events", ({ request, set }) => {
      // Auth gate: SSE handlers can't easily return JSON, so we return a
      // small text body with the right status. EventSource clients surface
      // this as `onerror` with the status; that's the Right Thing™.
      // Note: returning a Promise<Response> straight from the handler.
      return (async (): Promise<Response> => {
        const auth = await authenticate(request, jwtSecret);
        if ("status" in auth) {
          return new Response(JSON.stringify(auth.body), {
            status: auth.status,
            headers: { "content-type": "application/json" },
          });
        }

        let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
        let heartbeat: ReturnType<typeof setInterval> | null = null;
        let closed = false;
        let clientId = "";

        const cleanup = (): void => {
          if (closed) return;
          closed = true;
          if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
          if (clientId) unregisterMcpEventClient(clientId);
          try { controller?.close(); } catch { /* already closed */ }
          controller = null;
        };

        const ip =
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          request.headers.get("x-real-ip") ??
          null;
        const ua = request.headers.get("user-agent");

        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
            const adapter: McpEventClient = {
              tokenId: auth.ctx.tokenId,
              tokenName: auth.ctx.tokenName,
              scopes: auth.ctx.scopes,
              adminId: auth.ctx.adminId,
              adminEmail: auth.ctx.adminEmail,
              ...(ip ? { ip } : {}),
              ...(ua ? { userAgent: ua } : {}),
              connectedAt: Math.floor(Date.now() / 1000),
              send(payload) {
                if (closed || !controller) return;
                try {
                  controller.enqueue(sseFormat("message", payload));
                } catch {
                  cleanup();
                }
              },
            };
            clientId = registerMcpEventClient(adapter);

            // Greeting — clients can use this to confirm the channel is up.
            const greeting = JSON.stringify({
              jsonrpc: "2.0",
              method: "vaultbase/connected",
              params: { tokenName: auth.ctx.tokenName, scopes: auth.ctx.scopes },
            });
            c.enqueue(sseFormat("message", greeting));

            heartbeat = setInterval(() => {
              if (closed || !controller) return;
              try { controller.enqueue(encoder.encode(`: ping\n\n`)); }
              catch { cleanup(); }
            }, HEARTBEAT_MS);
          },
          cancel() { cleanup(); },
        });

        request.signal?.addEventListener("abort", cleanup);

        set.headers["content-type"] = "text/event-stream; charset=utf-8";
        set.headers["cache-control"] = "no-cache";
        set.headers["connection"] = "keep-alive";
        return new Response(stream, { status: 200 });
      })();
    });
}
