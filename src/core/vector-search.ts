import type { Database } from "bun:sqlite";
import { getRawClient } from "../db/client.ts";
import type { Collection } from "../db/schema.ts";
import { getSchemaVersion, userTableName } from "./collections.ts";
import { compileListWhere, type ListOptions } from "./records.ts";
import { bucketFor, dropVector, enforceBudget, putVector, _resetVectorCache } from "./vector-cache.ts";

/** Same candidate window the list-based search used. */
export const MAX_CANDIDATES = 10_000;
/** SQLite's default bound-parameter limit is 999 (some builds 32766). */
const ID_CHUNK = 500;

let cacheSchemaVersion = -1;

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

function cosine(q: Float32Array, v: Float32Array, qNorm: number): number {
  let dot = 0;
  let vn = 0;
  for (let i = 0; i < q.length; i++) {
    const y = v[i]!;
    dot += q[i]! * y;
    vn += y * y;
  }
  return qNorm === 0 || vn === 0 ? 0 : dot / (qNorm * Math.sqrt(vn));
}

/**
 * Rank the newest MAX_CANDIDATES records visible under `opts` (filter +
 * access rule, same as a list) by cosine similarity to `query`. Returns ids
 * and scores, best first. Vectors come from the parsed-vector cache; only
 * rows that are new or changed since the last search are parsed.
 */
export async function searchVectors(
  col: Collection,
  field: string,
  query: number[],
  opts: Pick<ListOptions, "filter" | "accessRule" | "auth"> & { limit: number; minScore?: number },
): Promise<Array<{ id: string; score: number }>> {
  // Field definitions (dimensions, names) may have changed.
  if (getSchemaVersion() !== cacheSchemaVersion) {
    _resetVectorCache();
    cacheSchemaVersion = getSchemaVersion();
  }
  const client: Database = getRawClient();
  const table = quoteIdent(userTableName(col.name));
  const fieldQ = quoteIdent(field);
  const { whereSql, whereParams } = await compileListWhere(col, opts);

  const candidates = client
    .prepare(`SELECT "id", "updated_at" FROM ${table} ${whereSql} ORDER BY "created_at" DESC LIMIT ${MAX_CANDIDATES}`)
    .all(...whereParams) as Array<{ id: string; updated_at: number }>;

  const bucket = bucketFor(col.id, field);
  const misses = candidates.filter((c) => bucket.entries.get(c.id)?.updated !== c.updated_at);
  for (let i = 0; i < misses.length; i += ID_CHUNK) {
    const chunk = misses.slice(i, i + ID_CHUNK);
    const rows = client
      .prepare(`SELECT "id", "updated_at", ${fieldQ} AS v FROM ${table} WHERE "id" IN (${chunk.map(() => "?").join(",")})`)
      .all(...chunk.map((c) => c.id)) as Array<{ id: string; updated_at: number; v: unknown }>;
    for (const r of rows) {
      let arr: unknown = null;
      try { arr = typeof r.v === "string" ? JSON.parse(r.v) : null; } catch { arr = null; }
      if (Array.isArray(arr) && arr.length > 0 && arr.every((x) => typeof x === "number")) {
        putVector(bucket, r.id, r.updated_at, Float32Array.from(arr as number[]));
      } else {
        dropVector(bucket, r.id);
      }
    }
  }
  // Unfiltered search sees every row (up to the window): forget vectors of
  // records that no longer exist.
  if (!whereSql && candidates.length < MAX_CANDIDATES) {
    const live = new Set(candidates.map((c) => c.id));
    for (const id of [...bucket.entries.keys()]) if (!live.has(id)) dropVector(bucket, id);
  }
  enforceBudget(bucket);

  const q = Float32Array.from(query);
  let qn = 0;
  for (const x of q) qn += x * x;
  const qNorm = Math.sqrt(qn);
  const scored: Array<{ id: string; score: number }> = [];
  for (const c of candidates) {
    const e = bucket.entries.get(c.id);
    if (!e || e.vec.length !== q.length) continue; // missing / dimension mismatch
    const score = cosine(q, e.vec, qNorm);
    if (opts.minScore !== undefined && score < opts.minScore) continue;
    scored.push({ id: c.id, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, Math.min(1000, opts.limit)));
}
