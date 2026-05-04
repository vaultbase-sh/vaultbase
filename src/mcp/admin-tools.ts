/**
 * Generic admin MCP tools — collection-shape introspection, log + audit
 * surfaces. Phase-1 set; Phase-2 adds mutation tools (create_collection,
 * alter_collection, manage hooks etc.).
 *
 * v0.11 dropped `vaultbase.list_auth_users` — the auto-generated
 * `vaultbase.list_<auth-col>` per-collection tool covers it now.
 */
import { getCollection, listCollections, parseFields } from "../core/collections.ts";
import { listAuditEntries } from "../core/audit-log.ts";
import { readLogs } from "../core/file-logger.ts";
import { ToolRegistry, asJsonText, asUntrustedJsonText } from "./tools.ts";

export function registerAdminTools(reg: ToolRegistry): void {

  // ── list_collections ──────────────────────────────────────────────────
  reg.register({
    requiredScope: "mcp:read",
    definition: {
      name: "vaultbase.list_collections",
      description: "List every collection in this vaultbase deployment. Returns name, type (base / auth / view), creation timestamp, and whether record-history is on.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    handler: async () => {
      const cols = await listCollections();
      return asJsonText(cols.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        history_enabled: c.history_enabled === 1,
        created_at: c.created_at,
        updated_at: c.updated_at,
      })));
    },
  });

  // ── describe_collection ────────────────────────────────────────────────
  reg.register({
    requiredScope: "mcp:read",
    definition: {
      name: "vaultbase.describe_collection",
      description: "Return the full schema of a single collection — field definitions (name, type, options), and the four CRUD rules (list/view/create/update/delete). Use this before constructing create/update tool calls so the LLM can satisfy validation.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "Collection name" } },
        required: ["name"],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      if (typeof args.name !== "string") throw new Error("name (string) is required");
      const col = await getCollection(args.name);
      if (!col) throw new Error(`Collection '${args.name}' not found`);
      return asJsonText({
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
        created_at: col.created_at,
        updated_at: col.updated_at,
      });
    },
  });

  // ── read_logs ──────────────────────────────────────────────────────────
  reg.register({
    requiredScope: "mcp:read",
    definition: {
      name: "vaultbase.read_logs",
      description: "Read recent request logs (vaultbase's structured JSONL log files). Most recent first. Useful for debugging failing requests, tracing rule-eval outcomes, and seeing per-request timings.",
      inputSchema: {
        type: "object",
        properties: {
          from:  { type: "string", description: "ISO date YYYY-MM-DD lower bound (inclusive)" },
          to:    { type: "string", description: "ISO date YYYY-MM-DD upper bound (inclusive)" },
          limit: { type: "integer", minimum: 1, maximum: 1000, description: "Max entries (default 200, hard cap 1000)" },
        },
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      const opts: { from?: string; to?: string; limit?: number } = {};
      if (typeof args.from === "string") opts.from = args.from;
      if (typeof args.to === "string") opts.to = args.to;
      const limit = typeof args.limit === "number" ? Math.min(args.limit, 1000) : 200;
      opts.limit = limit;
      const entries = await readLogs(opts);
      return asUntrustedJsonText("vaultbase logs", entries);
    },
  });

  // ── read_audit_log ─────────────────────────────────────────────────────
  reg.register({
    requiredScope: "mcp:read",
    definition: {
      name: "vaultbase.read_audit_log",
      description: "Query the admin audit log — append-only record of state-changing /admin/* requests. Filter by actor, action prefix, or time range. Useful for 'who deleted this collection three days ago' lookups and compliance audits.",
      inputSchema: {
        type: "object",
        properties: {
          actorId:      { type: "string",  description: "Filter to one admin id" },
          actionPrefix: { type: "string",  description: "Filter on action prefix, e.g. 'collection.' or 'flag.update'" },
          from:         { type: "integer", description: "Unix-seconds lower bound (inclusive)" },
          to:           { type: "integer", description: "Unix-seconds upper bound (inclusive)" },
          page:         { type: "integer", minimum: 1 },
          perPage:      { type: "integer", minimum: 1, maximum: 500, description: "Default 50, max 500" },
        },
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      const opts: Parameters<typeof listAuditEntries>[0] = {};
      if (typeof args.actorId === "string")      opts.actorId = args.actorId;
      if (typeof args.actionPrefix === "string") opts.actionPrefix = args.actionPrefix;
      if (typeof args.from === "number")         opts.from = args.from;
      if (typeof args.to === "number")           opts.to = args.to;
      if (typeof args.page === "number")         opts.page = args.page;
      if (typeof args.perPage === "number")      opts.perPage = Math.min(args.perPage, 500);
      const r = await listAuditEntries(opts);
      return asUntrustedJsonText("vaultbase audit log", r);
    },
  });

}
