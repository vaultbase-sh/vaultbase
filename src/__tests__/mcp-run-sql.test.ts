/**
 * MCP `vaultbase.run_sql` (Shannon INJ-06): `allow_write` was the caller's
 * own flag, so any `mcp:sql` token could rewrite the database. Reads ran on
 * the server's own connection, where a PRAGMA could change its session state
 * (e.g. make it query-only, failing every later write), and nothing was
 * audited. This drives the tool through the MCP dispatcher against a real
 * database file.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb, getRawClient } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { listAuditEntries } from "../core/audit-log.ts";
import { buildRegistry, createDispatcher } from "../mcp/server.ts";
import type { ToolContext } from "../mcp/tools.ts";
import type { CallToolResult, JsonRpcSuccess } from "../mcp/types.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-mcpsql-"));
  setLogsDir(tmpDir);
  await initDb(join(tmpDir, "data.db"));
  await runMigrations();
  getRawClient().exec("CREATE TABLE t (x INTEGER)");
  getRawClient().exec("INSERT INTO t VALUES (1)");
});

afterEach(async () => {
  await closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

const ctx = (scopes: string[]): ToolContext => ({ tokenId: "tok-1", tokenName: "ci token", scopes, adminId: "a1", adminEmail: "ops@test.local" });

async function runSql(scopes: string[], args: Record<string, unknown>): Promise<CallToolResult> {
  const d = createDispatcher(await buildRegistry(false), ctx(scopes));
  const r = await d.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "vaultbase.run_sql", arguments: args } }) as JsonRpcSuccess;
  return r.result as CallToolResult;
}

const count = () => (getRawClient().query("SELECT count(*) AS n FROM t").get() as { n: number }).n;

describe("MCP run_sql", () => {
  it("allow_write needs mcp:admin; mcp:sql alone can't write", async () => {
    const r = await runSql(["mcp:sql"], { query: "DELETE FROM t", allow_write: true });
    expect(r.isError).toBe(true);
    expect(count()).toBe(1);
  });

  it("an mcp:admin token can still write (legitimate path)", async () => {
    const r = await runSql(["mcp:admin"], { query: "INSERT INTO t VALUES (2)", allow_write: true });
    expect(r.isError).toBeFalsy();
    expect(count()).toBe(2);
  });

  it("reads work for mcp:sql (legitimate path)", async () => {
    const r = await runSql(["mcp:sql"], { query: "SELECT x FROM t" });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse((r.content[0] as { text: string }).text).rows).toEqual([{ x: 1 }]);
  });

  it("a read-mode PRAGMA can't change the server's own connection", async () => {
    // On the server's connection this would make every later write fail.
    await runSql(["mcp:sql"], { query: "PRAGMA query_only = ON" });
    getRawClient().exec("INSERT INTO t VALUES (3)");
    expect(count()).toBe(2);
  });

  it("every call is audited, refused ones included", async () => {
    await runSql(["mcp:sql"], { query: "SELECT 1" });
    await runSql(["mcp:sql"], { query: "DELETE FROM t", allow_write: true });
    const { data: rows } = await listAuditEntries({});
    const actions = rows.map((e) => `${e.action}:${e.status}`);
    expect(actions).toContain("mcp.sql.read:200");
    expect(actions).toContain("mcp.sql.write:403");
    expect(rows.every((e) => e.actor_id === "a1")).toBe(true);
  });
});
