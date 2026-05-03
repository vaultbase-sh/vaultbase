/**
 * MCP Phase-1 — server dispatcher behaviour.
 *
 * Tests drive the dispatcher directly without spinning up real stdio,
 * matching how Claude Desktop / Cursor would interact: send a JSON-RPC
 * request, observe the response shape, verify auth + scope + tool
 * behaviour.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { setUploadDir, invalidateStorageCache } from "../core/storage.ts";
import { createCollection, type FieldDef } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { buildRegistry, createDispatcher } from "../mcp/server.ts";
import type { ToolContext } from "../mcp/tools.ts";
import { MCP_PROTOCOL_VERSION, type JsonRpcRequest, type JsonRpcSuccess, type JsonRpcError, type CallToolResult } from "../mcp/types.ts";

const SECRET = "test-secret-mcp";
let tmpDir: string;

function mkCtx(scopes: string[], opts: Partial<ToolContext> = {}): ToolContext {
  return {
    tokenId:    opts.tokenId    ?? "tok-1",
    tokenName:  opts.tokenName  ?? "test token",
    scopes,
    adminId:    opts.adminId    ?? "a1",
    adminEmail: opts.adminEmail ?? "ops@test.local",
  };
}

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-mcp-"));
  setLogsDir(tmpDir);
  setUploadDir(tmpDir);
  invalidateStorageCache();
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function seedPostsCollection(): Promise<void> {
  const fields: FieldDef[] = [
    { name: "title", type: "text", required: true, options: { min: 1, max: 200 } },
    { name: "body",  type: "text", required: false },
    { name: "status", type: "select", options: { values: ["draft", "live"] } },
  ];
  await createCollection({
    name: "posts", type: "base", fields: JSON.stringify(fields), view_rule: null,
  });
}

async function dispatch(req: JsonRpcRequest, ctx: ToolContext, readOnly = false) {
  const reg = await buildRegistry(readOnly);
  const d = createDispatcher(reg, ctx);
  return await d.handle(req);
}

void SECRET;

describe("MCP — initialize handshake", () => {
  it("returns protocol version + capabilities + serverInfo", async () => {
    const r = await dispatch(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      mkCtx(["mcp:read"]),
    ) as JsonRpcSuccess;
    expect(r.jsonrpc).toBe("2.0");
    expect(r.id).toBe(1);
    const result = r.result as { protocolVersion: string; capabilities: { tools?: unknown }; serverInfo: { name: string } };
    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(result.capabilities.tools).toBeTruthy();
    expect(result.serverInfo.name).toBe("vaultbase");
  });

  it("notifications/initialized produces no response", async () => {
    const r = await dispatch(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      mkCtx(["mcp:read"]),
    );
    expect(r).toBeNull();
  });

  it("ping responds {}", async () => {
    const r = await dispatch(
      { jsonrpc: "2.0", id: 99, method: "ping" },
      mkCtx(["mcp:read"]),
    ) as JsonRpcSuccess;
    expect(r.result).toEqual({});
  });
});

describe("MCP — tools/list", () => {
  it("includes 5 admin tools + 5 per-collection tools", async () => {
    await seedPostsCollection();
    const r = await dispatch(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      mkCtx(["mcp:read"]),
    ) as JsonRpcSuccess;
    const result = r.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("vaultbase.list_collections");
    expect(names).toContain("vaultbase.describe_collection");
    expect(names).toContain("vaultbase.read_logs");
    expect(names).toContain("vaultbase.read_audit_log");
    expect(names).toContain("vaultbase.list_users");
    expect(names).toContain("vaultbase.list_posts");
    expect(names).toContain("vaultbase.get_posts");
    expect(names).toContain("vaultbase.create_posts");
    expect(names).toContain("vaultbase.update_posts");
    expect(names).toContain("vaultbase.delete_posts");
  });

  it("read-only registry omits create/update/delete tools", async () => {
    await seedPostsCollection();
    const r = await dispatch(
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      mkCtx(["mcp:write"]),
      /* readOnly */ true,
    ) as JsonRpcSuccess;
    const result = r.result as { tools: Array<{ name: string }> };
    const names = result.tools.map((t) => t.name);
    expect(names).toContain("vaultbase.list_posts");
    expect(names).toContain("vaultbase.get_posts");
    expect(names).not.toContain("vaultbase.create_posts");
    expect(names).not.toContain("vaultbase.update_posts");
    expect(names).not.toContain("vaultbase.delete_posts");
  });
});

describe("MCP — tools/call", () => {
  it("list_collections returns the seeded collection", async () => {
    await seedPostsCollection();
    const r = await dispatch(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "vaultbase.list_collections" } },
      mkCtx(["mcp:read"]),
    ) as JsonRpcSuccess;
    const result = r.result as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    const cols = JSON.parse(text) as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "posts")).toBe(true);
  });

  it("describe_collection returns full schema", async () => {
    await seedPostsCollection();
    const r = await dispatch(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "vaultbase.describe_collection", arguments: { name: "posts" } } },
      mkCtx(["mcp:read"]),
    ) as JsonRpcSuccess;
    const text = ((r.result as CallToolResult).content[0] as { text: string }).text;
    const desc = JSON.parse(text) as { name: string; type: string; fields: FieldDef[] };
    expect(desc.name).toBe("posts");
    expect(desc.type).toBe("base");
    expect(desc.fields.find((f) => f.name === "title")).toBeTruthy();
  });

  it("create_posts requires mcp:write scope; mcp:read is denied", async () => {
    await seedPostsCollection();
    const r = await dispatch(
      {
        jsonrpc: "2.0", id: 6,
        method: "tools/call",
        params: { name: "vaultbase.create_posts", arguments: { data: { title: "hi" } } },
      },
      mkCtx(["mcp:read"]), // read-only token tries to write
    ) as JsonRpcSuccess;
    const result = r.result as CallToolResult;
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Permission denied");
    expect(text).toContain("mcp:write");
  });

  it("create_posts succeeds with mcp:write + returns the new record", async () => {
    await seedPostsCollection();
    const r = await dispatch(
      {
        jsonrpc: "2.0", id: 7,
        method: "tools/call",
        params: { name: "vaultbase.create_posts", arguments: { data: { title: "hello", status: "live" } } },
      },
      mkCtx(["mcp:write"]),
    ) as JsonRpcSuccess;
    const result = r.result as CallToolResult;
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    const rec = JSON.parse(text) as { id: string; title: string; status: string };
    expect(rec.id).toBeTruthy();
    expect(rec.title).toBe("hello");
    expect(rec.status).toBe("live");
  });

  it("list_posts returns rows + wraps them in <user-data>", async () => {
    await seedPostsCollection();
    await createRecord("posts", { title: "alpha", status: "live" }, null);
    await createRecord("posts", { title: "beta",  status: "draft" }, null);
    const r = await dispatch(
      {
        jsonrpc: "2.0", id: 8,
        method: "tools/call",
        params: { name: "vaultbase.list_posts", arguments: {} },
      },
      mkCtx(["mcp:read"]),
    ) as JsonRpcSuccess;
    const text = ((r.result as CallToolResult).content[0] as { text: string }).text;
    expect(text).toContain("<user-data");
    expect(text).toContain("</user-data>");
    expect(text).toContain("alpha");
    expect(text).toContain("beta");
  });

  it("update + delete round-trip works with mcp:write", async () => {
    await seedPostsCollection();
    const created = await createRecord("posts", { title: "x", status: "draft" }, null);
    // update
    const upd = await dispatch(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "vaultbase.update_posts", arguments: { id: created.id, data: { title: "x renamed" } } } },
      mkCtx(["mcp:write"]),
    ) as JsonRpcSuccess;
    expect((upd.result as CallToolResult).isError).toBeFalsy();
    // delete
    const del = await dispatch(
      { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "vaultbase.delete_posts", arguments: { id: created.id } } },
      mkCtx(["mcp:write"]),
    ) as JsonRpcSuccess;
    expect((del.result as CallToolResult).isError).toBeFalsy();
  });

  it("admin scope satisfies any required scope", async () => {
    await seedPostsCollection();
    const r = await dispatch(
      { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "vaultbase.create_posts", arguments: { data: { title: "via-admin" } } } },
      mkCtx(["admin"]),
    ) as JsonRpcSuccess;
    expect((r.result as CallToolResult).isError).toBeFalsy();
  });

  it("unknown tool name returns a tool-error CallToolResult, not an RPC error", async () => {
    const r = await dispatch(
      { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "vaultbase.nope" } },
      mkCtx(["mcp:read"]),
    ) as JsonRpcSuccess;
    const result = r.result as CallToolResult;
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("not found");
  });

  it("invalid params returns InvalidParams RPC error", async () => {
    const r = await dispatch(
      { jsonrpc: "2.0", id: 13, method: "tools/call", params: { /* missing name */ } },
      mkCtx(["mcp:read"]),
    ) as JsonRpcError;
    expect(r.error.code).toBe(-32602);
  });
});

describe("MCP — unknown method", () => {
  it("returns MethodNotFound for unsupported methods", async () => {
    const r = await dispatch(
      { jsonrpc: "2.0", id: 14, method: "sampling/createMessage" },
      mkCtx(["mcp:read"]),
    ) as JsonRpcError;
    expect(r.error.code).toBe(-32601);
    expect(r.error.message).toContain("sampling/createMessage");
  });
});

// ── Phase 2 — admin-write tools ──────────────────────────────────────────

describe("MCP — Phase 2 admin tools", () => {
  it("create_collection mints a new collection", async () => {
    const r = await dispatch(
      {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: {
          name: "vaultbase.create_collection",
          arguments: {
            name: "tasks",
            type: "base",
            fields: [
              { name: "title", type: "text", required: true },
              { name: "done",  type: "bool" },
            ],
          },
        },
      },
      mkCtx(["mcp:admin"]),
    ) as JsonRpcSuccess;
    const result = r.result as CallToolResult;
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    const col = JSON.parse(text) as { name: string; type: string };
    expect(col.name).toBe("tasks");
    expect(col.type).toBe("base");
  });

  it("alter_collection updates rules", async () => {
    await seedPostsCollection();
    const r = await dispatch(
      {
        jsonrpc: "2.0", id: 101, method: "tools/call",
        params: {
          name: "vaultbase.alter_collection",
          arguments: { id_or_name: "posts", view_rule: "" },
        },
      },
      mkCtx(["mcp:admin"]),
    ) as JsonRpcSuccess;
    const result = r.result as CallToolResult;
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    const col = JSON.parse(text) as { view_rule: string };
    expect(col.view_rule).toBe("");
  });

  it("create_hook + list_hooks round-trip", async () => {
    const create = await dispatch(
      {
        jsonrpc: "2.0", id: 102, method: "tools/call",
        params: {
          name: "vaultbase.create_hook",
          arguments: {
            name: "test-hook",
            collection_name: "posts",
            event: "before_create",
            code: "// no-op",
          },
        },
      },
      mkCtx(["mcp:admin"]),
    ) as JsonRpcSuccess;
    expect((create.result as CallToolResult).isError).toBeFalsy();

    const list = await dispatch(
      { jsonrpc: "2.0", id: 103, method: "tools/call", params: { name: "vaultbase.list_hooks" } },
      mkCtx(["mcp:read"]),
    ) as JsonRpcSuccess;
    const text = ((list.result as CallToolResult).content[0] as { text: string }).text;
    const hooks = JSON.parse(text) as Array<{ name: string }>;
    expect(hooks.find((h) => h.name === "test-hook")).toBeTruthy();
  });

  it("create_job validates cron expression", async () => {
    const r = await dispatch(
      {
        jsonrpc: "2.0", id: 104, method: "tools/call",
        params: {
          name: "vaultbase.create_job",
          arguments: { name: "bad", cron: "not-a-cron", code: "// noop" },
        },
      },
      mkCtx(["mcp:admin"]),
    ) as JsonRpcSuccess;
    const result = r.result as CallToolResult;
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("invalid cron");
  });

  it("update_setting + get_setting round-trip", async () => {
    const set = await dispatch(
      {
        jsonrpc: "2.0", id: 105, method: "tools/call",
        params: { name: "vaultbase.update_setting", arguments: { key: "test.foo", value: "bar" } },
      },
      mkCtx(["mcp:admin"]),
    ) as JsonRpcSuccess;
    expect((set.result as CallToolResult).isError).toBeFalsy();

    const get = await dispatch(
      {
        jsonrpc: "2.0", id: 106, method: "tools/call",
        params: { name: "vaultbase.get_setting", arguments: { key: "test.foo" } },
      },
      mkCtx(["mcp:read"]),
    ) as JsonRpcSuccess;
    const text = ((get.result as CallToolResult).content[0] as { text: string }).text;
    const got = JSON.parse(text) as { value: string };
    expect(got.value).toBe("bar");
  });

  it("run_sql refuses non-SELECT without allow_write", async () => {
    const r = await dispatch(
      {
        jsonrpc: "2.0", id: 107, method: "tools/call",
        params: {
          name: "vaultbase.run_sql",
          arguments: { query: "DELETE FROM vaultbase_admin" },
        },
      },
      mkCtx(["mcp:sql"]),
    ) as JsonRpcSuccess;
    const result = r.result as CallToolResult;
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("allow_write");
  });

  it("run_sql executes a SELECT and bounds rows to 100", async () => {
    const r = await dispatch(
      {
        jsonrpc: "2.0", id: 108, method: "tools/call",
        params: {
          name: "vaultbase.run_sql",
          arguments: { query: "SELECT 1 AS one" },
        },
      },
      mkCtx(["mcp:sql"]),
    ) as JsonRpcSuccess;
    const result = r.result as CallToolResult;
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    const data = JSON.parse(text) as { rowCount: number; rows: Array<{ one: number }> };
    expect(data.rowCount).toBe(1);
    expect(data.rows[0]?.one).toBe(1);
  });

  it("seed creates the requested number of records", async () => {
    await seedPostsCollection();
    const r = await dispatch(
      {
        jsonrpc: "2.0", id: 109, method: "tools/call",
        params: {
          name: "vaultbase.seed",
          arguments: { collection: "posts", count: 5 },
        },
      },
      mkCtx(["mcp:write"]),
    ) as JsonRpcSuccess;
    const result = r.result as CallToolResult;
    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    const data = JSON.parse(text) as { created: number };
    expect(data.created).toBe(5);
  });

  it("Phase 2 admin tools require mcp:admin scope", async () => {
    await seedPostsCollection();
    const r = await dispatch(
      {
        jsonrpc: "2.0", id: 110, method: "tools/call",
        params: {
          name: "vaultbase.delete_collection",
          arguments: { id_or_name: "posts" },
        },
      },
      mkCtx(["mcp:write"]), // not admin
    ) as JsonRpcSuccess;
    const result = r.result as CallToolResult;
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Permission denied");
  });
});

// ── Phase 3 — Resources + Prompts ────────────────────────────────────────

describe("MCP Phase 3 — Resources", () => {
  it("initialize advertises resources + prompts capabilities", async () => {
    const r = await dispatch(
      { jsonrpc: "2.0", id: 200, method: "initialize", params: {} },
      mkCtx(["mcp:read"]),
    ) as JsonRpcSuccess;
    const caps = (r.result as { capabilities: { resources?: unknown; prompts?: unknown } }).capabilities;
    expect(caps.resources).toBeTruthy();
    expect(caps.prompts).toBeTruthy();
  });

  it("resources/list returns the static set", async () => {
    const r = await dispatch(
      { jsonrpc: "2.0", id: 201, method: "resources/list" },
      mkCtx(["mcp:read"]),
    ) as JsonRpcSuccess;
    const result = r.result as { resources: Array<{ uri: string }> };
    const uris = result.resources.map((x) => x.uri);
    expect(uris).toContain("vaultbase://collections");
    expect(uris).toContain("vaultbase://audit/recent");
    expect(uris).toContain("vaultbase://settings");
    expect(uris).toContain("vaultbase://server/info");
  });

  it("resources/templates/list includes record + collection + logs templates", async () => {
    const r = await dispatch(
      { jsonrpc: "2.0", id: 202, method: "resources/templates/list" },
      mkCtx(["mcp:read"]),
    ) as JsonRpcSuccess;
    const templates = (r.result as { resourceTemplates: Array<{ uriTemplate: string }> }).resourceTemplates;
    const tpls = templates.map((t) => t.uriTemplate);
    expect(tpls).toContain("vaultbase://collection/{name}");
    expect(tpls).toContain("vaultbase://record/{collection}/{id}");
    expect(tpls).toContain("vaultbase://logs/{date}");
  });

  it("resources/read vaultbase://collections returns JSON contents", async () => {
    await seedPostsCollection();
    const r = await dispatch(
      { jsonrpc: "2.0", id: 203, method: "resources/read", params: { uri: "vaultbase://collections" } },
      mkCtx(["mcp:read"]),
    ) as JsonRpcSuccess;
    const contents = (r.result as { contents: Array<{ uri: string; mimeType: string; text: string }> }).contents;
    expect(contents).toHaveLength(1);
    expect(contents[0]!.uri).toBe("vaultbase://collections");
    expect(contents[0]!.mimeType).toBe("application/json");
    const data = JSON.parse(contents[0]!.text) as Array<{ name: string }>;
    expect(data.some((c) => c.name === "posts")).toBe(true);
  });

  it("resources/read vaultbase://collection/{name} returns the schema", async () => {
    await seedPostsCollection();
    const r = await dispatch(
      { jsonrpc: "2.0", id: 204, method: "resources/read", params: { uri: "vaultbase://collection/posts" } },
      mkCtx(["mcp:read"]),
    ) as JsonRpcSuccess;
    const text = (r.result as { contents: Array<{ text: string }> }).contents[0]!.text;
    const data = JSON.parse(text) as { name: string; fields: Array<{ name: string }> };
    expect(data.name).toBe("posts");
    expect(data.fields.some((f) => f.name === "title")).toBe(true);
  });

  it("resources/read vaultbase://record/{col}/{id} returns the record", async () => {
    await seedPostsCollection();
    const created = await createRecord("posts", { title: "hello", status: "draft" });
    const r = await dispatch(
      { jsonrpc: "2.0", id: 205, method: "resources/read", params: { uri: `vaultbase://record/posts/${created.id}` } },
      mkCtx(["mcp:read"]),
    ) as JsonRpcSuccess;
    const text = (r.result as { contents: Array<{ text: string }> }).contents[0]!.text;
    const rec = JSON.parse(text) as { title: string };
    expect(rec.title).toBe("hello");
  });

  it("resources/read with bad URI fails with InvalidParams", async () => {
    const r = await dispatch(
      { jsonrpc: "2.0", id: 206, method: "resources/read", params: { uri: "vaultbase://nope" } },
      mkCtx(["mcp:read"]),
    ) as JsonRpcError;
    expect(r.error.code).toBe(-32602);
  });

  it("resources/read missing uri fails with InvalidParams", async () => {
    const r = await dispatch(
      { jsonrpc: "2.0", id: 207, method: "resources/read", params: {} },
      mkCtx(["mcp:read"]),
    ) as JsonRpcError;
    expect(r.error.code).toBe(-32602);
  });

  it("resources/read denies token without mcp:read scope", async () => {
    const r = await dispatch(
      { jsonrpc: "2.0", id: 208, method: "resources/read", params: { uri: "vaultbase://collections" } },
      mkCtx(["mcp:write"]),
    ) as JsonRpcError;
    expect(r.error.code).toBe(-32602);
    expect(r.error.message).toContain("mcp:read");
  });
});

describe("MCP Phase 3 — Prompts", () => {
  it("prompts/list returns the starter set", async () => {
    const r = await dispatch(
      { jsonrpc: "2.0", id: 300, method: "prompts/list" },
      mkCtx(["mcp:read"]),
    ) as JsonRpcSuccess;
    const names = (r.result as { prompts: Array<{ name: string }> }).prompts.map((p) => p.name);
    expect(names).toContain("design-collection");
    expect(names).toContain("debug-request");
    expect(names).toContain("audit-rules");
    expect(names).toContain("import-from-pocketbase");
    expect(names).toContain("optimize-schema");
  });

  it("prompts/get builds a templated message", async () => {
    const r = await dispatch(
      {
        jsonrpc: "2.0", id: 301, method: "prompts/get",
        params: { name: "design-collection", arguments: { topic: "blog posts" } },
      },
      mkCtx(["mcp:read"]),
    ) as JsonRpcSuccess;
    const result = r.result as { messages: Array<{ role: string; content: { text: string } }> };
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe("user");
    expect(result.messages[0]!.content.text).toContain("blog posts");
  });

  it("prompts/get rejects missing required argument", async () => {
    const r = await dispatch(
      {
        jsonrpc: "2.0", id: 302, method: "prompts/get",
        params: { name: "design-collection", arguments: {} },
      },
      mkCtx(["mcp:read"]),
    ) as JsonRpcError;
    expect(r.error.code).toBe(-32602);
    expect(r.error.message).toContain("topic");
  });

  it("prompts/get unknown name fails", async () => {
    const r = await dispatch(
      { jsonrpc: "2.0", id: 303, method: "prompts/get", params: { name: "nope" } },
      mkCtx(["mcp:read"]),
    ) as JsonRpcError;
    expect(r.error.code).toBe(-32602);
  });
});
