import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setLogsDir, appendLogEntry, type LogEntry } from "../core/file-logger.ts";
import { listLogs } from "../api/logs.ts";

let tmpDir: string;

function mk(overrides: Partial<LogEntry>): LogEntry {
  const tsSec = Math.floor(Date.now() / 1000);
  return {
    id: crypto.randomUUID(),
    ts: new Date(tsSec * 1000).toISOString(),
    created_at: tsSec,
    method: "GET",
    path: "/api/posts",
    status: 200,
    duration_ms: 1,
    ip: null,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-logs-rule-"));
  setLogsDir(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("listLogs ruleOutcome filter", () => {
  beforeEach(() => {
    // No rules
    appendLogEntry(mk({ path: "/api/health" }));
    // Allow
    appendLogEntry(mk({ path: "/api/posts/p1", rules: [
      { rule: "view_rule", collection: "posts", expression: null, outcome: "allow", reason: "public" },
    ] }));
    // Deny
    appendLogEntry(mk({ path: "/api/posts/p2", status: 403, rules: [
      { rule: "view_rule", collection: "posts", expression: "owner = @request.auth.id", outcome: "deny", reason: "rule failed" },
    ] }));
    // Filter
    appendLogEntry(mk({ path: "/api/posts", rules: [
      { rule: "list_rule", collection: "posts", expression: "owner = @request.auth.id", outcome: "filter", reason: "applied as SQL filter" },
    ] }));
  });

  async function listWith(filter: "all" | "any" | "allow" | "deny" | "filter") {
    return await listLogs({
      page: 1, perPage: 100, method: "all", status: "all",
      includeAdmin: true, ruleOutcome: filter,
    });
  }

  it("default 'all' returns every entry", async () => {
    const r = await listWith("all");
    expect(r.totalItems).toBe(4);
  });

  it("'any' returns only entries with any rule eval", async () => {
    const r = await listWith("any");
    expect(r.totalItems).toBe(3);
    expect(r.data.every((e) => (e.rules?.length ?? 0) > 0)).toBe(true);
  });

  it("'allow' returns the entry with allow outcome", async () => {
    const r = await listWith("allow");
    expect(r.totalItems).toBe(1);
    expect(r.data[0]!.path).toBe("/api/posts/p1");
  });

  it("'deny' returns the entry with deny outcome", async () => {
    const r = await listWith("deny");
    expect(r.totalItems).toBe(1);
    expect(r.data[0]!.path).toBe("/api/posts/p2");
    expect(r.data[0]!.status).toBe(403);
  });

  it("'filter' returns the list_rule filter entry", async () => {
    const r = await listWith("filter");
    expect(r.totalItems).toBe(1);
    expect(r.data[0]!.path).toBe("/api/posts");
  });
});
