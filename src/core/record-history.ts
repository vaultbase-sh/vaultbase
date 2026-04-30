/**
 * Record history — append-only audit + restore log.
 *
 * Each write to a collection where `history_enabled=1` produces a row in
 * `vaultbase_record_history` capturing the post-write state (or pre-delete
 * state on delete) plus the actor that triggered the change.
 *
 * Out of scope (intentionally — keeps the v1 footprint small):
 *   - Diff computation (clients can compute one between two snapshots).
 *   - Schema-change tracking (this is record-level history only).
 *   - File-content history (only the filename string is preserved).
 */
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { recordHistory } from "../db/schema.ts";
import type { AuthContext } from "./rules.ts";
import type { Collection } from "../db/schema.ts";

export type HistoryOp = "create" | "update" | "delete";

export interface HistoryEntry {
  id: string;
  collection: string;
  record_id: string;
  op: HistoryOp;
  /** JSON-decoded snapshot. */
  snapshot: Record<string, unknown>;
  actor_id: string | null;
  actor_type: "user" | "admin" | null;
  at: number;
}

interface InsertOpts {
  op: HistoryOp;
  /** Pre-delete state on `delete`; post-write state on `create`/`update`. */
  snapshot: Record<string, unknown>;
  auth: AuthContext | null;
}

/**
 * Persist a history row if the collection has history enabled. Silently
 * no-ops when disabled — call sites can always invoke it.
 */
export async function maybeRecordHistory(col: Collection, recordId: string, opts: InsertOpts): Promise<void> {
  if (col.history_enabled !== 1) return;
  const db = getDb();
  await db.insert(recordHistory).values({
    id: crypto.randomUUID(),
    collection: col.name,
    record_id: recordId,
    op: opts.op,
    snapshot: JSON.stringify(opts.snapshot),
    actor_id: opts.auth?.id ?? null,
    actor_type: (opts.auth?.type as "user" | "admin" | undefined) ?? null,
    at: Math.floor(Date.now() / 1000),
  });
}

export interface ListHistoryOpts {
  /** Default 50, max 200. */
  perPage?: number;
  /** 1-indexed. */
  page?: number;
}

export interface HistoryListResponse {
  data: HistoryEntry[];
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
}

export async function listRecordHistory(
  collectionName: string,
  recordId: string,
  opts: ListHistoryOpts = {},
): Promise<HistoryListResponse> {
  const db = getDb();
  const perPage = Math.min(200, Math.max(1, opts.perPage ?? 50));
  const page = Math.max(1, opts.page ?? 1);
  const offset = (page - 1) * perPage;

  const where = and(
    eq(recordHistory.collection, collectionName),
    eq(recordHistory.record_id, recordId),
  );

  const totalRow = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(recordHistory)
    .where(where);
  const totalItems = (totalRow[0]?.n ?? 0) as number;

  const rows = await db
    .select()
    .from(recordHistory)
    .where(where)
    .orderBy(desc(recordHistory.at))
    .limit(perPage)
    .offset(offset);

  const data: HistoryEntry[] = rows.map((r) => ({
    id: r.id,
    collection: r.collection,
    record_id: r.record_id,
    op: r.op as HistoryOp,
    snapshot: parseSnapshot(r.snapshot),
    actor_id: r.actor_id,
    actor_type: (r.actor_type as "user" | "admin" | null) ?? null,
    at: r.at,
  }));

  return {
    data,
    page,
    perPage,
    totalItems,
    totalPages: Math.max(1, Math.ceil(totalItems / perPage)),
  };
}

/**
 * Get the snapshot active at-or-before `atUnixSec`. Returns null if no
 * history exists for that record at or before the cutoff.
 */
export async function getHistoryAt(
  collectionName: string,
  recordId: string,
  atUnixSec: number,
): Promise<HistoryEntry | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(recordHistory)
    .where(and(
      eq(recordHistory.collection, collectionName),
      eq(recordHistory.record_id, recordId),
      sql`${recordHistory.at} <= ${atUnixSec}`,
    ))
    .orderBy(desc(recordHistory.at))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    collection: r.collection,
    record_id: r.record_id,
    op: r.op as HistoryOp,
    snapshot: parseSnapshot(r.snapshot),
    actor_id: r.actor_id,
    actor_type: (r.actor_type as "user" | "admin" | null) ?? null,
    at: r.at,
  };
}

/**
 * Drop history rows older than `cutoffUnixSec`. Returns the number deleted.
 * Intended for use via a cron job; call directly to perform an explicit
 * one-shot prune.
 */
export async function pruneHistoryOlderThan(cutoffUnixSec: number): Promise<number> {
  const db = getDb();
  const r = await db.delete(recordHistory).where(lt(recordHistory.at, cutoffUnixSec)).returning({ id: recordHistory.id });
  return r.length;
}

function parseSnapshot(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; } catch { return {}; }
}
