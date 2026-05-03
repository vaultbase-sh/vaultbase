/**
 * MCP / JSON-RPC 2.0 message shapes.
 *
 * Subset of the Model Context Protocol spec at modelcontextprotocol.io
 * sufficient for vaultbase's Phase-1 surface: initialize, tools/list,
 * tools/call. Resources, prompts, sampling, and notifications-from-server
 * land in Phase 3.
 */

// ── JSON-RPC 2.0 ─────────────────────────────────────────────────────────

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;       // omitted for notifications
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

/** Standard JSON-RPC error codes. */
export const RPC_ERR = {
  ParseError:     -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams:  -32602,
  InternalError:  -32603,
} as const;

// ── MCP-specific shapes ──────────────────────────────────────────────────

/** What we tell the client we support during the initialize handshake. */
export interface ServerCapabilities {
  tools?: {
    listChanged?: boolean;
  };
  resources?: {
    listChanged?: boolean;
    subscribe?: boolean;
  };
  prompts?: {
    listChanged?: boolean;
  };
  logging?: Record<string, never>;
}

export interface InitializeResult {
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: {
    name: string;
    version: string;
  };
  instructions?: string;
}

/** A tool exposed to the client. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface ListToolsResult {
  tools: ToolDefinition[];
  nextCursor?: string;
}

/** Per-block content the spec lets a tool return. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };

export interface CallToolResult {
  content: ContentBlock[];
  isError?: boolean;
}

export interface CallToolParams {
  name: string;
  arguments?: Record<string, unknown>;
}

/** Protocol version we declare. Aligns with MCP's stable revision. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
