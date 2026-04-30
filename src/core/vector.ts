/**
 * Pure-JS vector similarity search.
 *
 * v1: scans the candidate set in-process and ranks by cosine similarity. Fine
 * for collections up to a few tens of thousands of rows on a single host;
 * larger fan-outs should adopt the `sqlite-vec` extension when we wire that
 * in. The query API is shaped so the implementation can be swapped without
 * breaking callers.
 *
 * Distance metric: cosine similarity (1 - cosine_distance). Returned scores
 * are in [-1, 1]; higher = more similar. Zero-norm vectors score 0 against
 * any other vector.
 */

export interface VectorSearchInput {
  /** The query vector. Length must match the candidate vectors' dimensions. */
  query: number[];
  /**
   * Candidate rows to rank. Each carries the row's id + its vector. Caller
   * is responsible for fetching candidates (with whatever filter / auth scope
   * makes sense in context) before passing them in.
   */
  candidates: Array<{ id: string; vector: number[] }>;
  /** Top-K to return. Default 10, max 1000. */
  limit?: number;
  /**
   * Optional minimum similarity score; rows below this are dropped. Useful
   * for quality filtering when you'd rather return zero results than weak ones.
   */
  minScore?: number;
}

export interface VectorMatch {
  id: string;
  /** Cosine similarity in [-1, 1]; higher is more similar. */
  score: number;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error(`vector length mismatch: ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function topK(input: VectorSearchInput): VectorMatch[] {
  const limit = Math.max(1, Math.min(1000, input.limit ?? 10));
  const minScore = input.minScore;
  const out: VectorMatch[] = [];
  for (const c of input.candidates) {
    let score: number;
    try {
      score = cosineSimilarity(input.query, c.vector);
    } catch {
      continue; // dimension mismatch — silently skip the bad row
    }
    if (minScore !== undefined && score < minScore) continue;
    out.push({ id: c.id, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/**
 * Parse a JSON-encoded vector from the URL query (`?nearVector=[0.1,0.2,…]`).
 * Returns the parsed array or throws a `VectorParseError` with a caller-friendly
 * message — endpoints translate that into a 422 response.
 */
export class VectorParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectorParseError";
  }
}

export function parseVectorParam(raw: string): number[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    throw new VectorParseError("nearVector must be a JSON-encoded number[]");
  }
  if (!Array.isArray(parsed)) {
    throw new VectorParseError("nearVector must be a JSON array");
  }
  const out: number[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const v = parsed[i];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new VectorParseError(`nearVector[${i}] must be a finite number`);
    }
    out.push(v);
  }
  return out;
}
