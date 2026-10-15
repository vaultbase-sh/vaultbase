import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection, _resetCollectionCache } from "../core/collections.ts";
import { createRecord, deleteRecord, updateRecord } from "../core/records.ts";
import { cosineSimilarity } from "../core/vector.ts";
import { _vectorCacheStats, _resetVectorCache } from "../core/vector-cache.ts";
import { makeRecordsPlugin } from "../api/records.ts";

// nearVector used to load up to 10k candidate records and JSON-parse every
// stored vector on every search (158 ms at 10k x 384 dims, blocking the event
// loop). Parsed vectors are now cached as Float32Arrays keyed by record +
// updated_at; only new / changed rows are parsed.

const DIMS = 8;
const SECRET = "test-secret-vector-cache";
const vec = (seed: number) => Array.from({ length: DIMS }, (_, i) => Math.sin(seed * 7.3 + i * 1.7));

async function setup(listRule: string | null = null) {
  await createCollection({
    name: "docs",
    fields: JSON.stringify([
      { name: "owner", type: "text" },
      { name: "emb", type: "vector", options: { dimensions: DIMS } },
    ]),
    list_rule: listRule,
  });
}

async function search(query: number[], limit = 5): Promise<Array<{ id: string; _score: number }>> {
  const q = encodeURIComponent(JSON.stringify(query));
  const res = await makeRecordsPlugin(SECRET).handle(
    new Request(`http://localhost/docs?nearVector=${q}&nearVectorField=emb&nearLimit=${limit}`),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: Array<{ id: string; _score: number }> }).data;
}

beforeEach(async () => {
  await initDb(":memory:");
  await runMigrations();
  _resetVectorCache();
});

afterEach(async () => {
  _resetCollectionCache();
  await closeDb();
});

describe("vector search with parsed-vector cache", () => {
  it("returns the same ranking as a brute-force cosine search", async () => {
    await setup();
    const rows: Array<{ id: string; v: number[] }> = [];
    for (let i = 0; i < 40; i++) {
      const v = vec(i);
      rows.push({ id: (await createRecord("docs", { owner: "x", emb: v })).id, v });
    }
    const q = vec(1000);
    const expected = rows
      .map((r) => ({ id: r.id, s: cosineSimilarity(q, r.v) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 5)
      .map((r) => r.id);
    expect((await search(q)).map((r) => r.id)).toEqual(expected);
  });

  it("nearLimit above 25 returns that many matches, in rank order", async () => {
    // The top-K were loaded with one `id = … || …` filter, which the parser
    // refuses past 50 operands, so nearLimit > 25 answered 400.
    await setup();
    const rows: Array<{ id: string; v: number[] }> = [];
    for (let i = 0; i < 60; i++) {
      const v = vec(i);
      rows.push({ id: (await createRecord("docs", { owner: "x", emb: v })).id, v });
    }
    const q = vec(500);
    const expected = rows
      .map((r) => ({ id: r.id, s: cosineSimilarity(q, r.v) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 45)
      .map((r) => r.id);
    expect((await search(q, 45)).map((r) => r.id)).toEqual(expected);
  });

  it("a repeat search parses no vectors", async () => {
    await setup();
    for (let i = 0; i < 20; i++) await createRecord("docs", { owner: "x", emb: vec(i) });
    await search(vec(1));
    const before = _vectorCacheStats().parsed;
    await search(vec(2));
    expect(_vectorCacheStats().parsed - before).toBe(0);
  });

  it("an update within the same second is used immediately", async () => {
    await setup();
    const a = await createRecord("docs", { owner: "x", emb: vec(1) });
    await createRecord("docs", { owner: "x", emb: vec(2) });
    const target = vec(99);
    await search(target); // warm the cache
    await updateRecord("docs", a.id, { emb: target });
    const top = await search(target, 1);
    expect(top[0]?.id).toBe(a.id);
    expect(top[0]?._score).toBeCloseTo(1, 5);
  });

  it("never returns deleted records", async () => {
    await setup();
    const a = await createRecord("docs", { owner: "x", emb: vec(5) });
    await createRecord("docs", { owner: "x", emb: vec(6) });
    await search(vec(5));
    await deleteRecord("docs", a.id);
    expect((await search(vec(5))).map((r) => r.id)).not.toContain(a.id);
  });

  it("still applies the list rule to candidates", async () => {
    await setup('owner = "visible"');
    const hidden = await createRecord("docs", { owner: "hidden", emb: vec(7) });
    await createRecord("docs", { owner: "visible", emb: vec(8) });
    const ids = (await search(vec(7), 10)).map((r) => r.id);
    expect(ids).not.toContain(hidden.id);
    expect(ids.length).toBe(1);
  });
});
