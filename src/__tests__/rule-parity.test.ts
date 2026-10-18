/**
 * The same rule decides the same way for a list (compiled to SQL) and for a
 * single record (evaluated in process). Functions are where the two engines
 * can drift: within the strftime subset both support they must agree, and
 * outside it the single-record check must never allow what the list denies.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDb, initDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { _resetCollectionCache, createCollection, getCollection, updateCollection } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { createServer } from "../server.ts";
import { stopScheduler } from "../core/jobs.ts";
import { stopQueueScheduler } from "../core/queues.ts";
import { stopWebhookDispatcher } from "../core/webhooks.ts";
import { stopUpdateCheckScheduler } from "../core/update-check.ts";
import { _reset as resetRealtime } from "../realtime/manager.ts";
import { onSqlite } from "./_helpers.ts";

let dir: string;
let app: ReturnType<typeof createServer>;
const ids: Record<string, string> = {};
const get = (path: string) => app.handle(new Request(`http://localhost${path}`));

// 2026-03-15 10:20:30 UTC (day 74), 2025-12-31 23:59:59 UTC (day 365), and no date.
const DATES = { mar2026: Date.UTC(2026, 2, 15, 10, 20, 30) / 1000, dec2025: Date.UTC(2025, 11, 31, 23, 59, 59) / 1000, none: null };

async function decisions(rule: string): Promise<{ listed: Set<string>; got: Set<string> }> {
  const col = (await getCollection("events"))!;
  await updateCollection(col.id, { list_rule: rule, view_rule: rule });
  const list = await get("/api/v1/events?perPage=50");
  expect(list.status).toBe(200);
  const listed = new Set(((await list.json()) as { data: Array<{ name: string }> }).data.map((r) => r.name));
  const got = new Set<string>();
  for (const [name, id] of Object.entries(ids)) {
    const res = await get(`/api/v1/events/${id}`);
    if (res.status === 200) got.add(name);
    else expect([403, 404]).toContain(res.status);
  }
  return { listed, got };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "vb-rule-parity-"));
  await initDb(":memory:");
  await runMigrations();
  await createCollection({
    name: "events",
    fields: JSON.stringify([{ name: "name", type: "text" }, { name: "published", type: "date" }, { name: "lon", type: "number" }, { name: "lat", type: "number" }]),
    list_rule: null, view_rule: null,
  });
  for (const [name, published] of Object.entries(DATES)) {
    const r = await createRecord("events", { name, published, ...(name === "none" ? {} : { lon: 35.9, lat: 31.95 }) });
    ids[name] = r.id as string;
  }
  app = createServer({ port: 0, dataDir: dir, dbPath: ":memory:", uploadDir: join(dir, "u"), logsDir: join(dir, "l"), jwtSecret: "test-secret-rule-parity", encryptionKey: undefined });
});

afterAll(async () => {
  stopScheduler(); stopQueueScheduler(); stopWebhookDispatcher(); stopUpdateCheckScheduler();
  resetRealtime();
  _resetCollectionCache();
  await closeDb();
  rmSync(dir, { recursive: true, force: true });
});

describe("rule parity between list and single-record checks", () => {
  // Rule, and the records it should allow.
  const supported: Array<[string, string[]]> = [
    ['strftime("%Y", published, "unixepoch") != "2026"', ["dec2025"]],
    ['strftime("%Y", published, "unixepoch") = "2026"', ["mar2026"]],
    ['strftime("%Y", published, "unixepoch") < "2026"', ["dec2025"]],
    ['strftime("%Y", published, "unixepoch") <= "2026"', ["mar2026", "dec2025"]],
    ['strftime("%m", published, "unixepoch") = "03"', ["mar2026"]],
    ['strftime("%Y-%m-%d %H:%M:%S", published, "unixepoch") = "2026-03-15 10:20:30"', ["mar2026"]],
    ['strftime("%j", published, "unixepoch") > "100"', ["dec2025"]],
    ['strftime("%Y", "2026-03-15") = "2026"', ["mar2026", "dec2025", "none"]],
    ['strftime("%Y", "2026-03-15 10:00:00") != "2026"', []],
    ['geoDistance(lon, lat, 35.9, 31.95) < 1', ["mar2026", "dec2025"]],
    ['geoDistance(lon, lat, 35.9, 31.95) > 1', []],
  ];
  for (const [rule, expected] of supported) {
    it(`agrees on ${rule}`, async () => {
      const { listed, got } = await decisions(rule);
      expect([...listed].sort()).toEqual([...expected].sort());
      expect([...got].sort()).toEqual([...expected].sort());
    });
  }

  // Outside the subset: the single-record check fails closed.
  const unsupported = [
    'strftime("%w", published, "unixepoch") != "9"',
    'strftime("%Y", published) != "1970"',
    'strftime("%Y", published, "localtime") != "1970"',
  ];
  for (const rule of unsupported) {
    it(`never allows more than the list on ${rule}`, async () => {
      const col = (await getCollection("events"))!;
      await updateCollection(col.id, { list_rule: rule, view_rule: rule });
      for (const id of Object.values(ids)) expect((await get(`/api/v1/events/${id}`)).status).not.toBe(200);
      if (onSqlite) {
        const { listed, got } = await decisions(rule);
        for (const name of got) expect(listed.has(name)).toBe(true);
      }
    });
  }
});
