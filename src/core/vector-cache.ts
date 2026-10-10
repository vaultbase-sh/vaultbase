/**
 * Parsed-vector cache for nearVector search.
 *
 * Vector fields are stored as JSON text; parsing every candidate on every
 * search was ~85% of search time. Parsed vectors are kept as Float32Arrays
 * keyed by collection + field + record id, tagged with the row's updated_at.
 * A row whose updated_at moved is re-parsed; writes made in this process
 * invalidate their record immediately (covers same-second updates). Other
 * cluster workers' same-second writes are picked up on the record's next
 * updated_at change.
 *
 * Memory is bounded: once the total exceeds MAX_BYTES, least recently
 * searched collections are dropped whole.
 */

/** ~128 MB of Float32 data (e.g. ~85k vectors at 384 dims). */
const MAX_BYTES = 128 * 1024 * 1024;

interface Entry { updated: number; vec: Float32Array }
interface Bucket { entries: Map<string, Entry>; bytes: number; lastUsed: number }

/** key: `${collectionId}:${field}` */
const buckets = new Map<string, Bucket>();
let totalBytes = 0;
let parsedCount = 0;

const keyOf = (collectionId: string, field: string) => `${collectionId}:${field}`;

export function bucketFor(collectionId: string, field: string): Bucket {
  const key = keyOf(collectionId, field);
  let b = buckets.get(key);
  if (!b) { b = { entries: new Map(), bytes: 0, lastUsed: 0 }; buckets.set(key, b); }
  b.lastUsed = Date.now();
  return b;
}

export function putVector(b: Bucket, id: string, updated: number, vec: Float32Array): void {
  const old = b.entries.get(id);
  if (old) { b.bytes -= old.vec.byteLength; totalBytes -= old.vec.byteLength; }
  b.entries.set(id, { updated, vec });
  b.bytes += vec.byteLength;
  totalBytes += vec.byteLength;
  parsedCount++;
}

export function dropVector(b: Bucket, id: string): void {
  const old = b.entries.get(id);
  if (!old) return;
  b.entries.delete(id);
  b.bytes -= old.vec.byteLength;
  totalBytes -= old.vec.byteLength;
}

/** Evict least-recently-searched buckets (never `keep`) until under budget. */
export function enforceBudget(keep: Bucket): void {
  if (totalBytes <= MAX_BYTES) return;
  const order = [...buckets.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [key, b] of order) {
    if (totalBytes <= MAX_BYTES) break;
    if (b === keep) continue;
    totalBytes -= b.bytes;
    buckets.delete(key);
  }
}

/** A record was written or deleted in this process: forget its vectors. */
export function invalidateRecordVectors(collectionId: string, id: string): void {
  const prefix = `${collectionId}:`;
  for (const [key, b] of buckets) if (key.startsWith(prefix)) dropVector(b, id);
}

/** Drop everything (schema changes, tests). */
export function _resetVectorCache(): void {
  buckets.clear();
  totalBytes = 0;
}

/** Test hook: vectors parsed since start, bytes held. */
export function _vectorCacheStats(): { parsed: number; bytes: number } {
  return { parsed: parsedCount, bytes: totalBytes };
}
