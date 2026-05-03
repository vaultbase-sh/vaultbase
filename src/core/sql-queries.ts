/**
 * Saved-SQL-queries store. Per-admin, private. Persists into the
 * `vaultbase_sql_queries` system table.
 */

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { sqlQueries } from "../db/schema.ts";

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  description: string | null;
  owner_admin_id: string;
  owner_admin_email: string;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  last_run_ms: number | null;
  last_row_count: number | null;
  last_error: string | null;
}

export const MAX_SAVED_QUERY_NAME_LEN = 100;
export const MAX_SAVED_QUERY_SQL_LEN = 100_000;
export const MAX_SAVED_QUERY_DESC_LEN = 500;

interface CreateInput {
  name: string;
  sql: string;
  description?: string;
  ownerAdminId: string;
  ownerAdminEmail: string;
}

export async function createSavedQuery(input: CreateInput): Promise<SavedQuery> {
  validate(input);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(sqlQueries).values({
    id,
    name: input.name.trim(),
    sql: input.sql,
    description: input.description?.trim() || null,
    owner_admin_id: input.ownerAdminId,
    owner_admin_email: input.ownerAdminEmail,
    created_at: now,
    updated_at: now,
  });
  const out = await getSavedQuery(id, input.ownerAdminId);
  if (!out) throw new Error("createSavedQuery: post-insert read returned null");
  return out;
}

export async function listSavedQueries(ownerAdminId: string): Promise<SavedQuery[]> {
  const rows = await getDb()
    .select()
    .from(sqlQueries)
    .where(eq(sqlQueries.owner_admin_id, ownerAdminId))
    .orderBy(desc(sqlQueries.updated_at));
  return rows as SavedQuery[];
}

export async function getSavedQuery(id: string, ownerAdminId: string): Promise<SavedQuery | null> {
  const rows = await getDb()
    .select()
    .from(sqlQueries)
    .where(and(eq(sqlQueries.id, id), eq(sqlQueries.owner_admin_id, ownerAdminId)))
    .limit(1);
  return (rows[0] as SavedQuery) ?? null;
}

interface UpdateInput {
  name?: string;
  sql?: string;
  description?: string | null;
}

export async function updateSavedQuery(
  id: string,
  ownerAdminId: string,
  input: UpdateInput,
): Promise<SavedQuery | null> {
  const existing = await getSavedQuery(id, ownerAdminId);
  if (!existing) return null;
  const next: Record<string, unknown> = { updated_at: Math.floor(Date.now() / 1000) };
  if (input.name !== undefined) {
    if (!input.name.trim()) throw new Error("name cannot be empty");
    if (input.name.length > MAX_SAVED_QUERY_NAME_LEN) throw new Error("name too long");
    next.name = input.name.trim();
  }
  if (input.sql !== undefined) {
    if (input.sql.length > MAX_SAVED_QUERY_SQL_LEN) throw new Error("sql too long");
    next.sql = input.sql;
  }
  if (input.description !== undefined) {
    if (input.description && input.description.length > MAX_SAVED_QUERY_DESC_LEN) {
      throw new Error("description too long");
    }
    next.description = input.description?.trim() || null;
  }
  await getDb().update(sqlQueries).set(next).where(eq(sqlQueries.id, id));
  return await getSavedQuery(id, ownerAdminId);
}

export async function deleteSavedQuery(id: string, ownerAdminId: string): Promise<boolean> {
  const existing = await getSavedQuery(id, ownerAdminId);
  if (!existing) return false;
  await getDb().delete(sqlQueries).where(eq(sqlQueries.id, id));
  return true;
}

/**
 * Bookkeeping after a run — touches `last_run_*` fields. Failures
 * populate `last_error`; successes clear it.
 */
export async function recordSavedQueryRun(
  id: string,
  ownerAdminId: string,
  result: { ok: boolean; durationMs: number; rowCount: number; error?: string | null },
): Promise<void> {
  const existing = await getSavedQuery(id, ownerAdminId);
  if (!existing) return;
  await getDb().update(sqlQueries).set({
    last_run_at: Math.floor(Date.now() / 1000),
    last_run_ms: result.durationMs,
    last_row_count: result.ok ? result.rowCount : null,
    last_error: result.ok ? null : (result.error ?? "error"),
  }).where(eq(sqlQueries.id, id));
}

function validate(input: CreateInput): void {
  if (!input.name || !input.name.trim()) throw new Error("name is required");
  if (input.name.length > MAX_SAVED_QUERY_NAME_LEN) throw new Error("name too long");
  if (!input.sql) throw new Error("sql is required");
  if (input.sql.length > MAX_SAVED_QUERY_SQL_LEN) throw new Error("sql too long");
  if (input.description && input.description.length > MAX_SAVED_QUERY_DESC_LEN) {
    throw new Error("description too long");
  }
}
