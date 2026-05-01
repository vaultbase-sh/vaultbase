import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { createCollection } from "../core/collections.ts";
import { createRecord } from "../core/records.ts";
import { validateRecord, ValidationError } from "../core/validate.ts";
import { makeRecordsPlugin } from "../api/records.ts";
import {
  cosineSimilarity,
  parseVectorParam,
  topK,
  VectorParseError,
} from "../core/vector.ts";

const SECRET = "test-secret-vector";

beforeEach(async () => {
  initDb(":memory:");
  await runMigrations();
});

afterEach(() => closeDb());

const FIELDS = [
  { name: "title", type: "text" },
  { name: "embedding", type: "vector", required: false, options: { dimensions: 4 } },
];

async function setupCollection() {
  return await createCollection({ name: "docs", fields: JSON.stringify(FIELDS) });
}

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 6);
  });
  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });
  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });
  it("returns 0 when either vector is zero-norm", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 1, 1])).toBe(0);
  });
  it("throws on length mismatch", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow();
  });
});

describe("parseVectorParam", () => {
  it("parses a valid JSON array", () => {
    expect(parseVectorParam("[1,2,3]")).toEqual([1, 2, 3]);
  });
  it("rejects non-array JSON", () => {
    expect(() => parseVectorParam('{"a":1}')).toThrow(VectorParseError);
  });
  it("rejects malformed JSON", () => {
    expect(() => parseVectorParam("not-json")).toThrow(VectorParseError);
  });
  it("rejects non-finite numbers", () => {
    expect(() => parseVectorParam("[1, null, 3]")).toThrow(VectorParseError);
  });
});

describe("topK", () => {
  it("ranks candidates by similarity, descending", () => {
    const ranked = topK({
      query: [1, 0],
      candidates: [
        { id: "a", vector: [0.5, 0.5] },
        { id: "b", vector: [1, 0] },
        { id: "c", vector: [-1, 0] },
      ],
      limit: 3,
    });
    expect(ranked[0]?.id).toBe("b");
    expect(ranked[1]?.id).toBe("a");
    expect(ranked[2]?.id).toBe("c");
  });

  it("respects limit", () => {
    const ranked = topK({
      query: [1, 0],
      candidates: [
        { id: "a", vector: [1, 0] },
        { id: "b", vector: [0, 1] },
      ],
      limit: 1,
    });
    expect(ranked).toHaveLength(1);
  });

  it("filters by minScore", () => {
    const ranked = topK({
      query: [1, 0],
      candidates: [
        { id: "a", vector: [1, 0] },
        { id: "b", vector: [-1, 0] },
      ],
      limit: 5,
      minScore: 0.5,
    });
    expect(ranked.map((m) => m.id)).toEqual(["a"]);
  });

  it("skips candidates with mismatched dimensions", () => {
    const ranked = topK({
      query: [1, 0],
      candidates: [
        { id: "a", vector: [1, 0] },
        { id: "bad", vector: [1, 2, 3] },
      ],
      limit: 5,
    });
    expect(ranked.map((m) => m.id)).toEqual(["a"]);
  });
});

describe("vector field validation", () => {
  it("accepts a number array of the right length", async () => {
    const col = await setupCollection();
    await expect(validateRecord(col, { title: "x", embedding: [1, 2, 3, 4] }, "create")).resolves.toBeUndefined();
  });
  it("rejects wrong length", async () => {
    const col = await setupCollection();
    await expect(validateRecord(col, { title: "x", embedding: [1, 2, 3] }, "create")).rejects.toThrow(ValidationError);
  });
  it("rejects non-numeric elements", async () => {
    const col = await setupCollection();
    await expect(validateRecord(col, { title: "x", embedding: [1, 2, "three", 4] }, "create")).rejects.toThrow(ValidationError);
  });
  it("rejects schema with bad dimensions", async () => {
    const bad = await createCollection({
      name: "bad",
      fields: JSON.stringify([{ name: "v", type: "vector", required: false, options: { dimensions: 0 } }]),
    });
    await expect(validateRecord(bad, { v: [] }, "create")).rejects.toThrow(ValidationError);
  });
});

describe("vector storage round-trip", () => {
  it("persists + decodes a number array", async () => {
    await setupCollection();
    const r = await createRecord("docs", { title: "x", embedding: [0.1, 0.2, 0.3, 0.4] }, null);
    expect(Array.isArray(r["embedding"])).toBe(true);
    expect(r["embedding"]).toEqual([0.1, 0.2, 0.3, 0.4]);
  });
});

describe("nearVector list-API endpoint", () => {
  async function seedFour() {
    await setupCollection();
    await createRecord("docs", { title: "axis-x",   embedding: [1, 0, 0, 0] }, null);
    await createRecord("docs", { title: "near-x",   embedding: [0.9, 0.1, 0, 0] }, null);
    await createRecord("docs", { title: "axis-y",   embedding: [0, 1, 0, 0] }, null);
    await createRecord("docs", { title: "anti-x",   embedding: [-1, 0, 0, 0] }, null);
  }

  it("orders results by cosine similarity to ?nearVector", async () => {
    await seedFour();
    const app = makeRecordsPlugin(SECRET);
    const url = new URL("http://localhost/docs");
    url.searchParams.set("nearVector", "[1,0,0,0]");
    url.searchParams.set("nearVectorField", "embedding");
    url.searchParams.set("nearLimit", "3");
    const res = await app.handle(new Request(url.href));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { title: string; _score: number }[] };
    expect(body.data).toHaveLength(3);
    expect(body.data[0]?.title).toBe("axis-x");
    expect(body.data[1]?.title).toBe("near-x");
    // Third place is whichever is closer between axis-y (score 0) and anti-x (-1).
    expect(body.data[2]?.title).toBe("axis-y");
    expect(body.data[0]?._score).toBeCloseTo(1, 5);
  });

  it("returns 422 when nearVectorField is not a vector field", async () => {
    await setupCollection();
    const app = makeRecordsPlugin(SECRET);
    const url = new URL("http://localhost/docs");
    url.searchParams.set("nearVector", "[1,0,0,0]");
    url.searchParams.set("nearVectorField", "title");
    const res = await app.handle(new Request(url.href));
    expect(res.status).toBe(422);
  });

  it("returns 422 when nearVector length mismatches field dimensions", async () => {
    await setupCollection();
    const app = makeRecordsPlugin(SECRET);
    const url = new URL("http://localhost/docs");
    url.searchParams.set("nearVector", "[1,0,0]"); // 3 elements, field is 4-dim
    url.searchParams.set("nearVectorField", "embedding");
    const res = await app.handle(new Request(url.href));
    expect(res.status).toBe(422);
  });

  it("respects nearMinScore filter", async () => {
    await seedFour();
    const app = makeRecordsPlugin(SECRET);
    const url = new URL("http://localhost/docs");
    url.searchParams.set("nearVector", "[1,0,0,0]");
    url.searchParams.set("nearVectorField", "embedding");
    url.searchParams.set("nearMinScore", "0.5");
    const res = await app.handle(new Request(url.href));
    const body = await res.json() as { data: { title: string }[] };
    // Only axis-x (1.0) and near-x (~0.994) should pass minScore=0.5
    expect(body.data.map((d) => d.title).sort()).toEqual(["axis-x", "near-x"]);
  });
});
