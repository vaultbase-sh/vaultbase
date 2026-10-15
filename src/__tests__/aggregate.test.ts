/**
 * GET /:collection/_aggregate — count / sum / avg / min / max, groupBy with
 * time buckets, and the same scoping as a list (filter, search, list rule).
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { initDb, closeDb, getDb } from "../db/client.ts";
import { db } from "../db/index.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import { admin } from "../db/schema.ts";
import { createCollection, type FieldDef } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { signAuthToken } from "../core/sec.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import { onSqlite } from "./_helpers.ts";

const SECRET = "test-secret-aggregate";
let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "vaultbase-agg-"));
  setLogsDir(tmpDir);
  await initDb(":memory:");
  await runMigrations();
  await getDb().insert(admin).values({ id: "a1", email: "a@test.local", password_hash: "x", password_reset_at: 0, created_at: 0 });
});

afterEach(async () => {
  await closeDb();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows */ }
});

const FIELDS: FieldDef[] = [
  { name: "status", type: "text", options: { searchable: true } },
  { name: "amount", type: "number" },
  { name: "paid", type: "bool" },
  { name: "secret", type: "text", options: { encrypted: true } },
  { name: "tags", type: "select", options: { multiple: true, values: ["a", "b"] } },
];

async function seed(listRule: string | null = null) {
  await createCollection({
    name: "orders", type: "base", fields: JSON.stringify(FIELDS),
    list_rule: listRule, view_rule: null, create_rule: null, update_rule: null, delete_rule: null,
  });
  const rows: Array<[string, number, boolean, number]> = [
    ["open", 10, false, Date.UTC(2026, 0, 15) / 1000],
    ["open", 30, true, Date.UTC(2026, 0, 20) / 1000],
    ["closed", 5, true, Date.UTC(2026, 1, 3) / 1000],
    ["closed", 15, true, Date.UTC(2026, 1, 9) / 1000],
    ["void", 100, false, Date.UTC(2026, 2, 1) / 1000],
  ];
  for (const [status, amount, paid, ts] of rows) {
    const r = await createRecord("orders", { status, amount, paid });
    await db.run(`UPDATE vb_orders SET created_at = ? WHERE id = ?`, [ts, String(r.id)]);
  }
}

async function agg(qs: string, token?: string) {
  const res = await makeRecordsPlugin(SECRET).handle(new Request(`http://localhost/orders/_aggregate?${qs}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }));
  return { status: res.status, body: await res.json() as { data: Array<Record<string, unknown>>; error?: string } };
}

describe("aggregates", () => {
  it("counts everything by default", async () => {
    await seed();
    expect((await agg("")).body.data).toEqual([{ count: 5 }]);
  });

  it("computes sum, avg, min, max", async () => {
    await seed();
    const { body } = await agg("agg=count,sum(amount),avg(amount),min(amount),max(amount)");
    expect(body.data).toEqual([{ count: 5, sum_amount: 160, avg_amount: 32, min_amount: 5, max_amount: 100 }]);
  });

  it("groups, sorts biggest first by default and honors sort and limit", async () => {
    await seed();
    const byCount = (await agg("agg=count,sum(amount)&groupBy=status")).body.data;
    expect(byCount.at(-1)).toEqual({ status: "void", count: 1, sum_amount: 100 });
    expect((await agg("agg=count,sum(amount)&groupBy=status&sort=status")).body.data).toEqual([
      { status: "closed", count: 2, sum_amount: 20 },
      { status: "open", count: 2, sum_amount: 40 },
      { status: "void", count: 1, sum_amount: 100 },
    ]);
    const sorted = (await agg("agg=sum(amount)&groupBy=status&sort=-sum_amount&limit=2")).body.data;
    expect(sorted).toEqual([{ status: "void", sum_amount: 100 }, { status: "open", sum_amount: 40 }]);
  });

  it("buckets dates and returns booleans as booleans", async () => {
    await seed();
    expect((await agg("groupBy=created:month")).body.data).toEqual([
      { created: "2026-01", count: 2 },
      { created: "2026-02", count: 2 },
      { created: "2026-03", count: 1 },
    ]);
    const paid = (await agg("groupBy=paid&sort=paid")).body.data;
    expect(paid).toEqual([{ paid: false, count: 2 }, { paid: true, count: 3 }]);
  });

  it("applies filter and search", async () => {
    await seed();
    expect((await agg("agg=sum(amount)&filter=paid%20%3D%20true")).body.data).toEqual([{ sum_amount: 50 }]);
    if (onSqlite) expect((await agg("search=open")).body.data).toEqual([{ count: 2 }]);
  });
});

describe("scoping and validation", () => {
  it("applies the list rule; admin-only lists are 403 for others", async () => {
    await seed(`status != "void"`);
    expect((await agg("agg=sum(amount)")).body.data).toEqual([{ sum_amount: 60 }]);
    const { token } = await signAuthToken({ payload: { id: "a1" }, audience: "admin", expiresInSeconds: 60, jwtSecret: SECRET });
    expect((await agg("agg=sum(amount)", token)).body.data).toEqual([{ sum_amount: 160 }]);
  });

  it("is 403 for an admin-only collection", async () => {
    await seed("");
    expect((await agg("")).status).toBe(403);
  });

  it("refuses unknown, encrypted, multi-value and non-numeric fields", async () => {
    await seed();
    for (const qs of [
      "agg=sum(nope)", "groupBy=nope", "agg=sum(status)", "groupBy=secret", "groupBy=tags",
      "agg=max(secret)", "groupBy=status:month", "groupBy=created:fortnight", "agg=sum",
      "agg=count;drop", "sort=amount", "groupBy=a,b,c,d", `groupBy=status"--`,
    ]) {
      const r = await agg(qs);
      expect([qs, r.status]).toEqual([qs, 400]);
    }
  });
});
