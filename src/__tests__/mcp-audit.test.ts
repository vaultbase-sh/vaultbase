/**
 * Every MCP tool call writes an audit entry, over either transport (both go
 * through the tool registry): only run_sql used to, so "every call audited"
 * wasn't true. The entry names the admin, the token, the tool, its target and
 * the outcome, never the payload.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { listAuditEntries } from "../core/audit-log.ts";
import { buildRegistry } from "../mcp/server.ts";
import type { ToolContext } from "../mcp/tools.ts";

let tmpDir: string;
const ctx = (scopes: string[]): ToolContext => ({ tokenId: "tok-1", tokenName: "ci token", scopes, adminId: "a1", adminEmail: "ops@test.local" });

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-mcp-audit-"));
  setLogsDir(tmpDir);
  await initDb(":memory:");
  await runMigrations();
});

afterEach(async () => {
  await closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

const entries = async () => (await listAuditEntries({})).data.filter((e) => e.action === "mcp.tool");

describe("MCP audit", () => {
  it("records a successful read tool call", async () => {
    const reg = await buildRegistry(false);
    await reg.call("vaultbase.list_collections", {}, ctx(["mcp:read"]));
    const [e] = await entries();
    expect(e).toMatchObject({ actor_id: "a1", actor_email: "ops@test.local", method: "MCP", path: "vaultbase.list_collections", status: 200 });
    expect(e!.summary).toContain("ci token");
  });

  it("records a write with its target and not its payload", async () => {
    const reg = await buildRegistry(false);
    const r = await reg.call("vaultbase.create_collection", { name: "notes", fields: [{ name: "secret_title", type: "text" }] }, ctx(["mcp:read", "mcp:write", "mcp:admin"]));
    expect(r.isError).toBeFalsy();
    const [e] = await entries();
    expect(e).toMatchObject({ path: "vaultbase.create_collection", target: "name=notes", status: 200 });
    expect(JSON.stringify(e)).not.toContain("secret_title");
  });

  it("records refusals and failures with the error", async () => {
    const reg = await buildRegistry(false);
    await reg.call("vaultbase.create_collection", { name: "x" }, ctx(["mcp:read"]));
    await reg.call("vaultbase.describe_collection", { name: "missing" }, ctx(["mcp:read"]));
    await reg.call("vaultbase.nope", {}, ctx(["mcp:read"]));
    const byPath = Object.fromEntries((await entries()).map((e) => [e.path, e]));
    expect(byPath["vaultbase.create_collection"]!.status).toBe(403);
    expect(byPath["vaultbase.create_collection"]!.summary).toContain("Permission denied");
    expect(byPath["vaultbase.describe_collection"]!.status).toBe(400);
    expect(byPath["vaultbase.nope"]!.status).toBe(404);
  });

  it("leaves run_sql to its own, more detailed entry", async () => {
    const reg = await buildRegistry(false);
    await reg.call("vaultbase.run_sql", { query: "SELECT 1" }, ctx(["mcp:read", "mcp:sql"]));
    expect(await entries()).toHaveLength(0);
    expect((await listAuditEntries({})).data.some((e) => e.action === "mcp.sql.read")).toBe(true);
  });
});
