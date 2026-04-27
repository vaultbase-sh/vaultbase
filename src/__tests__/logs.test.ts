import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setLogsDir } from "../core/file-logger.ts";
import { insertLog, listLogs } from "../api/logs.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-logs-"));
  setLogsDir(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("insertLog", () => {
  it("appends entry to file", async () => {
    await insertLog("GET", "/api/collections", 200, 4, null, null);
    const result = await listLogs({ page: 1, perPage: 10, method: "all", status: "all", includeAdmin: false });
    expect(result.totalItems).toBe(1);
    expect(result.data[0]!.method).toBe("GET");
    expect(result.data[0]!.status).toBe(200);
    expect(result.data[0]!.duration_ms).toBe(4);
  });

  it("stores path", async () => {
    await insertLog("GET", "/api/posts", 200, 2, null, null);
    const result = await listLogs({ page: 1, perPage: 10, method: "all", status: "all", includeAdmin: false });
    expect(result.data[0]!.path).toBe("/api/posts");
  });
});

describe("listLogs", () => {
  it("returns paginated results", async () => {
    for (let i = 0; i < 5; i++) {
      await insertLog("GET", "/api/test", 200, i, null, null);
    }
    const result = await listLogs({ page: 1, perPage: 3, method: "all", status: "all", includeAdmin: false });
    expect(result.data).toHaveLength(3);
    expect(result.totalItems).toBe(5);
    expect(result.totalPages).toBe(2);
  });

  it("hides admin paths by default", async () => {
    await insertLog("POST", "/api/admin/auth/login", 200, 5, null, null);
    await insertLog("GET", "/api/collections", 200, 2, null, null);
    const hidden = await listLogs({ page: 1, perPage: 10, method: "all", status: "all", includeAdmin: false });
    expect(hidden.totalItems).toBe(1);
    const visible = await listLogs({ page: 1, perPage: 10, method: "all", status: "all", includeAdmin: true });
    expect(visible.totalItems).toBe(2);
  });

  it("filters by method", async () => {
    await insertLog("GET", "/api/a", 200, 1, null, null);
    await insertLog("POST", "/api/b", 201, 2, null, null);
    const result = await listLogs({ page: 1, perPage: 10, method: "GET", status: "all", includeAdmin: false });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.method).toBe("GET");
  });

  it("filters by 4xx status", async () => {
    await insertLog("GET", "/api/a", 200, 1, null, null);
    await insertLog("GET", "/api/b", 404, 2, null, null);
    await insertLog("POST", "/api/c", 422, 3, null, null);
    const result = await listLogs({ page: 1, perPage: 10, method: "all", status: "4xx", includeAdmin: false });
    expect(result.data).toHaveLength(2);
    expect(result.data.every((r) => r.status >= 400 && r.status < 500)).toBe(true);
  });
});
