/**
 * Idempotent creates. A create sent with `X-VB-Idempotency-Key: <key>` runs
 * once: the same key again, from the same caller on the same collection,
 * answers with the record the first one made instead of making another. A
 * client that didn't get the first answer (a timeout, a dropped connection)
 * can repeat the request safely.
 *
 * The key is claimed with an insert before the create runs, and the claim
 * holds the id the record will get. That id is what makes a retry safe even
 * if the server stopped between the create and marking the claim done: the
 * record is found under it, and a second insert under it can't succeed.
 *
 * Keys are kept for 24 hours, in a table, so several servers on one
 * Postgres share them.
 */
import { db } from "../db/index.ts";
import type { Collection } from "../db/schema.ts";
import type { AuthContext } from "../core/rules.ts";
import { asRecordId } from "../core/records.ts";
import { quoteIdent } from "../db/ident.ts";
import { userTableName } from "../core/collections.ts";

export const IDEMPOTENCY_HEADER = "x-vb-idempotency-key";
/** Set on the answer to a repeat, so a client can tell it from a first run. */
export const REPLAY_HEADER = "Vaultbase-Idempotent-Replay";
const KEEP_SECONDS = 24 * 60 * 60;
/** A claim this old with no record is a create that died, not one still running. */
const STALE_SECONDS = 120;
const MAX_KEY_LENGTH = 255;

export type KeyOutcome =
  /** Run the create, giving the record this id. `hash` names the claim. */
  | { kind: "run"; hash: string; recordId: string }
  /** The create already ran: answer with this record. */
  | { kind: "replay"; recordId: string }
  /** It ran, and the record has since been deleted. */
  | { kind: "gone" }
  /** The first request with this key is still running. */
  | { kind: "busy" }
  /** The key was used with a different body. */
  | { kind: "mismatch" };

/** The header's key, null when it wasn't sent, or what is wrong with it. */
export function idempotencyKeyOf(request: Request): string | null | { error: string } {
  const raw = request.headers.get(IDEMPOTENCY_HEADER);
  if (raw === null) return null;
  const key = raw.trim();
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
    return { error: `X-VB-Idempotency-Key must be 1 to ${MAX_KEY_LENGTH} characters` };
  }
  return key;
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** JSON with object keys in one order, so the same body always hashes the same. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

interface ClaimRow { body_hash: string; record_id: string; done: number; created_at: number }

async function recordExists(col: Collection, id: string): Promise<boolean> {
  return !!(await db.get(`SELECT 1 FROM ${quoteIdent(userTableName(col.name))} WHERE "id" = ? LIMIT 1`, [id]));
}

/**
 * Claim `key` for this caller's create on `col`, or say what its earlier
 * use came to. Call it after the create rule passed.
 */
export async function claimIdempotencyKey(col: Collection, auth: AuthContext | null, key: string, body: unknown): Promise<KeyOutcome> {
  const caller = auth ? `${auth.type}:${auth.id}` : "anonymous";
  const hash = sha256(`${col.id}\0${caller}\0${key}`);
  const bodyHash = sha256(stableJson(body ?? null));
  const now = Math.floor(Date.now() / 1000);
  // The record's id is settled now: the client's own when it sent a valid
  // one, else a new one. (An invalid one fails the create, which frees the key.)
  const recordId = asRecordId((body as { id?: unknown } | null)?.id) ?? crypto.randomUUID();

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await db.run(
        `INSERT INTO vaultbase_idempotency_keys (key_hash, collection_id, body_hash, record_id, done, created_at) VALUES (?, ?, ?, ?, 0, ?)`,
        [hash, col.id, bodyHash, recordId, now],
      );
      return { kind: "run", hash, recordId };
    } catch (e) {
      if (!db.dialect.isUniqueViolation(e)) throw e;
    }
    const row = await db.get<ClaimRow>(
      `SELECT body_hash, record_id, done, created_at FROM vaultbase_idempotency_keys WHERE key_hash = ?`, [hash]);
    if (!row) continue; // released between the insert and the read: claim again
    if (now - Number(row.created_at) >= KEEP_SECONDS) {
      // Kept past its day and not pruned yet: the key is free again.
      await db.run(`DELETE FROM vaultbase_idempotency_keys WHERE key_hash = ? AND created_at = ?`, [hash, row.created_at]);
      continue;
    }
    if (row.body_hash !== bodyHash) return { kind: "mismatch" };
    if (Number(row.done) === 1) {
      return (await recordExists(col, row.record_id)) ? { kind: "replay", recordId: row.record_id } : { kind: "gone" };
    }
    // Not marked done. If the record is there, the create did finish.
    if (await recordExists(col, row.record_id)) {
      await completeIdempotencyKey(hash);
      return { kind: "replay", recordId: row.record_id };
    }
    if (now - Number(row.created_at) < STALE_SECONDS) return { kind: "busy" };
    // The first request died before it made the record: take the claim over,
    // keeping its record id, unless another retry just did.
    const taken = await db.run(
      `UPDATE vaultbase_idempotency_keys SET created_at = ? WHERE key_hash = ? AND done = 0 AND created_at = ?`,
      [now, hash, row.created_at],
    );
    return taken.changes === 1 ? { kind: "run", hash, recordId: row.record_id } : { kind: "busy" };
  }
  return { kind: "busy" };
}

/** The create succeeded. */
export async function completeIdempotencyKey(hash: string): Promise<void> {
  await db.run(`UPDATE vaultbase_idempotency_keys SET done = 1 WHERE key_hash = ?`, [hash]);
}

/**
 * The create threw. Usually nothing was written (validation, a taken id)
 * and the key is freed for a corrected request. If the record is there all
 * the same (the failure came after the insert), the key stays, done, so a
 * retry answers with that record instead of making another.
 */
export async function settleFailedCreate(col: Collection, hash: string, recordId: string): Promise<void> {
  if (await recordExists(col, recordId)) return completeIdempotencyKey(hash);
  await db.run(`DELETE FROM vaultbase_idempotency_keys WHERE key_hash = ? AND done = 0`, [hash]);
}

/** Drop keys past their day. Run hourly by the server. */
export async function pruneIdempotencyKeys(): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - KEEP_SECONDS;
  return (await db.run(`DELETE FROM vaultbase_idempotency_keys WHERE created_at < ?`, [cutoff])).changes;
}
