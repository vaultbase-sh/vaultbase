import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { insertLog, listLogs, trimLogs } from "../api/logs.ts";
import { logs } from "../db/schema.ts";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => {
  closeDb();
});

describe("insertLog", () => {
  it("inserts a log row", async () => {
    await insertLog("GET", "/api/collections", 200, 4, null);
    const db = getDb();
    const rows = await db.select().from(logs);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.method).toBe("GET");
    expect(rows[0]!.status).toBe(200);
    expect(rows[0]!.duration_ms).toBe(4);
  });

  it("stores path", async () => {
    await insertLog("GET", "/api/posts", 200, 2, null);
    const db = getDb();
    const rows = await db.select().from(logs);
    expect(rows[0]!.path).toBe("/api/posts");
  });
});

describe("listLogs", () => {
  it("returns paginated results", async () => {
    for (let i = 0; i < 5; i++) {
      await insertLog("GET", "/api/test", 200, i, null);
    }
    const result = await listLogs({ page: 1, perPage: 3, method: "all", status: "all" });
    expect(result.data).toHaveLength(3);
    expect(result.totalItems).toBe(5);
    expect(result.totalPages).toBe(2);
  });

  it("filters by method", async () => {
    await insertLog("GET", "/api/a", 200, 1, null);
    await insertLog("POST", "/api/b", 201, 2, null);
    const result = await listLogs({ page: 1, perPage: 10, method: "GET", status: "all" });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]!.method).toBe("GET");
  });

  it("filters by 4xx status", async () => {
    await insertLog("GET", "/api/a", 200, 1, null);
    await insertLog("GET", "/api/b", 404, 2, null);
    await insertLog("POST", "/api/c", 422, 3, null);
    const result = await listLogs({ page: 1, perPage: 10, method: "all", status: "4xx" });
    expect(result.data).toHaveLength(2);
    expect(result.data.every((r) => r.status >= 400 && r.status < 500)).toBe(true);
  });
});

describe("trimLogs", () => {
  it("trims oldest rows when over limit", async () => {
    for (let i = 0; i < 12; i++) {
      await insertLog("GET", `/api/${i}`, 200, i, null);
    }
    await trimLogs(10, 8);
    const db = getDb();
    const rows = await db.select().from(logs);
    expect(rows.length).toBeLessThanOrEqual(8);
  });
});
