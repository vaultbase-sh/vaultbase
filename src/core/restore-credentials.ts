/**
 * What a restore keeps from the database it replaces: credentials.
 *
 * A restore brings back data, not sign-in secrets. Every account present in
 * both databases keeps the replaced database's sign-in state wherever it
 * differs from the backup's: password hash, email and whether it is
 * verified (where password resets go), TOTP state, recovery codes with
 * their lookup rows (spent ones stay spent), and provider links (an
 * unlinked provider stays unlinked). It is compared directly, not read off
 * `password_reset_at`: enrolling or dropping MFA, spending a recovery code
 * and unlinking a provider don't raise that stamp. Otherwise a password
 * rotated after a leak, or a second factor replaced after one, came back
 * with the restore and the leaked one signed in again.
 *
 * An admin deleted since the backup stays deleted, and the API tokens they
 * minted are revoked (deleting an admin only removes the row; the tokens
 * were rejected because it was gone). Only on evidence that the admin was
 * deleted, not merely absent: the replaced database may itself be an older
 * snapshot (restoring a newer backup after an older one, an undo on
 * Postgres), and an admin created after it is absent without having been
 * deleted. See `deletedAdmins`. Only when the backup is this install's own
 * (same `vaultbase_install` id): restoring another install's backup brings
 * its admins, as it should. A restore never leaves no admin.
 *
 * Each step runs in a savepoint of its own: one that fails (a conflict
 * nothing here foresaw) is reported, and leaves the others to run.
 *
 * Used by both restore paths: SQLite (capture before the file swap, apply
 * after) and Postgres (both schemas side by side, inside the swap).
 */

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
  /**
   * Run `fn` in a savepoint: on a throw its writes are undone and the
   * error rethrown, the enclosing transaction still usable. Without it a
   * failed step fails the whole carry-over.
   */
  savepoint?<T>(fn: () => Promise<T>): Promise<T>;
}

interface AccountCreds {
  password_hash: string | null;
  email?: string | null;
  email_verified?: number | null;
  totp_enabled?: number | null;
  totp_secret?: string | null;
  created_at?: number | null;
}

type Row = Record<string, unknown>;

export interface LiveCredentials {
  installId: string | null;
  adminIds: Set<string>;
  admins: Map<string, AccountCreds>;
  /** Auth collection name → its id and accounts. */
  users: Map<string, { collectionId: string; accounts: Map<string, AccountCreds> }>;
  recovery: Row[];
  /** Lookup rows of the recovery codes above (the verifier finds codes only through them). */
  recoveryLookup: Row[];
  links: Row[];
  /** Ids of the newest audit-log entries: what the two databases' histories share. */
  auditIds: Set<string>;
  /** Admins the audit log records as deleted. */
  deletedAdminIds: Set<string>;
}

export interface CarrySummary {
  /** Accounts that kept their current credentials. */
  kept: number;
  /** Emails of admins deleted since the backup, left deleted. */
  removedAdmins: string[];
  /** Steps that failed, each named for the account or part it concerned. */
  failed: string[];
}

const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const AUDIT = "vaultbase_audit_log";
/** Most audit-log ids read to find what the two databases share (a restore holds the write gate meanwhile). */
const MAX_SHARED_AUDIT_IDS = 200_000;
const CODES = "vaultbase_mfa_recovery_codes";
const LOOKUP = "vaultbase_mfa_recovery_lookup";
const LINKS = "vaultbase_oauth_links";

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

const USER_COLS = ["password_hash", "email", "email_verified", "totp_enabled", "totp_secret"] as const;
const ADMIN_COLS = ["password_hash", "email"] as const;

async function accounts(d: CarryDb, table: string, cols: readonly string[]): Promise<Map<string, AccountCreds>> {
  const rows = await allIf<AccountCreds & { id: string }>(d, table, `SELECT id, created_at, ${cols.join(", ")} FROM ${d.t(table)}`);
  const out = new Map<string, AccountCreds>();
  for (const r of rows) out.set(String(r.id), r);
  return out;
}

/** Read the credentials of the database about to be replaced. */
export async function captureCredentials(d: CarryDb): Promise<LiveCredentials> {
  const users = new Map<string, { collectionId: string; accounts: Map<string, AccountCreds> }>();
  for (const c of await authCollections(d)) {
    users.set(c.name, { collectionId: c.id, accounts: await accounts(d, `vb_${c.name}`, USER_COLS) });
  }
  const admins = await accounts(d, "vaultbase_admin", ADMIN_COLS);
  const recovery = await allIf<Row>(d, CODES, `SELECT * FROM ${d.t(CODES)}`);
  const codeIds = new Set(recovery.map((r) => String(r["id"])));
  const lookup = (await allIf<Row>(d, LOOKUP, `SELECT * FROM ${d.t(LOOKUP)}`)).filter((r) => codeIds.has(String(r["recovery_id"])));
  // Only the newest entries: they place the point the two histories part
  // for admins created recently. An admin whose shared point is older than
  // this window is kept (not treated as deleted), and deletions made through
  // the API are found by their own records below whatever their age.
  const audit = await allIf<{ id: string }>(d, AUDIT, `SELECT id FROM ${d.t(AUDIT)} ORDER BY at DESC LIMIT ${MAX_SHARED_AUDIT_IDS}`);
  const deleted = await allIf<{ target: string }>(
    d, AUDIT,
    `SELECT target FROM ${d.t(AUDIT)} WHERE action = 'admins.delete' AND target IS NOT NULL AND status >= 200 AND status < 300`,
  );
  return {
    installId: await installIdOf(d),
    adminIds: new Set(admins.keys()),
    admins,
    users,
    recovery,
    recoveryLookup: lookup,
    links: await allIf<Row>(d, LINKS, `SELECT * FROM ${d.t(LINKS)}`),
    auditIds: new Set(audit.map((r) => String(r.id))),
    deletedAdminIds: new Set(deleted.map((r) => String(r.target))),
  };
}

/** A value as compared across the two databases (a bigint may come back as a string on Postgres). */
const norm = (v: unknown): string | null => (v == null ? null : String(v));

/** Rows as a comparable string, by the columns that matter. */
function signature(rows: Row[], cols: string[], key: string): string {
  return JSON.stringify(
    rows.map((r) => cols.map((c) => norm(r[c]))).sort((a, b) => String(a[cols.indexOf(key)]).localeCompare(String(b[cols.indexOf(key)]))),
  );
}

function groupBy(rows: Row[], key: (r: Row) => string): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r); else out.set(k, [r]);
  }
  return out;
}

const owner = (userId: unknown, collectionId: unknown) => `${String(collectionId)}\u0000${String(userId)}`;

async function insertRow(d: CarryDb, table: string, row: Row): Promise<void> {
  const keys = Object.keys(row);
  await d.run(
    `INSERT INTO ${d.t(table)} (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
    keys.map((k) => row[k]),
  );
}

/**
 * Set each account's email to its live one. Emails are unique, so an email
 * one account took over from another since the backup is moved in two
 * steps (placeholders first). An email still held by a restored account
 * that isn't moving (one deleted since the backup, brought back by the
 * restore) can't be taken: that account keeps the backup's email, and so
 * on for whoever wanted that one. Returns the ids left so.
 */
async function carryEmails(d: CarryDb, table: string, moves: Map<string, string>): Promise<string[]> {
  if (moves.size === 0) return [];
  const holders = new Map<string, string>();
  const wanted = [...moves.values()];
  for (let i = 0; i < wanted.length; i += 500) {
    const chunk = wanted.slice(i, i + 500);
    const rows = await d.all<{ id: string; email: string }>(
      `SELECT id, email FROM ${d.t(table)} WHERE email IN (${chunk.map(() => "?").join(", ")})`, chunk,
    );
    for (const r of rows) holders.set(String(r.email), String(r.id));
  }
  const skipped: string[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const [id, email] of moves) {
      const holder = holders.get(email);
      if (holder === undefined || holder === id || moves.has(holder)) continue;
      moves.delete(id);
      skipped.push(id);
      changed = true;
    }
  }
  if (moves.size === 0) return skipped;
  for (const [id] of moves) {
    await d.run(`UPDATE ${d.t(table)} SET email = ? WHERE id = ?`, [`vaultbase-restore-${id}.invalid`, id]);
  }
  for (const [id, email] of moves) await d.run(`UPDATE ${d.t(table)} SET email = ? WHERE id = ?`, [email, id]);
  return skipped;
}

/**
 * Admins in the restored database but not the replaced one that were
 * deleted, as opposed to created after the replaced database's data.
 *
 * Absent means deleted when:
 * - the replaced database's audit log records the deletion; or
 * - the admin was created no later than something both databases share
 *   (an admin still in both, an audit-log entry in both). Both histories
 *   run together up to the point they part; whatever was created before
 *   that point is in both, so an admin created before it and missing from
 *   one was deleted there. An admin created after that point exists only
 *   on the restored side's branch: the replaced data is an older snapshot
 *   (an undo, a newer backup restored after an older one).
 */
async function deletedAdmins(d: CarryDb, live: LiveCredentials): Promise<Array<{ id: string; email: string }>> {
  const restored = await allIf<{ id: string; email: string; created_at: number | null }>(
    d, "vaultbase_admin", `SELECT id, email, created_at FROM ${d.t("vaultbase_admin")}`,
  );
  const absent = restored.filter((a) => !live.adminIds.has(String(a.id)));
  if (absent.length === 0) return [];
  let shared = Number.NEGATIVE_INFINITY;
  for (const a of restored) {
    if (live.adminIds.has(String(a.id))) shared = Math.max(shared, Number(a.created_at ?? 0));
  }
  const created = (a: { created_at: number | null }) => Number(a.created_at ?? 0);
  const unsure = absent.filter((a) => !live.deletedAdminIds.has(String(a.id)) && created(a) > shared);
  if (unsure.length > 0 && live.auditIds.size > 0 && await d.has(AUDIT)) {
    // The newest audit entry both share, looking no further back than needed.
    const floor = Math.min(...unsure.map(created));
    const rows = await d.all<{ id: string; at: number }>(
      `SELECT id, at FROM ${d.t(AUDIT)} WHERE at >= ? ORDER BY at DESC`, [floor],
    );
    const common = rows.find((r) => live.auditIds.has(String(r.id)));
    if (common) shared = Math.max(shared, Number(common.at));
  }
  return absent
    .filter((a) => live.deletedAdminIds.has(String(a.id)) || created(a) <= shared)
    .map((a) => ({ id: String(a.id), email: String(a.email) }));
}

/** Apply to the restored database. */
export async function applyCredentials(d: CarryDb, live: LiveCredentials): Promise<CarrySummary> {
  const failed: string[] = [];
  const kept = new Set<string>();
  const step = async (label: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await (d.savepoint ? d.savepoint(fn) : fn());
    } catch (e) {
      if (!d.savepoint) throw e;
      failed.push(label);
      process.stderr.write(`[restore] credentials not carried over (${label}): ${e instanceof Error ? e.message : String(e)}\n`);
    }
  };

  // Admin deletions first: an email a deleted admin held can then go to
  // whoever holds it now.
  const removedAdmins: string[] = [];
  const sameInstall = live.installId !== null && live.installId === (await installIdOf(d));
  if (sameInstall) {
    await step("admins deleted since the backup", async () => {
      const total = (await allIf<{ id: string }>(d, "vaultbase_admin", `SELECT id FROM ${d.t("vaultbase_admin")}`)).length;
      const gone = await deletedAdmins(d, live);
      // Never lock everyone out: with no admin left, keep them all.
      if (gone.length === 0 || gone.length >= total) return;
      const now = Math.floor(Date.now() / 1000);
      const hasTokens = await d.has("vaultbase_api_tokens");
      const hasAudit = await d.has(AUDIT);
      for (const a of gone) {
        await d.run(`DELETE FROM ${d.t("vaultbase_admin")} WHERE id = ?`, [a.id]);
        if (hasTokens) {
          await d.run(`UPDATE ${d.t("vaultbase_api_tokens")} SET revoked_at = ? WHERE created_by = ? AND revoked_at IS NULL`, [now, a.id]);
        }
        // The deletion's record, for later restores of older backups: the
        // restored audit log predates it.
        if (hasAudit) {
          await insertRow(d, AUDIT, {
            id: crypto.randomUUID(), actor_id: null, actor_email: null, method: "DELETE",
            path: `/api/admin/admins/${a.id}`, action: "admins.delete", target: a.id, status: 200, ip: null,
            summary: "Kept deleted by a restore: deleted after the backup was taken", at: now,
          });
        }
        removedAdmins.push(a.email);
      }
    });
  }

  const restoredAdmins = await accounts(d, "vaultbase_admin", ADMIN_COLS);
  const adminEmails = new Map<string, string>();
  for (const [id, cur] of live.admins) {
    const old = restoredAdmins.get(id);
    if (!old) continue;
    if (cur.password_hash != null && norm(cur.password_hash) !== norm(old.password_hash)) {
      await step(`admin ${id} password`, async () => {
        await d.run(`UPDATE ${d.t("vaultbase_admin")} SET password_hash = ? WHERE id = ?`, [cur.password_hash, id]);
        kept.add(`admin:${id}`);
      });
    }
    if (cur.email != null && norm(cur.email) !== norm(old.email)) adminEmails.set(id, String(cur.email));
  }
  if (adminEmails.size > 0) {
    const ids = [...adminEmails.keys()];
    await step("admin emails", async () => {
      const skipped = await carryEmails(d, "vaultbase_admin", adminEmails);
      for (const id of ids) if (!skipped.includes(id)) kept.add(`admin:${id}`);
      for (const id of skipped) failed.push(`admin ${id} email (held by an admin the restore brought back)`);
    });
  }

  const hasCodes = await d.has(CODES);
  const hasLookup = await d.has(LOOKUP);
  const hasLinks = await d.has(LINKS);
  const restoredCodes = hasCodes ? groupBy(await d.all<Row>(`SELECT * FROM ${d.t(CODES)}`), (r) => owner(r["user_id"], r["collection_id"])) : new Map<string, Row[]>();
  const restoredLookup = hasLookup ? groupBy(await d.all<Row>(`SELECT * FROM ${d.t(LOOKUP)}`), (r) => String(r["recovery_id"])) : new Map<string, Row[]>();
  const restoredLinks = hasLinks ? groupBy(await d.all<Row>(`SELECT * FROM ${d.t(LINKS)}`), (r) => owner(r["user_id"], r["collection_id"])) : new Map<string, Row[]>();
  const liveCodes = groupBy(live.recovery, (r) => owner(r["user_id"], r["collection_id"]));
  const liveLookup = groupBy(live.recoveryLookup, (r) => String(r["recovery_id"]));
  const liveLinks = groupBy(live.links, (r) => owner(r["user_id"], r["collection_id"]));
  const lookupsOf = (codes: Row[], by: Map<string, Row[]>) => codes.flatMap((c) => by.get(String(c["id"])) ?? []);

  const restoredCols = new Map((await authCollections(d)).map((c) => [c.name, c.id]));
  for (const [name, { collectionId: liveColId, accounts: liveAccounts }] of live.users) {
    const restoredColId = restoredCols.get(name);
    if (!restoredColId) continue;
    const table = `vb_${name}`;
    const restored = await accounts(d, table, USER_COLS);
    const emails = new Map<string, string>();
    for (const [id, cur] of liveAccounts) {
      const old = restored.get(id);
      if (!old) continue;
      const who = `${name} ${id}`;

      const sets: string[] = [];
      const values: unknown[] = [];
      for (const c of ["password_hash", "email_verified", "totp_enabled", "totp_secret"] as const) {
        if (c === "password_hash" && cur.password_hash == null) continue;
        if (norm(cur[c]) === norm(old[c])) continue;
        sets.push(`${c} = ?`);
        values.push(c === "totp_enabled" || c === "email_verified" ? (cur[c] ?? 0) : (cur[c] ?? null));
      }
      if (sets.length > 0) {
        await step(`${who} password and MFA`, async () => {
          await d.run(`UPDATE ${d.t(table)} SET ${sets.join(", ")} WHERE id = ?`, [...values, id]);
          kept.add(`${name}:${id}`);
        });
      }
      if (cur.email != null && norm(cur.email) !== norm(old.email)) emails.set(id, String(cur.email));

      const mineLive = owner(id, liveColId);
      const mineRestored = owner(id, restoredColId);
      if (hasCodes) {
        const now = liveCodes.get(mineLive) ?? [];
        const then = restoredCodes.get(mineRestored) ?? [];
        const codeCols = ["id", "code_hash", "used_at"];
        const lookupCols = ["hmac", "recovery_id"];
        if (signature(now, codeCols, "id") !== signature(then, codeCols, "id")
          || (hasLookup && signature(lookupsOf(now, liveLookup), lookupCols, "hmac") !== signature(lookupsOf(then, restoredLookup), lookupCols, "hmac"))) {
          await step(`${who} recovery codes`, async () => {
            if (hasLookup) {
              for (const c of then) await d.run(`DELETE FROM ${d.t(LOOKUP)} WHERE recovery_id = ?`, [c["id"]]);
            }
            await d.run(`DELETE FROM ${d.t(CODES)} WHERE user_id = ? AND collection_id = ?`, [id, restoredColId]);
            for (const c of now) {
              await d.run(`DELETE FROM ${d.t(CODES)} WHERE id = ?`, [c["id"]]);
              await insertRow(d, CODES, { ...c, collection_id: restoredColId });
            }
            if (hasLookup) {
              for (const l of lookupsOf(now, liveLookup)) {
                await d.run(`DELETE FROM ${d.t(LOOKUP)} WHERE hmac = ?`, [l["hmac"]]);
                await insertRow(d, LOOKUP, l);
              }
            }
            kept.add(`${name}:${id}`);
          });
        }
      }
      if (hasLinks) {
        const now = liveLinks.get(mineLive) ?? [];
        const then = restoredLinks.get(mineRestored) ?? [];
        const linkCols = ["id", "provider", "provider_user_id", "provider_email"];
        if (signature(now, linkCols, "id") !== signature(then, linkCols, "id")) {
          await step(`${who} provider links`, async () => {
            await d.run(`DELETE FROM ${d.t(LINKS)} WHERE user_id = ? AND collection_id = ?`, [id, restoredColId]);
            for (const l of now) {
              // The live link wins: a provider identity moved to this account
              // since the backup is taken from the account the backup gave it to.
              await d.run(`DELETE FROM ${d.t(LINKS)} WHERE id = ?`, [l["id"]]);
              await d.run(
                `DELETE FROM ${d.t(LINKS)} WHERE collection_id = ? AND provider = ? AND provider_user_id = ?`,
                [restoredColId, l["provider"], l["provider_user_id"]],
              );
              await insertRow(d, LINKS, { ...l, collection_id: restoredColId });
            }
            kept.add(`${name}:${id}`);
          });
        }
      }
    }
    if (emails.size > 0) {
      const ids = [...emails.keys()];
      await step(`${name} emails`, async () => {
        const skipped = await carryEmails(d, table, emails);
        for (const id of ids) if (!skipped.includes(id)) kept.add(`${name}:${id}`);
        for (const id of skipped) failed.push(`${name} ${id} email (held by an account the restore brought back)`);
      });
    }
  }

  return { kept: kept.size, removedAdmins, failed };
}

/** The sentence a restore's answer adds, or "". */
export function describeCarry(s: CarrySummary): string {
  const parts: string[] = [];
  if (s.kept > 0) parts.push(`${s.kept} account${s.kept === 1 ? "" : "s"} kept the password, email, MFA and provider links set since the backup.`);
  if (s.removedAdmins.length > 0) {
    parts.push(`Admins deleted since the backup stay deleted and their API tokens are revoked: ${s.removedAdmins.join(", ")}.`);
  }
  if (s.failed.length > 0) {
    parts.push(`Not carried over, the backup's are in place, check them: ${s.failed.join("; ")}.`);
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
