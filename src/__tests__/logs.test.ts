import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { setLogsDir } from "../core/file-logger.ts";
import { insertLog, listLogs, makeLogsPlugin } from "../api/logs.ts";

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

describe("request logging", () => {
  it("logs a refused admin call with its status, not 200", async () => {
    const { default: Elysia } = await import("elysia");
    const { adminGuard } = await import("../api/_admin.ts");
    const app = new Elysia().use(makeLogsPlugin("test-secret-logs")).use(adminGuard("test-secret-logs"))
      .get("/admin/thing", () => ({ ok: true }), { requireAdmin: true });
    const res = await app.handle(new Request("http://localhost/admin/thing"));
    expect(res.status).toBe(401);
    for (let i = 0; i < 50; i++) {
      const r = await listLogs({ page: 1, perPage: 10, method: "all", status: "all", includeAdmin: true });
      if (r.data.length > 0) { expect(r.data[0]!.status).toBe(401); return; }
      await Bun.sleep(10);
    }
    throw new Error("no log entry was written");
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

describe("JSONPath search", () => {
  it("a root filter selects entries ($[?(@.status >= 400)])", async () => {
    const { searchLogs } = await import("../core/file-logger.ts");
    await insertLog("GET", "/api/a", 200, 1, null, null);
    await insertLog("GET", "/api/b", 404, 1, null, null);
    await insertLog("POST", "/api/c", 500, 1, null, null);
    await Bun.sleep(20);
    const r = await searchLogs("$[?(@.status >= 400)]");
    expect(r.matched).toBe(2);
    // A plain path still reads the entry (legitimate path).
    expect((await searchLogs("$.status")).matched).toBe(3);
  });

  it("limit caps the results, not the entries searched", async () => {
    const { searchLogs } = await import("../core/file-logger.ts");
    await insertLog("GET", "/api/old", 500, 1, null, null);
    for (let i = 0; i < 5; i++) await insertLog("GET", `/api/new${i}`, 200, 1, null, null);
    await Bun.sleep(20);
    // The match is older than the newest 3 entries.
    const r = await searchLogs("$[?(@.status >= 500)]", { limit: 3 });
    expect(r.matched).toBe(1);
    expect(r.scanned).toBe(6);
    const all = await searchLogs("$.status", { limit: 2 });
    expect(all.results).toHaveLength(2);
    expect(all.matched).toBe(6);
  });
});

describe("log buffer", () => {
  it("a flush during another flush writes what was buffered meanwhile", async () => {
    const { appendLogEntry, drainLogBuffer, readLogs } = await import("../core/file-logger.ts");
    const entry = (path: string) => ({
      id: crypto.randomUUID(), ts: new Date().toISOString(), created_at: Math.floor(Date.now() / 1000),
      method: "GET", path, status: 200, duration_ms: 1, ip: null,
    });
    appendLogEntry(entry("/api/first"));
    const first = drainLogBuffer();          // in flight
    appendLogEntry(entry("/api/second"));    // buffered meanwhile
    await Promise.all([first, drainLogBuffer()]);
    // On disk now, without another drain (readLogs would drain again).
    const { readdirSync, readFileSync } = await import("fs");
    const onDisk = readdirSync(tmpDir).map((f) => readFileSync(join(tmpDir, f), "utf8")).join("");
    expect(onDisk).toContain("/api/first");
    expect(onDisk).toContain("/api/second");
    void readLogs;
  });
});
