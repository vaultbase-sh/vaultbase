/**
 * OpenAPI 3.1 description of the records API, generated from the live
 * collection schema. Served at `GET /api/v1/openapi.json`.
 *
 * Covers what a client app calls: records CRUD, list / search / aggregate,
 * files, and the password / refresh auth flows for auth collections. Admin
 * endpoints are left out on purpose.
 */
import type { Collection } from "../db/schema.ts";
import { parseFields, type FieldDef } from "./collections.ts";
import { VAULTBASE_VERSION } from "./version.ts";
import { customFieldType } from "./field-types.ts";

type Schema = Record<string, unknown>;

/** PascalCase component name for a collection, e.g. `blog_posts` → `BlogPosts`. */
function typeName(collection: string): string {
  return collection.split(/[^A-Za-z0-9]+/).filter(Boolean).map((p) => p[0]!.toUpperCase() + p.slice(1)).join("") || "Collection";
}

function fieldSchema(f: FieldDef): Schema {
  const many = f.options?.multiple === true;
  const list = (s: Schema): Schema => (many ? { type: "array", items: s } : s);
  switch (f.type) {
    case "number": return { type: "number" };
    case "bool": return { type: "boolean" };
    case "email": return { type: "string", format: "email" };
    case "url": return { type: "string", format: "uri" };
    case "color": return {
      type: "string",
      pattern: f.options?.alpha ? "^#[0-9a-f]{6}([0-9a-f]{2})?$" : "^#[0-9a-f]{6}$",
      description: "Hex color; #rgb / #RRGGBB accepted on write and stored lowercase",
    };
    case "date":
    case "autodate": return { type: "integer", description: "Unix seconds" };
    case "select": return list(f.options?.values?.length ? { type: "string", enum: f.options.values } : { type: "string" });
    case "relation": return list({ type: "string", description: `Record id in '${f.collection ?? "?"}'` });
    case "file": return list({ type: "string", description: "Stored filename; fetch via /api/v1/files/{filename}" });
    case "json": return {};
    case "geoPoint": return {
      type: "object", required: ["lat", "lng"],
      properties: { lat: { type: "number" }, lng: { type: "number" } },
    };
    case "vector": return { type: "array", items: { type: "number" }, ...(f.options?.dimensions ? { minItems: f.options.dimensions, maxItems: f.options.dimensions } : {}) };
    case "password": return { type: "string", writeOnly: true };
    default: return customFieldType(f.type)?.openapi?.(f) ?? { type: "string" };
  }
}

function recordSchemas(col: Collection): { record: Schema; input: Schema } {
  const fields = parseFields(col.fields).filter((f) => !f.system);
  const props: Record<string, Schema> = {
    id: { type: "string", readOnly: true },
    collectionId: { type: "string", readOnly: true },
    collectionName: { type: "string", readOnly: true },
    created: { type: "integer", description: "Unix seconds", readOnly: true },
    updated: { type: "integer", description: "Unix seconds", readOnly: true },
  };
  const inputProps: Record<string, Schema> = {};
  const required: string[] = [];
  for (const f of fields) {
    const s = fieldSchema(f);
    if (f.type !== "password") props[f.name] = s;
    // autodate is set by the server; file fields are written via /files.
    if (f.type !== "autodate" && f.type !== "file" && !(col.type === "auth" && f.implicit)) {
      inputProps[f.name] = s;
      if (f.required) required.push(f.name);
    }
  }
  return {
    record: { type: "object", properties: props },
    input: { type: "object", properties: inputProps, ...(required.length ? { required } : {}) },
  };
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: Schema) => ({ "application/json": { schema } });
const ok = (schema: Schema, description = "OK") => ({ description, content: json(schema) });
const ERRORS = {
  "400": { description: "Bad request", content: json(ref("Error")) },
  "401": { description: "Unauthorized", content: json(ref("Error")) },
  "403": { description: "Forbidden", content: json(ref("Error")) },
  "404": { description: "Not found", content: json(ref("Error")) },
};
const qp = (name: string, description: string, schema: Schema = { type: "string" }) =>
  ({ name, in: "query", required: false, description, schema });
const ID = { name: "id", in: "path", required: true, schema: { type: "string" } };

function collectionPaths(col: Collection, T: string): Record<string, Schema> {
  const base = `/api/v1/${col.name}`;
  const tags = [col.name];
  const dataOf = (s: Schema) => ({ type: "object", properties: { data: s } });
  const paths: Record<string, Schema> = {
    [base]: {
      get: {
        tags, operationId: `list${T}`, summary: `List ${col.name}`,
        parameters: [
          qp("page", "1-based page", { type: "integer", minimum: 1 }),
          qp("perPage", "Page size (max 500)", { type: "integer", minimum: 1, maximum: 500 }),
          qp("filter", "Filter expression, e.g. status = \"open\" && amount > 10"),
          qp("sort", "Comma-separated fields; '-' prefix for descending"),
          qp("expand", "Comma-separated relation fields to expand"),
          qp("fields", "Comma-separated fields to return"),
          qp("skipTotal", "Skip the total count", { type: "boolean" }),
          qp("search", "Full-text search over searchable fields"),
        ],
        responses: {
          "200": ok({
            type: "object",
            properties: {
              data: { type: "array", items: ref(T) },
              page: { type: "integer" }, perPage: { type: "integer" },
              totalItems: { type: "integer" }, totalPages: { type: "integer" },
            },
          }),
          ...ERRORS,
        },
      },
      ...(col.type === "view" ? {} : {
        post: {
          tags, operationId: `create${T}`, summary: `Create a ${col.name} record`,
          requestBody: { required: true, content: json(ref(`${T}Input`)) },
          responses: { "200": ok(dataOf(ref(T))), "422": { description: "Validation failed", content: json(ref("Error")) }, ...ERRORS },
        },
      }),
    },
    [`${base}/_aggregate`]: {
      get: {
        tags, operationId: `aggregate${T}`, summary: `Aggregate ${col.name}`,
        parameters: [
          qp("agg", "count, count(f), sum(f), avg(f), min(f), max(f); comma-separated"),
          qp("groupBy", "Up to 3 fields; date fields take :hour/:day/:week/:month/:year"),
          qp("filter", "Filter expression"),
          qp("search", "Full-text search"),
          qp("sort", "groupBy field or aggregate alias, '-' for descending"),
          qp("limit", "Max groups (default 100, max 1000)", { type: "integer" }),
        ],
        responses: { "200": ok(dataOf({ type: "array", items: { type: "object", additionalProperties: true } })), ...ERRORS },
      },
    },
    [`${base}/{id}`]: {
      get: {
        tags, operationId: `get${T}`, summary: `Get a ${col.name} record`,
        parameters: [ID, qp("expand", "Relation fields to expand"), qp("fields", "Fields to return")],
        responses: { "200": ok(dataOf(ref(T))), ...ERRORS },
      },
      ...(col.type === "view" ? {} : {
        patch: {
          tags, operationId: `update${T}`, summary: `Update a ${col.name} record`,
          parameters: [ID, { name: "If-Match", in: "header", required: false, description: "ETag for optimistic concurrency", schema: { type: "string" } }],
          requestBody: { required: true, content: json({ ...ref(`${T}Input`) }) },
          responses: { "200": ok(dataOf(ref(T))), "412": { description: "ETag mismatch", content: json(ref("Error")) }, ...ERRORS },
        },
        delete: {
          tags, operationId: `delete${T}`, summary: `Delete a ${col.name} record`,
          parameters: [ID],
          responses: { "200": { description: "Deleted" }, ...ERRORS },
        },
      }),
    },
  };
  if (col.type === "auth") {
    const auth = `/api/v1/auth/${col.name}`;
    const creds = { type: "object", required: ["email", "password"], properties: { email: { type: "string", format: "email" }, password: { type: "string" } } };
    const session = dataOf({
      type: "object",
      properties: {
        token: { type: "string" },
        record: { type: "object", properties: { id: { type: "string" }, email: { type: "string" } } },
        mfa_required: { type: "boolean" }, mfa_token: { type: "string" },
      },
    });
    const authTags = [`${col.name} auth`];
    paths[`${auth}/register`] = { post: { tags: authTags, operationId: `register${T}`, summary: "Register", security: [], requestBody: { required: true, content: json(creds) }, responses: { "200": { description: "Accepted" }, "422": { description: "Invalid", content: json(ref("Error")) } } } };
    paths[`${auth}/login`] = { post: { tags: authTags, operationId: `login${T}`, summary: "Log in with email and password", security: [], requestBody: { required: true, content: json(creds) }, responses: { "200": ok(session), "401": ERRORS["401"] } } };
    paths[`${auth}/request-password-reset`] = { post: { tags: authTags, operationId: `requestPasswordReset${T}`, summary: "Email a password reset link", security: [], requestBody: { required: true, content: json({ type: "object", required: ["email"], properties: { email: { type: "string", format: "email" } } }) }, responses: { "200": { description: "Accepted" } } } };
  }
  return paths;
}

/**
 * The server URL is relative ("/"): it resolves against wherever the spec
 * was fetched from, which stays right behind proxies and custom domains.
 */
export function buildOpenApi(cols: Collection[]): Schema {
  const schemas: Record<string, Schema> = {
    Error: { type: "object", properties: { error: { type: "string" }, code: { type: "integer" }, details: { type: "object", additionalProperties: { type: "string" } } } },
  };
  let paths: Record<string, Schema> = {};
  const tags: Schema[] = [];
  for (const col of [...cols].sort((a, b) => a.name.localeCompare(b.name))) {
    let T = typeName(col.name);
    while (schemas[T]) T = `${T}_`;
    const { record, input } = recordSchemas(col);
    schemas[T] = record;
    if (col.type !== "view") schemas[`${T}Input`] = input;
    paths = { ...paths, ...collectionPaths(col, T) };
    tags.push({ name: col.name, description: `${col.type} collection` });
  }
  paths["/api/v1/auth/refresh"] = {
    post: { tags: ["auth"], operationId: "refreshSession", summary: "Exchange a valid session token for a fresh one", responses: { "200": ok({ type: "object", properties: { data: { type: "object", properties: { token: { type: "string" } } } } }), "401": ERRORS["401"] } },
  };
  paths["/api/v1/files/{filename}"] = {
    get: {
      tags: ["files"], operationId: "getFile", summary: "Download a file, optionally as a thumbnail",
      parameters: [
        { name: "filename", in: "path", required: true, schema: { type: "string" } },
        qp("thumb", "WxH, WxH_cover, or 400x0"),
        qp("fit", "contain, cover or crop"),
        qp("format", "webp, jpeg, png or auto"),
        qp("quality", "1-100", { type: "integer", minimum: 1, maximum: 100 }),
        qp("token", "Access token for protected files"),
      ],
      responses: { "200": { description: "File bytes", content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } }, ...ERRORS },
    },
  };
  paths["/api/v1/files/{collection}/{recordId}/{field}"] = {
    post: {
      tags: ["files"], operationId: "uploadFile", summary: "Upload to a record's file field",
      parameters: ["collection", "recordId", "field"].map((name) => ({ name, in: "path", required: true, schema: { type: "string" } })),
      requestBody: { required: true, content: { "multipart/form-data": { schema: { type: "object", properties: { file: { type: "string", format: "binary" } } } } } },
      responses: { "200": { description: "Uploaded" }, ...ERRORS },
    },
  };
  return {
    openapi: "3.1.0",
    info: { title: "Vaultbase API", version: VAULTBASE_VERSION, description: "Generated from this server's collections." },
    servers: [{ url: "/" }],
    security: [{ bearerAuth: [] }, {}],
    tags: [...tags, { name: "auth" }, { name: "files" }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      schemas,
    },
  };
}
