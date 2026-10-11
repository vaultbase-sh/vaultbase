import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection } from "../core/collections.ts";
import { createRecord, listRecords } from "../core/records.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { createPublicCollection } from "./_helpers.ts";

// page / perPage reached SQL unchecked: perPage=-1 became LIMIT -1 (whole
// table), perPage=0 gave totalPages=Infinity, page=abc bound NaN to OFFSET
// and 500'd.

const SECRET = "test-secret-paging";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
  await createPublicCollection({ name: "items", fields: JSON.stringify([{ name: "n", type: "number" }]) });
  for (let i = 0; i < 40; i++) await createRecord("items", { n: i });
});

afterEach(() => closeDb());

describe("listRecords paging guards", () => {
  it("negative perPage falls back to the default page size, not the whole table", async () => {
    const r = await listRecords("items", { perPage: -1 });
    expect(r.data.length).toBe(30);
    expect(r.perPage).toBe(30);
    expect(r.totalPages).toBe(2);
  });

  it("perPage 0 falls back to the default (no Infinity pages)", async () => {
    const r = await listRecords("items", { perPage: 0 });
    expect(r.perPage).toBe(30);
    expect(Number.isFinite(r.totalPages)).toBe(true);
  });

  it("NaN / zero / negative page falls back to page 1", async () => {
    for (const page of [NaN, 0, -3]) {
      const r = await listRecords("items", { page, perPage: 10 });
      expect(r.page).toBe(1);
      expect(r.data.length).toBe(10);
    }
  });
});

describe("GET /:collection paging", () => {
  async function get(qs: string) {
    const res = await makeRecordsPlugin(SECRET).handle(new Request(`http://localhost/items?${qs}`));
    return { status: res.status, body: (await res.json()) as { page: number; perPage: number; data: unknown[] } };
  }

  it("page=abc → 200, page 1", async () => {
    const r = await get("page=abc");
    expect(r.status).toBe(200);
    expect(r.body.page).toBe(1);
  });

  it("perPage is capped at 500", async () => {
    const r = await get("perPage=100000");
    expect(r.status).toBe(200);
    expect(r.body.perPage).toBe(500);
  });

  it("perPage=-1 → default page size", async () => {
    const r = await get("perPage=-1");
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBe(30);
  });
});
