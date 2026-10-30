/**
 * Group fields outside the records API: the OpenAPI document, the MCP record
 * tools' input schemas, the MCP seed tool, and CSV export and import.
 *
 * Schemas are checked against real values: records the server returns must
 * fit the read schema, values the server accepts must fit the input schema,
 * and values the server refuses for their shape must not.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as jose from "jose";

import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { createCollection, getCollection, _resetCollectionCache, type FieldDef } from "../core/collections.ts";
import { createRecord, listRecords } from "../core/records.ts";
import { buildOpenApi } from "../core/openapi.ts";
import { buildRegistry, createDispatcher } from "../mcp/server.ts";
import type { ToolContext } from "../mcp/tools.ts";
import type { JsonRpcSuccess, CallToolResult } from "../mcp/types.ts";
import { makeCsvPlugin } from "../api/csv.ts";

const SECRET = "test-secret-group-surfaces";
let tmpDir: string;

const FIELDS: FieldDef[] = [
  { name: "title", type: "text" },
  {
    name: "items", type: "group", options: { min: 1, max: 5, fields: [
      { name: "sku", type: "text", required: true },
      { name: "qty", type: "number", options: { min: 0 } },
      { name: "gift", type: "bool" },
      { name: "tags", type: "select", options: { values: ["a", "b"], multiple: true } },
      { name: "due", type: "date" },
      { name: "color", type: "color" },
      { name: "extra", type: "json" },
    ] },
  },
  { name: "address", type: "group", options: { multiple: false, fields: [
    { name: "city", type: "text", required: true },
    { name: "zip", type: "text" },
  ] } },
];

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-group-surfaces-"));
  setLogsDir(tmpDir);
  await initDb(":memory:");
  await runMigrations();
  _resetCollectionCache();
  await createCollection({ name: "orders", type: "base", list_rule: null, view_rule: null, fields: JSON.stringify(FIELDS) });
  _resetCollectionCache();
});

afterEach(async () => {
  _resetCollectionCache();
  await closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

type Schema = Record<string, unknown>;

/** Enough of JSON Schema for these documents: type, properties, required, additionalProperties, items, counts, enum, pattern. */
function fits(schema: Schema, v: unknown): boolean {
  const t = schema["type"];
  if (t !== undefined) {
    const types = Array.isArray(t) ? t : [t];
    const actual = v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" && Number.isInteger(v) ? "integer" : typeof v;
    if (!types.some((x) => x === actual || (x === "number" && actual === "integer"))) return false;
  }
  if (Array.isArray(schema["enum"]) && !(schema["enum"] as unknown[]).includes(v)) return false;
  if (typeof schema["pattern"] === "string" && typeof v === "string" && !new RegExp(schema["pattern"]).test(v)) return false;
  if (typeof schema["minLength"] === "number" && typeof v === "string" && v.length < schema["minLength"]) return false;
  if (Array.isArray(v)) {
    if (typeof schema["minItems"] === "number" && v.length < schema["minItems"]) return false;
    if (typeof schema["maxItems"] === "number" && v.length > schema["maxItems"]) return false;
    if (schema["items"] && !v.every((x) => fits(schema["items"] as Schema, x))) return false;
  } else if (v && typeof v === "object") {
    const props = (schema["properties"] ?? {}) as Record<string, Schema>;
    const o = v as Record<string, unknown>;
    for (const r of (schema["required"] ?? []) as string[]) if (!(r in o)) return false;
    for (const [k, x] of Object.entries(o)) {
      if (props[k]) { if (!fits(props[k]!, x)) return false; }
      else if (schema["additionalProperties"] === false) return false;
    }
  }
  return true;
}

const GOOD: Record<string, unknown> = {
  title: "t",
  items: [
    { sku: "A", qty: 2, gift: true, tags: ["a"], due: 1_700_000_000, color: "#aabbcc", extra: { any: [1] } },
    { id: "keep_me-1", sku: "B" },
  ],
  address: { city: "Oslo" },
};

/** Other forms the server accepts on write. */
const ALSO_GOOD: Array<[string, Record<string, unknown>]> = [
  ["short and upper-case color", { items: [{ sku: "A", color: "#FFF" }] }],
  ["date as a string", { items: [{ sku: "A", due: "2024-01-01" }] }],
  ["null for an optional subfield", { items: [{ sku: "A", qty: null, tags: null }] }],
  ["null id for a new item", { items: [{ id: null, sku: "A" }] }],
];

/** Inputs whose shape the server refuses, and the schemas should too. */
const BAD_SHAPES: Array<[string, Record<string, unknown>]> = [
  ["unknown subfield", { items: [{ sku: "A", nope: 1 }] }],
  ["missing required subfield", { items: [{ qty: 1 }] }],
  ["too few items", { items: [] }],
  ["too many items", { items: Array.from({ length: 6 }, () => ({ sku: "A" })) }],
  ["item not an object", { items: ["A"] }],
  ["bad item id", { items: [{ id: "has space", sku: "A" }] }],
  ["wrong subfield type", { items: [{ sku: "A", qty: "2" }] }],
  ["select value not allowed", { items: [{ sku: "A", tags: ["z"] }] }],
  ["list for a single object", { items: [{ sku: "A" }], address: [{ city: "Oslo" }] }],
  ["unknown key in single object", { items: [{ sku: "A" }], address: { city: "Oslo", id: "x" } }],
  ["empty required text", { items: [{ sku: "" }] }],
  ["null required subfield", { items: [{ sku: null }] }],
];

async function serverRefuses(data: Record<string, unknown>): Promise<boolean> {
  try { await createRecord("orders", data); return false; } catch { return true; }
}

describe("OpenAPI", () => {
  const schemas = async () => {
    const doc = buildOpenApi([(await getCollection("orders"))!]) as { components: { schemas: Record<string, Schema> } };
    const s = doc.components.schemas;
    return { read: s["Orders"]!, input: s["OrdersInput"]! };
  };
  const prop = (s: Schema, name: string) => (s["properties"] as Record<string, Schema>)[name]!;

  it("describes a list group as an array of objects with the subfields", async () => {
    const { read, input } = await schemas();
    const r = prop(read, "items");
    expect(r["type"]).toBe("array");
    expect(r["minItems"]).toBe(1);
    expect(r["maxItems"]).toBe(5);
    const item = r["items"] as Schema;
    expect(Object.keys(item["properties"] as object)).toEqual(["id", "sku", "qty", "gift", "tags", "due", "color", "extra"]);
    expect(item["required"]).toEqual(["id"]);
    expect(item["additionalProperties"]).toBeUndefined();
    const inItem = prop(input, "items")["items"] as Schema;
    expect(inItem["required"]).toEqual(["sku"]);
    expect(inItem["additionalProperties"]).toBe(false);
    const inProps = inItem["properties"] as Record<string, Schema>;
    // Optional subfields take null; a required text one can't be empty.
    expect(inProps["tags"]).toEqual({ type: ["array", "null"], items: { type: "string", enum: ["a", "b"] } });
    expect(inProps["sku"]).toEqual({ type: "string", minLength: 1 });
    expect(inProps["due"]!["type"]).toEqual(["integer", "string", "null"]);
    expect((r["items"] as Schema)["properties"]).toMatchObject({ due: { type: "integer" } });
  });

  it("describes a single-object group as an object without an id", async () => {
    const { read, input } = await schemas();
    expect(prop(read, "address")).toEqual({ type: "object", properties: { city: { type: "string" }, zip: { type: "string" } } });
    expect(prop(input, "address")).toEqual({
      type: "object",
      properties: { city: { type: "string", minLength: 1 }, zip: { type: ["string", "null"] } },
      required: ["city"],
      additionalProperties: false,
    });
  });

  it("lets an optional single select take null", async () => {
    const s = buildOpenApi([{
      ...(await getCollection("orders"))!,
      fields: JSON.stringify([{ name: "notes", type: "group", options: { fields: [{ name: "size", type: "select", options: { values: ["s", "m"] } }] } }]),
    }]) as { components: { schemas: Record<string, Schema> } };
    const size = ((prop(s.components.schemas["OrdersInput"]!, "notes")["items"] as Schema)["properties"] as Record<string, Schema>)["size"]!;
    expect(size).toEqual({ type: ["string", "null"], enum: ["s", "m", null] });
    expect(fits(size, null)).toBe(true);
    expect(fits(size, "x")).toBe(false);
  });

  it("asks a required single object with only optional fields for at least one", async () => {
    const fields = JSON.stringify([{ name: "place", type: "group", required: true, options: { multiple: false, fields: [
      { name: "city", type: "text" }, { name: "zip", type: "text" },
    ] } }]);
    const s = buildOpenApi([{ ...(await getCollection("orders"))!, fields }]) as { components: { schemas: Record<string, Schema> } };
    expect(prop(s.components.schemas["OrdersInput"]!, "place")["minProperties"]).toBe(1);
    expect(prop(s.components.schemas["Orders"]!, "place")["minProperties"]).toBeUndefined();
    await createCollection({ name: "places", fields });
    _resetCollectionCache();
    const d = createDispatcher(await buildRegistry(false), ctx(["mcp:write"]));
    const r = await d.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }) as JsonRpcSuccess;
    const tool = (r.result as { tools: Array<{ name: string; inputSchema: Schema }> }).tools.find((t) => t.name === "vaultbase.create_places")!;
    const place = ((tool.inputSchema["properties"] as Record<string, Schema>)["data"]!["properties"] as Record<string, Schema>)["place"]!;
    expect(place["minProperties"]).toBe(1);
  });

  it("leaves minItems out when there is no lower bound, and uses the default max", async () => {
    const s = buildOpenApi([{
      ...(await getCollection("orders"))!,
      fields: JSON.stringify([{ name: "notes", type: "group", options: { fields: [{ name: "n", type: "text" }] } }]),
    }]) as { components: { schemas: Record<string, Schema> } };
    const notes = prop(s.components.schemas["Orders"]!, "notes");
    expect(notes["minItems"]).toBeUndefined();
    expect(notes["maxItems"]).toBe(100);
  });

  it("fits what the server accepts and returns, and refuses what the server refuses", async () => {
    const { read, input } = await schemas();
    expect(fits(input, GOOD)).toBe(true);
    for (const [why, data] of ALSO_GOOD) {
      expect({ why, fits: fits(input, data) }).toEqual({ why, fits: true });
      // Read schemas don't allow null for any field type yet; give every field a value.
      const rec = await createRecord("orders", { title: "t", address: { city: "Oslo" }, ...data });
      expect({ why, fits: fits(read, rec) }).toEqual({ why, fits: true });
    }
    const rec = await createRecord("orders", GOOD);
    expect(fits(read, rec)).toBe(true);
    const listed = (await listRecords("orders", {})).data[0];
    expect(fits(read, listed)).toBe(true);
    for (const [why, data] of BAD_SHAPES) {
      expect({ why, refused: await serverRefuses(data) }).toEqual({ why, refused: true });
      expect({ why, fits: fits(input, data) }).toEqual({ why, fits: false });
    }
  });
});

function ctx(scopes: string[]): ToolContext {
  return { tokenId: "tok-1", tokenName: "test", scopes, adminId: "a1", adminEmail: "ops@test.local" };
}

async function callTool(name: string, args: Record<string, unknown>, scopes = ["mcp:write"]): Promise<CallToolResult> {
  const d = createDispatcher(await buildRegistry(false), ctx(scopes));
  const r = await d.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as JsonRpcSuccess;
  return r.result as CallToolResult;
}

describe("MCP", () => {
  const toolSchema = async (name: string) => {
    const d = createDispatcher(await buildRegistry(false), ctx(["mcp:write"]));
    const r = await d.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }) as JsonRpcSuccess;
    const tool = (r.result as { tools: Array<{ name: string; inputSchema: Schema }> }).tools.find((t) => t.name === name)!;
    return (tool.inputSchema["properties"] as Record<string, Schema>)["data"]!;
  };

  it("gives create and update a typed schema for group values", async () => {
    const data = await toolSchema("vaultbase.create_orders");
    const items = (data["properties"] as Record<string, Schema>)["items"]!;
    expect(items["type"]).toBe("array");
    expect(items["minItems"]).toBe(1);
    expect(items["maxItems"]).toBe(5);
    const item = items["items"] as Schema;
    expect(item["required"]).toEqual(["sku"]);
    expect(item["additionalProperties"]).toBe(false);
    expect(Object.keys(item["properties"] as object)).toEqual(["id", "sku", "qty", "gift", "tags", "due", "color", "extra"]);
    const address = (data["properties"] as Record<string, Schema>)["address"]!;
    expect(address["type"]).toBe("object");
    expect(Object.keys(address["properties"] as object)).toEqual(["city", "zip"]);

    expect(fits(data, GOOD)).toBe(true);
    // These guide a model to one form per value, so they needn't take every form the server does.
    for (const [why, bad] of BAD_SHAPES.filter(([w]) => w !== "empty required text")) {
      expect({ why, fits: fits(data, bad) }).toEqual({ why, fits: false });
    }
    const update = await toolSchema("vaultbase.update_orders");
    expect((update["properties"] as Record<string, Schema>)["items"]).toEqual(items);
  });

  it("creates and updates records with group values, keeping item ids", async () => {
    const created = await callTool("vaultbase.create_orders", { data: GOOD });
    expect(created.isError).toBeFalsy();
    const text = (created.content[0] as { text: string }).text;
    const rec = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { id: string; items: Array<{ id: string; sku: string }> };
    expect(rec.items[1]!.id).toBe("keep_me-1");
    expect(rec.items[0]!.id).toMatch(/^[a-z0-9]{15}$/);
    const updated = await callTool("vaultbase.update_orders", { id: rec.id, data: { items: [rec.items[1]] } });
    expect(updated.isError).toBeFalsy();
    const row = (await listRecords("orders", {})).data[0] as unknown as { items: Array<{ id: string; sku: string }> };
    expect(row.items).toEqual([{ id: "keep_me-1", sku: "B" }]);
  });

  it("shows subfields in describe_collection", async () => {
    const r = await callTool("vaultbase.describe_collection", { name: "orders" }, ["mcp:read"]);
    const desc = JSON.parse((r.content[0] as { text: string }).text) as { fields: FieldDef[] };
    const items = desc.fields.find((f) => f.name === "items")!;
    expect(items.type).toBe("group");
    expect((items.options?.fields as FieldDef[]).map((s) => s.name)).toEqual(["sku", "qty", "gift", "tags", "due", "color", "extra"]);
  });

  it("seeds valid group values", async () => {
    const r = await callTool("vaultbase.seed", { collection: "orders", count: 20 });
    const out = JSON.parse((r.content[0] as { text: string }).text) as { created: number; errors: string[] };
    expect(out.errors).toEqual([]);
    expect(out.created).toBe(20);
    const rows = (await listRecords("orders", { perPage: 50 })).data as unknown as Array<{ items: unknown[]; address: { city: string } }>;
    for (const row of rows) {
      expect(row.items.length).toBeGreaterThanOrEqual(1);
      expect(row.items.length).toBeLessThanOrEqual(3);
      expect(typeof row.address.city).toBe("string");
    }
  });

  it("seeds values inside each subfield's own bounds", async () => {
    await createCollection({
      name: "tight", type: "base",
      fields: JSON.stringify([
        { name: "code", type: "text", options: { pattern: "^[0-9]+$" } },
        { name: "rows", type: "group", options: { fields: [
          { name: "big", type: "number", options: { min: 2000 } },
          { name: "frac", type: "number", options: { min: 0.1, max: 0.9 } },
          { name: "neg", type: "number", options: { max: -5 } },
          { name: "short", type: "text", options: { max: 4 } },
          { name: "long", type: "text", options: { min: 40 } },
          { name: "digits", type: "text", options: { pattern: "^[0-9]+$" } },
          { name: "tiny", type: "editor", options: { max: 3 } },
          { name: "one", type: "text", options: { min: 1, max: 1 } },
        ] } },
      ]),
    });
    _resetCollectionCache();
    const r = await callTool("vaultbase.seed", { collection: "tight", count: 30 });
    expect(JSON.parse((r.content[0] as { text: string }).text)).toMatchObject({ created: 30, errors: [] });
  });

  it("says which field a seeded record failed on", async () => {
    await createCollection({
      name: "strict", type: "base",
      fields: JSON.stringify([{ name: "rows", type: "group", options: { fields: [{ name: "code", type: "text", required: true, options: { pattern: "^[0-9]+$" } }] } }]),
    });
    _resetCollectionCache();
    const r = await callTool("vaultbase.seed", { collection: "strict", count: 1 });
    const out = JSON.parse((r.content[0] as { text: string }).text) as { created: number; errors: string[] };
    expect(out.created).toBe(0);
    expect(out.errors[0]).toContain("rows[0].code is required");
  });

  it("seeds at least min items", async () => {
    await createCollection({
      name: "packs", type: "base",
      fields: JSON.stringify([{ name: "parts", type: "group", options: { min: 4, max: 4, fields: [{ name: "n", type: "number" }] } }]),
    });
    _resetCollectionCache();
    const r = await callTool("vaultbase.seed", { collection: "packs", count: 3 });
    expect(JSON.parse((r.content[0] as { text: string }).text)).toMatchObject({ created: 3, errors: [] });
    const rows = (await listRecords("packs", {})).data as unknown as Array<{ parts: unknown[] }>;
    expect(rows.map((x) => x.parts.length)).toEqual([4, 4, 4]);
  });
});

describe("CSV", () => {
  async function adminToken(): Promise<string> {
    const { admin } = await import("../db/schema.ts");
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(admin).values({ id: "a1", email: "admin@test.local", password_hash: "x", password_reset_at: 0, created_at: now });
    return await new jose.SignJWT({ id: "a1", email: "admin@test.local", jti: crypto.randomUUID() })
      .setProtectedHeader({ alg: "HS256" }).setIssuer("vaultbase").setAudience("admin")
      .setIssuedAt(now).setExpirationTime("1h").sign(new TextEncoder().encode(SECRET));
  }

  it("exports group values as JSON and imports them back with their item ids", async () => {
    const token = await adminToken();
    const app = makeCsvPlugin(SECRET);
    const original = await createRecord("orders", { ...GOOD, title: "with, comma" });
    await createRecord("orders", { title: "no address", items: [{ sku: "Z\"q" }] });
    const csv = await (await app.handle(new Request("http://localhost/admin/export/orders", { headers: { authorization: `Bearer ${token}` } }))).text();
    expect(csv.split("\r\n")[0]).toBe("id,created,updated,title,items,address");

    await createCollection({ name: "copy", type: "base", list_rule: null, fields: JSON.stringify(FIELDS) });
    _resetCollectionCache();
    const res = await app.handle(new Request("http://localhost/admin/import/copy", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "text/csv" }, body: csv,
    }));
    const body = await res.json() as { data: { created: number; failed: number } };
    expect(body.data).toMatchObject({ created: 2, failed: 0 });
    const copied = (await listRecords("copy", { sort: "title" })).data as unknown as Array<Record<string, unknown>>;
    const strip = (r: Record<string, unknown>) => ({ title: r["title"], items: r["items"], address: r["address"] });
    const o = original as unknown as Record<string, unknown>;
    expect(strip(copied.find((r) => r["title"] === "with, comma")!)).toEqual(strip(o));
    expect(copied.find((r) => r["title"] === "no address")!["address"]).toBeNull();
  });

  it("reports a row whose group cell is not valid", async () => {
    const token = await adminToken();
    const app = makeCsvPlugin(SECRET);
    const csv = 'title,items\r\nok,"[{""sku"":""A""}]"\r\nbroken,"[{sku:A}]"\r\nempty,';
    const res = await app.handle(new Request("http://localhost/admin/import/orders", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "text/csv" }, body: csv,
    }));
    const body = await res.json() as { data: { created: number; failed: number; errors: Array<{ row: number }> } };
    // An empty cell is no value: fine, since the group isn't required.
    expect(body.data.created).toBe(2);
    expect(body.data.errors.map((e) => e.row)).toEqual([3]);
  });
});
