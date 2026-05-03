/**
 * Auto-generated MCP tools per vaultbase collection.
 *
 * For every collection, we mint five tools:
 *
 *   vaultbase.list_<collection>(filter?, sort?, page?, perPage?, fields?)
 *   vaultbase.get_<collection>(id)
 *   vaultbase.create_<collection>(data)        — write scope
 *   vaultbase.update_<collection>(id, data)    — write scope
 *   vaultbase.delete_<collection>(id)          — write scope
 *
 * Field-type info on each collection drives the inputSchema for create /
 * update so the LLM can construct well-typed calls without trial-and-error.
 *
 * The tools call the SAME `core/records.ts` API the REST layer uses, so
 * collection rules + validation + audit-log emission all happen for free.
 * The minting admin is the auth principal — same actor model as direct
 * REST calls with the API token.
 */

import {
  createRecord,
  deleteRecord,
  getRecord,
  listRecords,
  updateRecord,
  type ListOptions,
} from "../core/records.ts";
import { listCollections, parseFields, type FieldDef } from "../core/collections.ts";
import { ToolRegistry, asJsonText, asUntrustedJsonText } from "./tools.ts";

const HARD_PER_PAGE_CAP = 100;

/** Map a field type to a JSON-Schema fragment for tool inputSchema. */
function fieldTypeSchema(f: FieldDef): Record<string, unknown> {
  switch (f.type) {
    case "number":
      return { type: "number", description: hint(f) };
    case "bool":
      return { type: "boolean", description: hint(f) };
    case "date":
    case "autodate":
      return { type: "integer", description: `${hint(f)} (unix-seconds)` };
    case "select": {
      const values = (f.options?.["values"] as string[] | undefined) ?? [];
      const single = { type: "string", enum: values, description: hint(f) };
      return f.options?.["multiple"]
        ? { type: "array", items: single, description: hint(f) }
        : single;
    }
    case "geoPoint":
      return {
        type: "object",
        properties: {
          lat: { type: "number", minimum: -90,  maximum: 90 },
          lng: { type: "number", minimum: -180, maximum: 180 },
        },
        required: ["lat", "lng"],
        description: hint(f),
      };
    case "vector": {
      const dims = (f.options?.["dimensions"] as number | undefined) ?? null;
      return {
        type: "array",
        items: { type: "number" },
        ...(dims ? { minItems: dims, maxItems: dims } : {}),
        description: dims ? `${hint(f)} (${dims}-dim vector)` : hint(f),
      };
    }
    case "json":
      return { description: hint(f) }; // open-ended
    case "file":
      return {
        ...(f.options?.["multiple"]
          ? { type: "array", items: { type: "string" } }
          : { type: "string" }),
        description: `${hint(f)} (filename — files must be uploaded via the file upload endpoint, not this tool)`,
      };
    case "relation":
      return { type: "string", description: `${hint(f)} (id of a record in the '${f.collection}' collection)` };
    case "email":
      return { type: "string", format: "email", description: hint(f) };
    case "url":
      return { type: "string", format: "uri", description: hint(f) };
    default:
      return { type: "string", description: hint(f) };
  }
}

function hint(f: FieldDef): string {
  const bits: string[] = [];
  if (f.required) bits.push("required");
  if (f.options?.unique) bits.push("unique");
  if (typeof f.options?.min === "number") bits.push(`min ${f.options.min}`);
  if (typeof f.options?.max === "number") bits.push(`max ${f.options.max}`);
  return `${f.type}${bits.length ? ` (${bits.join(", ")})` : ""}`;
}

function dataObjectSchema(fields: FieldDef[], mode: "create" | "update"): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of fields) {
    if (f.system || f.implicit || f.type === "autodate") continue;
    properties[f.name] = fieldTypeSchema(f);
    if (mode === "create" && f.required) required.push(f.name);
  }
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

/**
 * Register five tools per collection on the registry. Re-runnable safely
 * after a schema change — call with a fresh registry; the old one is
 * discarded.
 */
export async function registerCollectionTools(reg: ToolRegistry): Promise<void> {
  const cols = await listCollections();
  for (const col of cols) {
    const fields = parseFields(col.fields);
    const slug = col.name; // collection name is already SQL-ident-safe

    // ── list ──────────────────────────────────────────────────────────
    reg.register({
      requiredScope: "mcp:read",
      definition: {
        name: `vaultbase.list_${slug}`,
        description: `List records in the '${slug}' collection. Supports filter expressions, sort, pagination, and field projection. Cap: ${HARD_PER_PAGE_CAP} records per page.`,
        inputSchema: {
          type: "object",
          properties: {
            filter:    { type: "string",  description: "vaultbase rule-expression filter, e.g. \"status = 'live' && created > 1700000000\"" },
            sort:      { type: "string",  description: "Comma-separated. Prefix '-' for desc. Example: '-created,title'" },
            page:      { type: "integer", minimum: 1 },
            perPage:   { type: "integer", minimum: 1, maximum: HARD_PER_PAGE_CAP, description: `Default 30, max ${HARD_PER_PAGE_CAP}` },
            fields:    { type: "string",  description: "Comma-separated projection, e.g. 'id,title,created'" },
            skipTotal: { type: "boolean", description: "Skip COUNT(*) for huge tables. Default false." },
          },
          additionalProperties: false,
        },
      },
      handler: async (args) => {
        const opts: ListOptions = {};
        if (typeof args.filter    === "string")  opts.filter    = args.filter;
        if (typeof args.sort      === "string")  opts.sort      = args.sort;
        if (typeof args.page      === "number")  opts.page      = args.page;
        if (typeof args.perPage   === "number")  opts.perPage   = Math.min(args.perPage, HARD_PER_PAGE_CAP);
        if (typeof args.fields    === "string")  opts.fields    = args.fields;
        if (typeof args.skipTotal === "boolean") opts.skipTotal = args.skipTotal;
        const r = await listRecords(slug, opts);
        return asUntrustedJsonText(`${slug} list`, r);
      },
    });

    // ── get ───────────────────────────────────────────────────────────
    reg.register({
      requiredScope: "mcp:read",
      definition: {
        name: `vaultbase.get_${slug}`,
        description: `Fetch a single '${slug}' record by id. Returns null if not found.`,
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Record id" },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
      handler: async (args) => {
        if (typeof args.id !== "string") throw new Error("id (string) is required");
        const r = await getRecord(slug, args.id);
        return asUntrustedJsonText(`${slug} record`, r);
      },
    });

    // ── create ────────────────────────────────────────────────────────
    reg.register({
      requiredScope: "mcp:write",
      definition: {
        name: `vaultbase.create_${slug}`,
        description: `Create a new '${slug}' record. Validation + collection rules (create_rule) apply. Returns the created record with server-assigned id + timestamps.`,
        inputSchema: {
          type: "object",
          properties: {
            data: dataObjectSchema(fields, "create"),
          },
          required: ["data"],
          additionalProperties: false,
        },
      },
      handler: async (args, ctx) => {
        const data = args.data as Record<string, unknown> | undefined;
        if (!data || typeof data !== "object") throw new Error("data (object) is required");
        const r = await createRecord(slug, data, { id: ctx.adminId, type: "admin", email: ctx.adminEmail });
        return asJsonText(r);
      },
    });

    // ── update ────────────────────────────────────────────────────────
    reg.register({
      requiredScope: "mcp:write",
      definition: {
        name: `vaultbase.update_${slug}`,
        description: `Update an existing '${slug}' record. PATCH semantics — only provided fields are touched. Validation + update_rule apply.`,
        inputSchema: {
          type: "object",
          properties: {
            id:   { type: "string", description: "Record id" },
            data: dataObjectSchema(fields, "update"),
          },
          required: ["id", "data"],
          additionalProperties: false,
        },
      },
      handler: async (args, ctx) => {
        if (typeof args.id !== "string") throw new Error("id (string) is required");
        const data = args.data as Record<string, unknown> | undefined;
        if (!data || typeof data !== "object") throw new Error("data (object) is required");
        const r = await updateRecord(slug, args.id, data, { id: ctx.adminId, type: "admin", email: ctx.adminEmail });
        return asJsonText(r);
      },
    });

    // ── delete ────────────────────────────────────────────────────────
    reg.register({
      requiredScope: "mcp:write",
      definition: {
        name: `vaultbase.delete_${slug}`,
        description: `Delete a '${slug}' record by id. delete_rule + cascade behaviour apply per the collection schema.`,
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Record id" },
          },
          required: ["id"],
          additionalProperties: false,
        },
      },
      handler: async (args, ctx) => {
        if (typeof args.id !== "string") throw new Error("id (string) is required");
        await deleteRecord(slug, args.id, { id: ctx.adminId, type: "admin", email: ctx.adminEmail });
        return asJsonText({ deleted: true, collection: slug, id: args.id });
      },
    });
  }
}
