/**
 * Golden public surface: the parts of the API an app, client or script
 * depends on, pinned so a breaking change can't merge by accident (Road to
 * 1.0, gate 2). A change that fails here is either additive (update the
 * golden on purpose with `UPDATE_GOLDEN=1 bun test golden-surface` and add
 * a changelog entry) or breaking (it needs an upgrade note and, after 1.0,
 * waits for 2.0).
 *
 * Unlike golden-sql, this runs on both databases against the same files:
 * the public surface must not depend on the driver.
 *
 * Three goldens, under `src/__tests__/golden/`:
 *   routes.txt    every HTTP route the server mounts, as `METHOD path`
 *   openapi.json  the OpenAPI document for one collection of each type
 *   mcp.json      MCP tools (name, scope, input schema), resources,
 *                 resource templates, prompts and the protocol version
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDb, initDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, listCollections, _resetCollectionCache } from "../core/collections.ts";
import { buildOpenApi } from "../core/openapi.ts";
import { createServer } from "../server.ts";
import { buildRegistry } from "../mcp/server.ts";
import { listPrompts } from "../mcp/prompts.ts";
import { listResources, listResourceTemplates } from "../mcp/resources.ts";
import { MCP_PROTOCOL_VERSION } from "../mcp/types.ts";
import { stopScheduler } from "../core/jobs.ts";
import { stopQueueScheduler } from "../core/queues.ts";
import { stopWebhookDispatcher } from "../core/webhooks.ts";
import { stopUpdateCheckScheduler } from "../core/update-check.ts";
import { _reset as resetRealtime } from "../realtime/manager.ts";
import { setLogsDir } from "../core/file-logger.ts";

const DIR = new URL("./golden/", import.meta.url);
const UPDATE = process.env["UPDATE_GOLDEN"] === "1";

async function check(name: string, actual: string): Promise<void> {
  const file = Bun.file(new URL(name, DIR));
  if (UPDATE) {
    await Bun.write(file, actual);
    return;
  }
  const expected = (await file.exists()) ? await file.text() : null;
  expect(expected, `${name} missing — run UPDATE_GOLDEN=1 bun test golden-surface`).not.toBeNull();
  expect(actual, `${name} changed — if on purpose, run UPDATE_GOLDEN=1 bun test golden-surface and add a changelog entry`).toBe(expected!);
}

/** JSON with object keys sorted at every level, so key order never shows as a change. */
function stable(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value), null, 2) + "\n";
}

/** One collection of each type, with every field type a base collection takes. */
async function seedCollections(): Promise<void> {
  const open = { list_rule: null, view_rule: null, create_rule: null, update_rule: null, delete_rule: null };
  await createCollection({
    name: "people", type: "base", ...open,
    fields: JSON.stringify([{ name: "name", type: "text" }]),
  });
  await createCollection({
    name: "posts", type: "base", ...open,
    fields: JSON.stringify([
      { name: "title", type: "text", required: true },
      { name: "body", type: "editor" },
      { name: "contact", type: "email" },
      { name: "site", type: "url" },
      { name: "price", type: "number" },
      { name: "active", type: "bool" },
      { name: "when", type: "date" },
      { name: "stamp", type: "autodate", onCreate: true, onUpdate: true },
      { name: "status", type: "select", options: { values: ["draft", "published"] } },
      { name: "labels", type: "select", options: { values: ["a", "b"], multiple: true } },
      { name: "meta", type: "json" },
      { name: "cover", type: "file" },
      { name: "docs", type: "file", options: { multiple: true } },
      { name: "author", type: "relation", collection: "people" },
      { name: "pt", type: "geoPoint" },
      { name: "emb", type: "vector", options: { dimensions: 3 } },
      { name: "hue", type: "color" },
      { name: "secret", type: "password" },
      { name: "items", type: "group", options: { min: 1, max: 5, fields: [
        { name: "sku", type: "text", required: true },
        { name: "qty", type: "number" },
      ] } },
      { name: "address", type: "group", options: { multiple: false, fields: [{ name: "city", type: "text" }] } },
    ]),
  });
  await createCollection({ name: "members", type: "auth", ...open, fields: "[]" });
  await createCollection({ name: "site_config", type: "singleton", ...open, fields: JSON.stringify([{ name: "motd", type: "text" }]) });
  await createCollection({
    name: "post_counts", type: "view", list_rule: null, view_rule: null,
    view_query: "SELECT id, title FROM vb_posts WHERE price > :min",
    view_params: JSON.stringify([{ name: "min", type: "number", default: 0 }]),
  });
}

describe("golden public surface", () => {
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "vb-golden-surface-"));
    setLogsDir(dir);
    await initDb(":memory:");
    await runMigrations();
    await seedCollections();
  });

  afterAll(async () => {
    stopScheduler(); stopQueueScheduler(); stopWebhookDispatcher(); stopUpdateCheckScheduler();
    resetRealtime();
    _resetCollectionCache();
    await closeDb();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
  });

  it("HTTP routes", async () => {
    const app = createServer({
      port: 0, dataDir: dir, dbPath: ":memory:", uploadDir: join(dir, "u"), logsDir: join(dir, "l"),
      jwtSecret: "golden-surface-secret-0123456789abcdef", encryptionKey: undefined,
    });
    const lines = [...new Set(app.routes.map((r) => `${r.method} ${r.path}`))].sort();
    await check("routes.txt", lines.join("\n") + "\n");
  });

  it("OpenAPI document", async () => {
    const doc = buildOpenApi(await listCollections()) as { info: { version: string } };
    doc.info.version = "<version>";
    await check("openapi.json", stable(doc));
  });

  it("MCP tools, resources and prompts", async () => {
    // The registry keeps each tool's scope off its public definition; filter() visits them all.
    const tools: Array<{ name: string; scope: string; inputSchema: unknown }> = [];
    (await buildRegistry(false)).filter((t) => {
      tools.push({ name: t.definition.name, scope: t.requiredScope, inputSchema: t.definition.inputSchema });
      return false;
    });
    tools.sort((a, b) => a.name.localeCompare(b.name));
    await check("mcp.json", stable({
      protocolVersion: MCP_PROTOCOL_VERSION,
      tools,
      resources: listResources().map((r) => r.uri).sort(),
      resourceTemplates: listResourceTemplates().map((t) => t.uriTemplate).sort(),
      prompts: listPrompts()
        .map((p) => ({ name: p.name, arguments: (p.arguments ?? []).map((a) => ({ name: a.name, required: !!a.required })) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));
  });
});
