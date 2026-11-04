/**
 * Auto-generated MCP tools per vaultbase collection.
 *
 * For every collection, we mint five tools:
 *
 *   vaultbase.list_<collection>(filter?, sort?, page?, perPage?, fields?, exclude?)
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
import { ensureSingletonRecord, listCollections, parseFields, type FieldDef } from "../core/collections.ts";
import { groupItemBounds, isGroupList, subfieldsOf } from "../core/group-fields.ts";
import { ToolRegistry, asJsonText, asUntrustedJsonText } from "./tools.ts";
import { parseViewParams } from "../core/view-params.ts";

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
    case "color":
      return { type: "string", description: `${hint(f)} (hex color, e.g. #e85a4f${f.options?.alpha ? " or #e85a4f80" : ""})` };
    case "group": {
      const list = isGroupList(f);
      const properties: Record<string, unknown> = list
        ? { id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$", description: "keep an item's id when updating; omit it for a new item" } }
        : {};
      const required: string[] = [];
      for (const sub of subfieldsOf(f)) {
        properties[sub.name] = fieldTypeSchema(sub);
        if (sub.required) required.push(sub.name);
      }
      const item = { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
      if (!list) {
        const atLeastOne = f.required && required.length === 0;
        return {
          ...item,
          ...(atLeastOne ? { minProperties: 1 } : {}),
          description: `${hint(f)} (one object${atLeastOne ? "; at least one field must hold a value" : ""})`,
        };
      }
      const { min, max } = groupItemBounds(f);
      return {
        type: "array",
        items: item,
        ...(min > 0 ? { minItems: min } : {}),
        maxItems: max,
        description: `${hint(f)} (list of items; send the whole list, it replaces the stored one)`,
      };
    }
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
    // A view's parameters (core/view-params.ts), as a `params` argument. One
    // from auth.id isn't settable; with no user here it's NULL.
    const viewParams = col.type === "view" ? parseViewParams(col.view_params).filter((p) => !p.from) : [];
    const paramsProp = viewParams.length === 0 ? {} : {
      params: {
        type: "object",
        description: `The view's parameters: ${viewParams.map((p) => `${p.name} (${p.type}${p.required ? ", required" : ""})`).join(", ")}`,
        properties: Object.fromEntries(viewParams.map((p) => [p.name, {
          type: p.type === "number" ? "number" : p.type === "bool" ? "boolean" : "string",
          ...(p.type === "date" ? { description: "ISO 8601 date or Unix seconds" } : {}),
        }])),
        ...(viewParams.some((p) => p.required) ? { required: viewParams.filter((p) => p.required).map((p) => p.name) } : {}),
        additionalProperties: false,
      },
    };
    const paramsArg = (args: Record<string, unknown>) =>
      args["params"] && typeof args["params"] === "object" ? args["params"] as Record<string, unknown> : null;

    // A singleton has one record: read and update it, no id, no list,
    // create or delete.
    if (col.type === "singleton") {
      reg.register({
        auditCollection: col.name,
        requiredScope: "mcp:read",
        definition: {
          name: reg.freeName(`vaultbase.get_${slug}`),
          description: `Read the '${slug}' singleton: the collection's one record.`,
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
        handler: async () => asUntrustedJsonText(`${slug} record`, await getRecord(slug, await ensureSingletonRecord(slug))),
      });
      reg.register({
        auditCollection: col.name,
        requiredScope: "mcp:write",
        definition: {
          name: reg.freeName(`vaultbase.update_${slug}`),
          description: `Update the '${slug}' singleton (its one record). PATCH semantics — only provided fields are touched. Validation + update_rule apply.`,
          inputSchema: {
            type: "object",
            properties: { data: dataObjectSchema(fields, "update") },
            required: ["data"],
            additionalProperties: false,
          },
        },
        handler: async (args, ctx) => {
          const data = args.data as Record<string, unknown> | undefined;
          if (!data || typeof data !== "object") throw new Error("data (object) is required");
          const r = await updateRecord(slug, await ensureSingletonRecord(slug), data, { id: ctx.adminId, type: "admin", email: ctx.adminEmail });
          // The stored record comes back whole, other writers' fields included.
          return asUntrustedJsonText(`${slug} record`, r);
        },
      });
      continue;
    }

    // ── list ──────────────────────────────────────────────────────────
    reg.register({
      auditCollection: col.name,
      requiredScope: "mcp:read",
      definition: {
        name: reg.freeName(`vaultbase.list_${slug}`),
        description: `List records in the '${slug}' collection. Supports filter expressions, sort, pagination, and field projection. Cap: ${HARD_PER_PAGE_CAP} records per page.`,
        inputSchema: {
          type: "object",
          properties: {
            filter:    { type: "string",  description: "vaultbase rule-expression filter, e.g. \"status = 'live' && created > 1700000000\"" },
            sort:      { type: "string",  description: "Comma-separated. Prefix '-' for desc. Example: '-created,title'" },
            page:      { type: "integer", minimum: 1 },
            perPage:   { type: "integer", minimum: 1, maximum: HARD_PER_PAGE_CAP, description: `Default 30, max ${HARD_PER_PAGE_CAP}` },
            fields:    { type: "string",  description: "Comma-separated projection, e.g. 'id,title,created'" },
            exclude:   { type: "string",  description: "Comma-separated fields to leave out, applied after fields; id is always returned" },
            skipTotal: { type: "boolean", description: "Skip COUNT(*) for huge tables. Default false." },
            ...paramsProp,
          },
          ...(viewParams.some((p) => p.required) ? { required: ["params"] } : {}),
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
        if (typeof args.exclude   === "string")  opts.exclude   = args.exclude;
        if (typeof args.skipTotal === "boolean") opts.skipTotal = args.skipTotal;
        if (paramsArg(args)) opts.viewParams = paramsArg(args);
        const r = await listRecords(slug, opts);
        return asUntrustedJsonText(`${slug} list`, r);
      },
    });

    // ── get ───────────────────────────────────────────────────────────
    reg.register({
      auditCollection: col.name,
      requiredScope: "mcp:read",
      definition: {
        name: reg.freeName(`vaultbase.get_${slug}`),
        description: `Fetch a single '${slug}' record by id. Returns null if not found.`,
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Record id" },
            ...paramsProp,
          },
          required: viewParams.some((p) => p.required) ? ["id", "params"] : ["id"],
          additionalProperties: false,
        },
      },
      handler: async (args) => {
        if (typeof args.id !== "string") throw new Error("id (string) is required");
        const r = await getRecord(slug, args.id, viewParams.length > 0 || col.view_params ? { viewParams: paramsArg(args), auth: null } : undefined);
        return asUntrustedJsonText(`${slug} record`, r);
      },
    });

    // ── create ────────────────────────────────────────────────────────
    reg.register({
      auditCollection: col.name,
      requiredScope: "mcp:write",
      definition: {
        name: reg.freeName(`vaultbase.create_${slug}`),
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
        ctx.auditRecordId = r.id;
        // Hooks and defaults may fill fields from other records.
        return asUntrustedJsonText(`${slug} record`, r);
      },
    });

    // ── update ────────────────────────────────────────────────────────
    reg.register({
      auditCollection: col.name,
      requiredScope: "mcp:write",
      definition: {
        name: reg.freeName(`vaultbase.update_${slug}`),
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
        // Fields this call didn't touch were written by whoever made the record.
        return asUntrustedJsonText(`${slug} record`, r);
      },
    });

    // ── delete ────────────────────────────────────────────────────────
    reg.register({
      auditCollection: col.name,
      requiredScope: "mcp:write",
      definition: {
        name: reg.freeName(`vaultbase.delete_${slug}`),
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
