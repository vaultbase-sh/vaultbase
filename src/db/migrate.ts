/**
 * Bringing a database up to date at boot.
 *
 *   1. The fixed schema: every table, column and index in schema.ts and
 *      fixed-schema.ts, created or added where missing (ddl.ts). Runs on
 *      every start; idempotent and dialect-driven.
 *   2. Data migrations. The ones that upgrade old SQLite installs stay
 *      SQLite-only (they rewrite SQLite-era data with SQLite SQL), are
 *      idempotent and run on every start, as they always have; a database
 *      on another driver starts after them and never needs them. A
 *      migration that must run exactly once goes through {@link runOnce},
 *      which records it in `vaultbase_migrations`.
 *   3. Per-collection passes that are safe to repeat: timestamp indexes,
 *      full-text indexes where the driver has them, autodate columns.
 */
import type { Database } from "bun:sqlite";
import { getRawClient } from "./client.ts";
import { db, getDriver } from "./index.ts";
import { PostgresDriver } from "./postgres.ts";
import { ensureFixedSchema } from "./ddl.ts";

/**
 * `ALTER TABLE … ADD COLUMN`, tolerating only "the column is already there".
 * Every other failure — a locked or read-only database, a full disk, a typo —
 * used to be swallowed the same way, leaving the schema half-migrated with
 * nothing in the log; it now stops the migration. Used by the SQLite-only
 * upgrade of v0.10 auth tables.
 */
export function addColumn(client: Database, sql: string): void {
  try {
    client.exec(sql);
  } catch (e) {
    if (e instanceof Error && /duplicate column name/i.test(e.message)) return;
    throw e;
  }
}

/** Run `fn` once per database, under `key`, and remember that it ran. */
export async function runOnce(key: string, fn: () => Promise<void> | void): Promise<void> {
  const done = await db.get(`SELECT 1 FROM vaultbase_migrations WHERE key = ?`, [key]);
  if (done) return;
  await fn();
  await db.run(`INSERT INTO vaultbase_migrations (key, applied_at) VALUES (?, ?)`, [key, Math.floor(Date.now() / 1000)]);
}

export async function runMigrations() {
  // Several servers starting together on one Postgres database would race
  // each other's CREATE / ALTER ("tuple concurrently updated"): one at a
  // time, the rest find the work done.
  const driver = getDriver();
  if (driver instanceof PostgresDriver) return driver.withMigrationLock(runMigrationsNow);
  return runMigrationsNow();
}

async function runMigrationsNow() {
  await ensureFixedSchema();
  // The text function the Postgres search index is built on (core/fts.ts).
  await (await import("../core/fts.ts")).ensureSearchFunction();

  // Tables of earlier designs: single-table records, DB-backed logs.
  for (const t of ["vaultbase_records", "vaultbase_logs"]) {
    if ((await db.all(db.dialect.listColumnsSql(t))).length > 0) await db.exec(`DROP TABLE IF EXISTS ${t}`);
  }

  if (db.name === "sqlite") {
    const client = getRawClient();
    // ── v0.11: auth users moved to per-collection `vb_<auth-col>` tables ──
    // Old model: every auth user lived in shared `vaultbase_users` keyed by
    // `collection_id`. New model: each auth collection has a real `vb_<name>`
    // table with auth columns inline. ALTER+COPY first (idempotent), then
    // DROP `vaultbase_users` once every row has a home. The finalize step
    // may legitimately wait for an operator, so this runs every start.
    v0_11PrepAuthTables(client);
    v0_11FinalizeAuthMigration(client);
    // ── v0.17: one-time tokens are stored hashed ──
    hashLegacyAuthTokens(client);
    // ── v0.18: sign-up honours the auth collection's create rule ──
    openExistingAuthSignup(client);
  }

  // ── v0.12: created_at / updated_at indexes on record tables ──
  // New tables get them in createUserTable; backfill existing ones.
  const { ensureTimestampIndexes } = await import("../core/collections.ts");
  const tables = await db.all<{ name: string }>(`SELECT name FROM vaultbase_collections WHERE type != 'view'`);
  for (const { name } of tables) {
    try { await ensureTimestampIndexes(name); } catch { /* table missing — skip */ }
  }

  // ── v0.26.6: stored row counts for list totals (core/row-counts.ts) ──
  // Every start: cheap when the triggers are in place, and a table that lost
  // them (rebuilt outside the server) gets them back with a fresh count.
  const { ensureRowCount } = await import("../core/row-counts.ts");
  const { userTableName } = await import("../core/collections.ts");
  for (const { name } of tables) {
    try { await ensureRowCount(userTableName(name)); } catch { /* table missing — skip */ }
  }

  // ── v0.26.5: an index on every relation field ──
  // New fields get one in createUserTable / alterUserTable. Once, so an
  // index an admin dropped stays dropped.
  await runOnce("v0_26_5_relation_indexes", async () => {
    const { ensureRelationIndexes } = await import("../core/collections.ts");
    const rows = await db.all<{ name: string; fields: string }>(`SELECT name, fields FROM vaultbase_collections WHERE type != 'view'`);
    for (const { name, fields } of rows) {
      try { await ensureRelationIndexes(name, JSON.parse(fields)); } catch { /* table missing — skip */ }
    }
  });

  // ── v0.15: full-text index for `searchable` fields ──
  // No-op when the index already matches; (re)builds it otherwise.
  if (db.capabilities.fts !== "none") {
    const { syncFts } = await import("../core/fts.ts");
    const ftsRows = await db.all<{ name: string; fields: string }>(`SELECT name, fields FROM vaultbase_collections WHERE type != 'view'`);
    for (const { name, fields } of ftsRows) {
      try {
        const parsed = (JSON.parse(fields) as Array<{ name: string; type: string; implicit?: boolean }>)
          .filter((f) => !f.implicit);
        await syncFts(name, parsed);
      } catch (e) {
        console.error(`[migrate] search index for '${name}':`, e instanceof Error ? e.message : e);
      }
    }
  }

  // ── v0.22.1: autodate fields get their column ──
  await ensureAutodateColumns();

  // The settings store, read synchronously on every request: filled here
  // for a driver that cannot answer synchronously (api/settings.ts). SQLite
  // keeps filling it on first use, after any rows written directly.
  if (db.name !== "sqlite") {
    const { loadSettings } = await import("../api/settings.ts");
    await loadSettings();
  }
}

/**
 * autodate fields had no column before v0.22.1: the server computed the
 * value and then skipped it on insert and update. Add the column on every
 * collection that declares one, so records written from now on keep it.
 */
async function ensureAutodateColumns(): Promise<void> {
  const cols = await db.all<{ name: string; fields: string }>(`SELECT name, fields FROM vaultbase_collections WHERE type != 'view'`);
  for (const col of cols) {
    let fields: Array<{ name?: unknown; type?: unknown; system?: unknown; implicit?: unknown }> = [];
    try { fields = JSON.parse(col.fields || "[]") as typeof fields; } catch { continue; }
    let present: Set<string> | null = null;
    for (const f of fields) {
      if (f.type !== "autodate" || typeof f.name !== "string" || f.system || f.implicit) continue;
      if (!/^[a-z][a-z0-9_]*$/.test(f.name) || !/^[a-z0-9_]+$/.test(col.name)) continue;
      present ??= new Set((await db.all<{ name: string }>(db.dialect.listColumnsSql(`vb_${col.name}`))).map((r) => r.name));
      if (present.has(f.name)) continue;
      await db.exec(db.dialect.addColumn(`"vb_${col.name}"`, { name: `"${f.name}"`, type: "integer", primaryKey: false, notNull: false, unique: false }));
    }
  }
}

/**
 * Before v0.18, `/auth/:collection/register` (and `/anonymous`, `/promote`)
 * ignored the collection's create rule, so sign-up was open whatever the
 * rule said, and auth collections default to "Admin only". Now the rule is
 * enforced, so on the first boot after upgrading, existing auth collections
 * whose create rule is "Admin only" are set to public: sign-up keeps working
 * as before, and the rules page now shows it. Installs upgraded before the
 * migrations table existed carry a marker in vaultbase_settings instead.
 */
function openExistingAuthSignup(client: Database): void {
  const MARKER = "_migrations.v0_18_auth_create_rule";
  if (client.prepare(`SELECT 1 FROM vaultbase_settings WHERE key = ?`).get(MARKER)) return;
  const opened = client.prepare(
    `UPDATE vaultbase_collections SET create_rule = NULL, updated_at = unixepoch()
      WHERE type = 'auth' AND create_rule = ''
      RETURNING name`,
  ).all() as Array<{ name: string }>;
  if (opened.length > 0) {
    console.warn(
      `[migrate] sign-up now follows each auth collection's create rule. ` +
      `Set to public to keep sign-up open as before: ${opened.map((r) => r.name).join(", ")}. ` +
      `Set it to "Admin only" (or a rule) to close or restrict sign-up.`,
    );
  }
  client.prepare(
    `INSERT OR IGNORE INTO vaultbase_settings (key, value, updated_at) VALUES (?, '1', unixepoch())`,
  ).run(MARKER);
}

/**
 * Rows in `vaultbase_auth_tokens` written before v0.17 are keyed by the raw
 * token. Re-key them by `h:` + SHA-256, the form the auth API looks up, so
 * links issued before an upgrade keep working and nothing readable from the
 * database works as a token. Live OTP rows also hold their 6-digit code in
 * plaintext and there's no secret here to re-key it with, so they are
 * voided instead (they last ten minutes; the user asks for a new code).
 * Internal rows (`totp_step`, `refresh_rotation`) aren't tokens. Idempotent.
 */
function hashLegacyAuthTokens(client: Database): void {
  const now = Math.floor(Date.now() / 1000);
  client.prepare(
    `UPDATE vaultbase_auth_tokens SET used_at = ?, code = NULL
      WHERE purpose = 'otp' AND code IS NOT NULL AND code NOT LIKE 'hmac:%'`,
  ).run(now);
  const rows = client.prepare(
    `SELECT id FROM vaultbase_auth_tokens
      WHERE id NOT LIKE 'h:%' AND purpose NOT IN ('totp_step', 'refresh_rotation')`,
  ).all() as Array<{ id: string }>;
  // OR IGNORE, then drop what couldn't move: a row whose hashed id is
  // already taken (a raw id can be anything a caller chose, e.g. an OAuth
  // `state` of "h:…") must not stop the server from booting.
  const rekey = client.prepare(`UPDATE OR IGNORE vaultbase_auth_tokens SET id = ? WHERE id = ?`);
  const drop = client.prepare(`DELETE FROM vaultbase_auth_tokens WHERE id = ?`);
  for (const r of rows) {
    if (rekey.run("h:" + new Bun.CryptoHasher("sha256").update(r.id).digest("hex"), r.id).changes === 0) drop.run(r.id);
  }
}

/**
 * Drop `vaultbase_users` once every row has been mirrored to a
 * `vb_<auth-col>` table. Runs after `v0_11PrepAuthTables`. Idempotent —
 * if the table is already gone the function returns immediately.
 *
 * Safety: refuses to drop if any row in `vaultbase_users` is missing
 * from the corresponding per-collection table. Operator must run
 * `vaultbase doctor` and reconcile before the next boot.
 */
function v0_11FinalizeAuthMigration(client: Database): void {
  const exists = client.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='vaultbase_users'`,
  ).get() as { name: string } | undefined;
  if (!exists) return;

  const total = (client.prepare(`SELECT count(*) AS n FROM vaultbase_users`).get() as { n: number }).n;
  if (total === 0) {
    client.exec(`DROP TABLE vaultbase_users`);
    return;
  }

  // Verify every row was copied. If any are missing, leave the legacy
  // table in place so the operator can re-run migration / fix data.
  const authCols = client.prepare(
    `SELECT id, name FROM vaultbase_collections WHERE type='auth'`,
  ).all() as Array<{ id: string; name: string }>;
  let copied = 0;
  for (const c of authCols) {
    const tbl = `vb_${c.name}`;
    const quoted = `"${tbl.replace(/"/g, '""')}"`;
    try {
      const matched = (client.prepare(
        `SELECT count(u.id) AS n FROM vaultbase_users u
         JOIN ${quoted} v ON v.id = u.id
         WHERE u.collection_id = ?`,
      ).get(c.id) as { n: number }).n;
      copied += matched;
    } catch { /* per-table query failed — be conservative, don't drop */ return; }
  }
  if (copied >= total) {
    client.exec(`DROP TABLE vaultbase_users`);
  } else {
    process.stderr.write(
      `[vaultbase] WARN: vaultbase_users still has ${total - copied} row(s) not yet ` +
      `mirrored to per-collection vb_<auth-col> tables. Run \`vaultbase doctor\` and ` +
      `reconcile before the next boot — the legacy table will not be dropped until clean.\n`,
    );
  }
}

/** Per-auth-collection table prep for v0.10 installs. Skips when `vaultbase_users` is gone. */
function v0_11PrepAuthTables(client: Database): void {
  // Skip entirely if vaultbase_users doesn't exist (fresh install, or already migrated).
  const usersTableExists = client.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='vaultbase_users'`,
  ).get() as { name: string } | undefined;
  if (!usersTableExists) return;

  const authCols = client.prepare(
    `SELECT id, name, fields FROM vaultbase_collections WHERE type='auth'`,
  ).all() as Array<{ id: string; name: string; fields: string }>;

  for (const col of authCols) {
    const tbl = `vb_${col.name}`;
    const quoted = `"${tbl.replace(/"/g, '""')}"`;

    // 1. ALTER ADD auth columns (idempotent).
    const authColumns = [
      ["email",             "TEXT"],
      ["password_hash",     "TEXT"],
      ["email_verified",    "INTEGER NOT NULL DEFAULT 0"],
      ["totp_secret",       "TEXT"],
      ["totp_enabled",      "INTEGER NOT NULL DEFAULT 0"],
      ["is_anonymous",      "INTEGER NOT NULL DEFAULT 0"],
      ["password_reset_at", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [name, sql] of authColumns) {
      addColumn(client, `ALTER TABLE ${quoted} ADD COLUMN "${name}" ${sql}`);
    }

    // 2. ALTER ADD custom-field columns from the collection's `fields` JSON
    // (skip implicit + autodate). Idempotent.
    let fields: Array<{ name?: unknown; type?: unknown; implicit?: unknown; system?: unknown }> = [];
    try { fields = JSON.parse(col.fields || "[]") as typeof fields; } catch { /* skip */ }
    for (const f of fields) {
      if (typeof f.name !== "string") continue;
      if (f.implicit || f.system || f.type === "autodate") continue;
      // SQL ident safety: collections.ts validated these at create time.
      const colName = `"${f.name.replace(/"/g, '""')}"`;
      let sqlType: string;
      switch (f.type) {
        case "number":   sqlType = "REAL"; break;
        case "bool":     sqlType = "INTEGER"; break;
        case "date":     sqlType = "INTEGER"; break;
        default:         sqlType = "TEXT"; break;
      }
      addColumn(client, `ALTER TABLE ${quoted} ADD COLUMN ${colName} ${sqlType}`);
    }

    // 3. Copy rows from vaultbase_users into vb_<name>. INSERT OR IGNORE so
    // re-running on already-migrated installs is a no-op. The custom-column
    // values are pulled from the row's `data` JSON via json_extract.
    const customColNames = (fields
      .filter((f) => typeof f.name === "string" && !f.implicit && !f.system && f.type !== "autodate")
      .map((f) => f.name as string));

    const insertCols = [
      "id", "email", "password_hash", "email_verified", "totp_secret",
      "totp_enabled", "is_anonymous", "created_at", "updated_at",
      ...customColNames,
    ];
    const insertColsList = insertCols.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");

    // Build SELECT list. Custom cols come from json_extract on `data`.
    const selectExprs = [
      `id`, `email`, `password_hash`, `email_verified`, `totp_secret`,
      `totp_enabled`, `is_anonymous`, `created_at`, `updated_at`,
      ...customColNames.map((c) => `json_extract(data, '$."${c.replace(/"/g, '""')}"')`),
    ];
    const selectList = selectExprs.join(", ");

    const sql = `INSERT OR IGNORE INTO ${quoted} (${insertColsList}) ` +
                `SELECT ${selectList} FROM vaultbase_users WHERE collection_id = ?`;
    try {
      client.prepare(sql).run(col.id);
    } catch (e) {
      process.stderr.write(
        `[vaultbase] WARN: v0.11 auth-table prep failed for collection '${col.name}': ` +
        `${e instanceof Error ? e.message : String(e)}\n`,
      );
    }

    // 4. UNIQUE index on email — collection-local. Skip silently if
    // duplicates exist (doctor will flag them).
    try {
      client.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "idx_${tbl}_email" ON ${quoted}(email) WHERE email IS NOT NULL`);
    } catch { /* duplicate emails — operator must reconcile via doctor */ }
  }
}
