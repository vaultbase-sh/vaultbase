/**
 * MCP Resources — read-only, URI-addressable blobs.
 *
 * The MCP spec lets a server expose "Resources" the LLM can read without
 * burning a tool call. Resources are passive context — they don't take
 * arguments beyond the URI itself. Vaultbase exposes a small starter set:
 *
 *   Static URIs (resources/list):
 *     vaultbase://collections          schema enumeration (no PII)
 *     vaultbase://audit/recent         last 50 audit entries
 *     vaultbase://settings             non-secret settings keys
 *     vaultbase://server/info          version + protocol metadata
 *
 *   Templates (resources/templates/list):
 *     vaultbase://collection/{name}        full schema for one collection
 *     vaultbase://record/{collection}/{id} one record (collection rules
 *                                          enforced via the minting admin)
 *     vaultbase://logs/{date}              JSONL request logs for one day
 *
 * Read-side scope: the LLM token must carry `mcp:read`. Settings / audit
 * resources are admin-equivalent visibility — same surface as the
 * read_audit_log / list_settings tools.
 */

import { VAULTBASE_VERSION } from "../core/version.ts";
import { listCollections, getCollection, parseFields } from "../core/collections.ts";
import { listAuditEntries } from "../core/audit-log.ts";
import { readLogs } from "../core/file-logger.ts";
import { getAllSettings, shouldEncryptSettingKey } from "../api/settings.ts";
import { getRecord } from "../core/records.ts";
import { hasScope } from "../core/api-tokens.ts";
import { MCP_PROTOCOL_VERSION } from "./types.ts";
import type { ToolContext } from "./tools.ts";

export interface Resource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

const STATIC_RESOURCES: Resource[] = [
  {
    uri: "vaultbase://collections",
    name: "Collections list",
    description: "All collections in this deployment with type + history flag.",
    mimeType: "application/json",
  },
  {
    uri: "vaultbase://audit/recent",
    name: "Recent audit log",
    description: "Last 50 audit entries (admin actions).",
    mimeType: "application/json",
  },
  {
    uri: "vaultbase://settings",
    name: "Settings",
    description: "Non-secret runtime settings. Encrypted keys are masked.",
    mimeType: "application/json",
  },
  {
    uri: "vaultbase://server/info",
    name: "Server info",
    description: "Vaultbase version, MCP protocol version, capability summary.",
    mimeType: "application/json",
  },
];

const TEMPLATES: ResourceTemplate[] = [
  {
    uriTemplate: "vaultbase://collection/{name}",
    name: "Single collection schema",
    description: "Full schema (fields + rules) for one collection.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "vaultbase://record/{collection}/{id}",
    name: "Single record",
    description: "One record by id; collection rules apply.",
    mimeType: "application/json",
  },
  {
    uriTemplate: "vaultbase://logs/{date}",
    name: "Daily request logs",
    description: "Structured JSONL logs for YYYY-MM-DD.",
    mimeType: "application/json",
  },
];

export function listResources(): Resource[] {
  return [...STATIC_RESOURCES];
}

export function listResourceTemplates(): ResourceTemplate[] {
  return [...TEMPLATES];
}

/**
 * Read a resource by URI. Throws on unknown URIs / malformed templates so
 * the dispatcher can map to JSON-RPC InvalidParams.
 */
export async function readResource(uri: string, ctx: ToolContext): Promise<ResourceContents> {
  if (!hasScope(ctx.scopes, "mcp:read")) {
    throw new Error("Reading resources requires the mcp:read scope.");
  }

  switch (uri) {
    case "vaultbase://collections":
      return jsonContents(uri, await readCollectionsList());
    case "vaultbase://audit/recent":
      return jsonContents(uri, await readRecentAudit());
    case "vaultbase://settings":
      return jsonContents(uri, readSettingsResource());
    case "vaultbase://server/info":
      return jsonContents(uri, readServerInfo());
  }

  // Templated URIs ─ match longest-prefix-first to avoid ambiguity.
  if (uri.startsWith("vaultbase://collection/")) {
    const name = uri.slice("vaultbase://collection/".length);
    if (!name) throw new Error("Missing collection name in URI");
    return jsonContents(uri, await readCollectionSchema(name));
  }

  if (uri.startsWith("vaultbase://record/")) {
    const rest = uri.slice("vaultbase://record/".length);
    const slash = rest.indexOf("/");
    if (slash < 1 || slash === rest.length - 1) {
      throw new Error("Record URI must be vaultbase://record/{collection}/{id}");
    }
    const collection = rest.slice(0, slash);
    const id = rest.slice(slash + 1);
    return jsonContents(uri, await readSingleRecord(collection, id, ctx));
  }

  if (uri.startsWith("vaultbase://logs/")) {
    const date = uri.slice("vaultbase://logs/".length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error("Logs URI date must be YYYY-MM-DD");
    }
    return jsonContents(uri, await readLogs({ from: date, to: date, limit: 1000 }));
  }

  throw new Error(`Unknown resource URI: ${uri}`);
}

// ── reader implementations ───────────────────────────────────────────────

function jsonContents(uri: string, value: unknown): ResourceContents {
  return {
    uri,
    mimeType: "application/json",
    text: JSON.stringify(value, null, 2),
  };
}

async function readCollectionsList(): Promise<unknown> {
  const cols = await listCollections();
  return cols.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type,
    history_enabled: c.history_enabled === 1,
    created_at: c.created_at,
    updated_at: c.updated_at,
  }));
}

async function readCollectionSchema(name: string): Promise<unknown> {
  const col = await getCollection(name);
  if (!col) throw new Error(`Collection '${name}' not found`);
  return {
    id: col.id,
    name: col.name,
    type: col.type,
    history_enabled: col.history_enabled === 1,
    view_query: col.view_query,
    list_rule:   col.list_rule,
    view_rule:   col.view_rule,
    create_rule: col.create_rule,
    update_rule: col.update_rule,
    delete_rule: col.delete_rule,
    fields: parseFields(col.fields),
  };
}

async function readSingleRecord(collection: string, id: string, _ctx: ToolContext): Promise<unknown> {
  const col = await getCollection(collection);
  if (!col) throw new Error(`Collection '${collection}' not found`);
  // Auth principal is implicit — same as the auto-tool path; the minting
  // admin's identity is what core/records.ts sees.
  const rec = await getRecord(collection, id);
  if (!rec) throw new Error(`Record '${id}' not found in '${collection}'`);
  return rec;
}

async function readRecentAudit(): Promise<unknown> {
  return await listAuditEntries({ perPage: 50 });
}

function readSettingsResource(): unknown {
  const all = getAllSettings();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    out[k] = shouldEncryptSettingKey(k) ? "<redacted>" : v;
  }
  return out;
}

function readServerInfo(): unknown {
  return {
    name: "vaultbase",
    version: VAULTBASE_VERSION,
    protocol: MCP_PROTOCOL_VERSION,
    capabilities: ["tools", "resources", "prompts"],
  };
}

