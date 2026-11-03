/**
 * What a restore keeps from the database it replaces: credentials.
 *
 * A restore brings back data, not sign-in secrets. Password changes, MFA
 * changes and provider links made since the backup all raise the account's
 * `password_reset_at`, so where the replaced database's stamp is newer than
 * the backup's, that account keeps its current password hash, TOTP state,
 * recovery codes and provider links. Otherwise a password rotated after a
 * leak came back with the restore and the leaked one signed in again.
 *
 * An admin deleted since the backup stays deleted, and the API tokens they
 * minted are revoked (deleting an admin only removes the row; the tokens
 * were rejected because it was gone). Only when the backup is this
 * install's own (same `vaultbase_install` id): restoring another install's
 * backup brings its admins, as it should. A restore never leaves no admin.
 *
 * Used by both restore paths: SQLite (capture before the file swap, apply
 * after) and Postgres (both schemas side by side, inside the swap).
 */
import { resetStampMs } from "./sec.ts";

export interface CarryDb {
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<void>;
  /** A table name as this side spells it (schema-qualified on Postgres). */
  t(name: string): string;
  /**
   * Whether the table exists. Checked instead of catching a failed query:
   * on Postgres this runs inside the restore's transaction, which a failed
   * statement would abort.
   */
  has(name: string): Promise<boolean>;
}

interface AccountCreds {
  password_reset_at: number;
  password_hash: string | null;
  totp_enabled?: number | null;
  totp_secret?: string | null;
}

export interface LiveCredentials {
  installId: string | null;
  adminIds: Set<string>;
  admins: Map<string, AccountCreds>;
  /** Auth collection name → its id and accounts. */
  users: Map<string, { collectionId: string; accounts: Map<string, AccountCreds> }>;
  recovery: Array<Record<string, unknown>>;
  links: Array<Record<string, unknown>>;
}

export interface CarrySummary {
  /** Accounts that kept their current credentials. */
  kept: number;
  /** Emails of admins deleted since the backup, left deleted. */
  removedAdmins: string[];
}

const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function allIf<T>(d: CarryDb, table: string, sql: string, params?: unknown[]): Promise<T[]> {
  return (await d.has(table)) ? await d.all<T>(sql, params) : [];
}

async function installIdOf(d: CarryDb): Promise<string | null> {
  const rows = await allIf<{ id: string }>(d, "vaultbase_install", `SELECT id FROM ${d.t("vaultbase_install")} WHERE key = 'install'`);
  return rows[0]?.id ?? null;
}

async function authCollections(d: CarryDb): Promise<Array<{ id: string; name: string }>> {
  const rows = await allIf<{ id: string; name: string }>(d, "vaultbase_collections", `SELECT id, name FROM ${d.t("vaultbase_collections")} WHERE type = 'auth'`);
  return rows.filter((c) => SAFE_NAME.test(c.name));
}

async function accounts(d: CarryDb, table: string, withTotp: boolean): Promise<Map<string, AccountCreds>> {
  const cols = withTotp ? "id, password_reset_at, password_hash, totp_enabled, totp_secret" : "id, password_reset_at, password_hash";
  const rows = await allIf<AccountCreds & { id: string }>(d, table, `SELECT ${cols} FROM ${d.t(table)}`);
  const out = new Map<string, AccountCreds>();
  for (const r of rows) out.set(String(r.id), { ...r, password_reset_at: Number(r.password_reset_at ?? 0) });
  return out;
}

/** Read the credentials of the database about to be replaced. */
export async function captureCredentials(d: CarryDb): Promise<LiveCredentials> {
  const users = new Map<string, { collectionId: string; accounts: Map<string, AccountCreds> }>();
  for (const c of await authCollections(d)) {
    users.set(c.name, { collectionId: c.id, accounts: await accounts(d, `vb_${c.name}`, true) });
  }
  const admins = await accounts(d, "vaultbase_admin", false);
  return {
    installId: await installIdOf(d),
    adminIds: new Set(admins.keys()),
    admins,
    users,
    recovery: await allIf(d, "vaultbase_mfa_recovery_codes", `SELECT * FROM ${d.t("vaultbase_mfa_recovery_codes")}`),
    links: await allIf(d, "vaultbase_oauth_links", `SELECT * FROM ${d.t("vaultbase_oauth_links")}`),
  };
}

/** The live account changed its credentials after the backup was taken. */
function newer(live: AccountCreds, restored: AccountCreds): boolean {
  return live.password_reset_at > 0 && resetStampMs(live.password_reset_at) > resetStampMs(restored.password_reset_at);
}

async function replaceRows(d: CarryDb, table: string, rows: Array<Record<string, unknown>>, userId: string, collectionId: string): Promise<void> {
  if (!(await d.has(table))) return;
  await d.run(`DELETE FROM ${d.t(table)} WHERE user_id = ? AND collection_id = ?`, [userId, collectionId]);
  for (const r of rows) {
    const row: Record<string, unknown> = { ...r, collection_id: collectionId };
    const keys = Object.keys(row);
    await d.run(
      `INSERT INTO ${d.t(table)} (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
      keys.map((k) => row[k]),
    );
  }
}

/**
 * Apply to the restored database. Run before raising the reset stamps back
 * (that step makes the restored stamps look current).
 */
export async function applyCredentials(d: CarryDb, live: LiveCredentials): Promise<CarrySummary> {
  let kept = 0;

  const restoredAdmins = await accounts(d, "vaultbase_admin", false);
  for (const [id, cur] of live.admins) {
    const old = restoredAdmins.get(id);
    if (!old || !newer(cur, old) || cur.password_hash == null) continue;
    await d.run(`UPDATE ${d.t("vaultbase_admin")} SET password_hash = ? WHERE id = ?`, [cur.password_hash, id]);
    kept++;
  }

  const restoredCols = new Map((await authCollections(d)).map((c) => [c.name, c.id]));
  for (const [name, { collectionId: liveColId, accounts: liveAccounts }] of live.users) {
    const restoredColId = restoredCols.get(name);
    if (!restoredColId) continue;
    const table = `vb_${name}`;
    const restored = await accounts(d, table, true);
    for (const [id, cur] of liveAccounts) {
      const old = restored.get(id);
      if (!old || !newer(cur, old) || cur.password_hash == null) continue;
      await d.run(
        `UPDATE ${d.t(table)} SET password_hash = ?, totp_enabled = ?, totp_secret = ? WHERE id = ?`,
        [cur.password_hash, cur.totp_enabled ?? 0, cur.totp_secret ?? null, id],
      );
      const mine = (rows: Array<Record<string, unknown>>) =>
        rows.filter((r) => r["user_id"] === id && r["collection_id"] === liveColId);
      await replaceRows(d, "vaultbase_mfa_recovery_codes", mine(live.recovery), id, restoredColId);
      await replaceRows(d, "vaultbase_oauth_links", mine(live.links), id, restoredColId);
      kept++;
    }
  }

  const removedAdmins: string[] = [];
  const sameInstall = live.installId !== null && live.installId === (await installIdOf(d));
  if (sameInstall) {
    const restored = await allIf<{ id: string; email: string }>(d, "vaultbase_admin", `SELECT id, email FROM ${d.t("vaultbase_admin")}`);
    const gone = restored.filter((a) => !live.adminIds.has(String(a.id)));
    // Never lock everyone out: with no admin left, keep them all.
    if (gone.length > 0 && gone.length < restored.length) {
      const now = Math.floor(Date.now() / 1000);
      for (const a of gone) {
        await d.run(`DELETE FROM ${d.t("vaultbase_admin")} WHERE id = ?`, [a.id]);
        if (await d.has("vaultbase_api_tokens")) {
          await d.run(`UPDATE ${d.t("vaultbase_api_tokens")} SET revoked_at = ? WHERE created_by = ? AND revoked_at IS NULL`, [now, a.id]);
        }
        removedAdmins.push(String(a.email));
      }
    }
  }

  return { kept, removedAdmins };
}

/** The sentence a restore's answer adds, or "". */
export function describeCarry(s: CarrySummary): string {
  const parts: string[] = [];
  if (s.kept > 0) parts.push(`${s.kept} account${s.kept === 1 ? "" : "s"} kept the password and MFA set since the backup.`);
  if (s.removedAdmins.length > 0) {
    parts.push(`Admins deleted since the backup stay deleted and their API tokens are revoked: ${s.removedAdmins.join(", ")}.`);
  }
  return parts.join(" ");
}

let lastSummary: CarrySummary | null = null;

/** Remember what the restore just carried over, for its answer. */
export function noteCarry(s: CarrySummary): void { lastSummary = s; }

/** The sentence for the last restore's answer (with a leading space), once. */
export function takeCarryMessage(): string {
  const s = lastSummary;
  lastSummary = null;
  const text = s ? describeCarry(s) : "";
  return text ? ` ${text}` : "";
}
