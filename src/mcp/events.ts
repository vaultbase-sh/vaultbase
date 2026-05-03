/**
 * MCP server-initiated event fan-out.
 *
 * Each open SSE connection registers an `McpEventClient`. The server
 * pushes JSON-RPC notifications (e.g. `notifications/tools/listChanged`
 * after a `create_collection` call) by calling `broadcastMcpEvent` —
 * every registered client receives the same payload.
 *
 * Connection lifetime is owned by the HTTP plugin in `api/mcp.ts`; this
 * module is a passive fan-out registry with O(1) register/unregister
 * and O(N) broadcast.
 */

export interface McpEventClient {
  /** Token id (jti) — used for targeted disconnect on revoke. */
  tokenId: string;
  /** Display name of the token (admin-supplied at mint time). */
  tokenName: string;
  /** Scopes the connection was authenticated with. */
  scopes: readonly string[];
  /** Acting admin id (for audit cross-reference). */
  adminId: string;
  /** Acting admin email at connect time. */
  adminEmail: string;
  /** Optional client IP. */
  ip?: string;
  /** Optional User-Agent. */
  userAgent?: string;
  /** Unix-seconds when the SSE leg opened. */
  connectedAt: number;
  /** Send a JSON-RPC payload to this client (already JSON-stringified). */
  send(payload: string): void;
}

const clients = new Map<string, McpEventClient>();

/** Register a client, return the bookkeeping id used for unregister. */
export function registerMcpEventClient(client: McpEventClient): string {
  const id = crypto.randomUUID();
  clients.set(id, client);
  return id;
}

/** Read-only snapshot for the admin endpoint. */
export interface McpEventClientSnapshot {
  id: string;
  tokenId: string;
  tokenName: string;
  scopes: readonly string[];
  adminId: string;
  adminEmail: string;
  ip: string | null;
  userAgent: string | null;
  connectedAt: number;
}

export function listMcpEventClients(): McpEventClientSnapshot[] {
  const out: McpEventClientSnapshot[] = [];
  for (const [id, c] of clients.entries()) {
    out.push({
      id,
      tokenId: c.tokenId,
      tokenName: c.tokenName,
      scopes: c.scopes,
      adminId: c.adminId,
      adminEmail: c.adminEmail,
      ip: c.ip ?? null,
      userAgent: c.userAgent ?? null,
      connectedAt: c.connectedAt,
    });
  }
  out.sort((a, b) => b.connectedAt - a.connectedAt);
  return out;
}

export function unregisterMcpEventClient(id: string): void {
  clients.delete(id);
}

/** Best-effort broadcast — failures are swallowed (the SSE handler cleans up). */
export function broadcastMcpEvent(payload: unknown): void {
  const text = JSON.stringify(payload);
  for (const c of clients.values()) {
    try { c.send(text); } catch { /* handler cleans up */ }
  }
}

/** Number of currently connected clients — for tests + admin metrics. */
export function mcpEventClientCount(): number {
  return clients.size;
}

/** Disconnect every client whose token jti matches. Called on token revoke. */
export function disconnectMcpClientsByToken(tokenId: string): void {
  for (const [id, c] of clients.entries()) {
    if (c.tokenId === tokenId) clients.delete(id);
  }
}
