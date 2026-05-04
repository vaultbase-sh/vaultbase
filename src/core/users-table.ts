/**
 * Auth-collection user storage helpers — v0.11 transition.
 *
 * v0.10 model: every auth user lived in shared `vaultbase_users` keyed by
 * collection_id, with custom fields packed into a `data` JSON blob.
 *
 * v0.11 model: each auth collection gets a per-collection `vb_<name>`
 * table with auth columns inline + typed custom-field columns. Custom
 * fields are real columns, not JSON-extracted.
 *
 * Phase 2 strategy: writes dual-fan to **both** tables so existing tests
 * (which insert into the legacy table directly) keep passing while new
 * code reads from the new shape with a legacy fallback. Phase 4 deletes
 * the legacy table + the dual-write + the fallback.
 *
 * Every helper here is keyed by `collectionName` so the SQL targets the
 * right per-collection table.
 */

import type { Database } from "bun:sqlite";
import { getRawClient } from "../db/client.ts";
import { userTableName } from "./collections.ts";
import type { Collection } from "../db/schema.ts";

/** Auth-system columns guaranteed to exist on every `vb_<auth-col>`. */
export const AUTH_USER_COLUMNS = [
  "id", "email", "password_hash", "email_verified", "totp_secret",
  "totp_enabled", "is_anonymous", "password_reset_at",
  "created_at", "updated_at",
] as const;

/**
 * Shape returned by user-row reads. Custom fields appear as additional
 * keys; consumers should access them via the row's untyped record shape
 * since field names are user-defined.
 */
export interface AuthUserRow {
  id: string;
  email: string;
  password_hash: string;
  email_verified: number;
  totp_secret: string | null;
  totp_enabled: number;
  is_anonymous: number;
  password_reset_at: number;
  /** Serialised JSON blob — present only on legacy reads from vaultbase_users. */
  data?: string;
  created_at: number;
  updated_at: number;
  [k: string]: unknown;
}

function rawClient(): Database {
  return getRawClient();
}

function quoteIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Find a user by id, scoped to a collection. Reads `vb_<name>` only —
 * `vaultbase_users` was dropped in v0.11 phase 4.
 */
export function findUserById(col: Collection, id: string): AuthUserRow | null {
  const tname = quoteIdent(userTableName(col.name));
  try {
    const row = rawClient().prepare(`SELECT * FROM ${tname} WHERE id = ?`).get(id) as AuthUserRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/** Find a user by email within a collection. */
export function findUserByEmail(col: Collection, email: string): AuthUserRow | null {
  const tname = quoteIdent(userTableName(col.name));
  try {
    const row = rawClient().prepare(`SELECT * FROM ${tname} WHERE email = ?`).get(email) as AuthUserRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

/**
 * Pull the canonical column list for an auth-collection table.
 * Recomputed each call — PRAGMA table_info is cheap and caching across
 * test-suite DB resets caused stale-table errors.
 */
export function tableColumns(collectionName: string): string[] {
  const rows = rawClient().prepare(
    `PRAGMA table_info(${quoteIdent(userTableName(collectionName))})`,
  ).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/** No-op kept for callers that referenced it before caching was dropped. */
export function invalidateUserTableColumnCache(_collectionName?: string): void {
  /* cache removed in v0.11 — function kept for compatibility */
}

interface InsertInput {
  id: string;
  email: string;
  password_hash: string;
  email_verified?: number;
  totp_secret?: string | null;
  totp_enabled?: number;
  is_anonymous?: number;
  password_reset_at?: number;
  /** Custom-field values keyed by field name (typed per the collection schema). */
  custom?: Record<string, unknown>;
  /** Pre-serialised legacy JSON blob — used for the dual-write to vaultbase_users. */
  legacyDataJson?: string;
  created_at: number;
  updated_at: number;
}

/**
 * Insert into `vb_<name>` only. Custom fields land as real columns
 * whitelisted against the per-collection table schema.
 */
export async function insertUser(col: Collection, input: InsertInput): Promise<void> {
  const tname = quoteIdent(userTableName(col.name));
  const cols = tableColumns(col.name);

  const insertCols: string[] = [];
  const placeholders: string[] = [];
  const values: unknown[] = [];

  const known: Record<string, unknown> = {
    id: input.id,
    email: input.email,
    password_hash: input.password_hash,
    email_verified: input.email_verified ?? 0,
    totp_secret: input.totp_secret ?? null,
    totp_enabled: input.totp_enabled ?? 0,
    is_anonymous: input.is_anonymous ?? 0,
    password_reset_at: input.password_reset_at ?? 0,
    created_at: input.created_at,
    updated_at: input.updated_at,
  };
  for (const [k, v] of Object.entries(known)) {
    if (cols.includes(k)) {
      insertCols.push(quoteIdent(k));
      placeholders.push("?");
      values.push(v as never);
    }
  }
  // Custom fields — only those present in the table schema.
  if (input.custom) {
    for (const [k, v] of Object.entries(input.custom)) {
      if (cols.includes(k)) {
        insertCols.push(quoteIdent(k));
        placeholders.push("?");
        values.push(v as never);
      }
    }
  }

  rawClient()
    .prepare(`INSERT INTO ${tname} (${insertCols.join(", ")}) VALUES (${placeholders.join(", ")})`)
    .run(...(values as never[]));
}

/**
 * Update by id on `vb_<name>`. Whitelists keys against the per-collection
 * table schema; unknown keys are silently ignored.
 */
export async function updateUserById(
  col: Collection,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const tname = quoteIdent(userTableName(col.name));
  const cols = tableColumns(col.name);

  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (cols.includes(k)) {
      sets.push(`${quoteIdent(k)} = ?`);
      vals.push(v as never);
    }
  }
  if (sets.length > 0) {
    rawClient()
      .prepare(`UPDATE ${tname} SET ${sets.join(", ")} WHERE id = ?`)
      .run(...(vals as never[]), id);
  }
}

/** Delete a user from `vb_<name>` by id. */
export function deleteUserById(col: Collection, id: string): void {
  const tname = quoteIdent(userTableName(col.name));
  try {
    rawClient().prepare(`DELETE FROM ${tname} WHERE id = ?`).run(id);
  } catch { /* table missing or row absent */ }
}
