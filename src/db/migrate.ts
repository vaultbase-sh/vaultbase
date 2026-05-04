import type { Database } from "bun:sqlite";
import { getDb } from "./client.ts";

export async function runMigrations() {
  const db = getDb();
  const client = (db as unknown as { $client: Database }).$client;

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_collections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL DEFAULT 'base',
      fields TEXT NOT NULL DEFAULT '[]',
      view_query TEXT,
      list_rule TEXT,
      view_rule TEXT,
      create_rule TEXT,
      update_rule TEXT,
      delete_rule TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  try { client.exec(`ALTER TABLE vaultbase_collections ADD COLUMN type TEXT NOT NULL DEFAULT 'base'`); } catch { /* exists */ }
  try { client.exec(`ALTER TABLE vaultbase_collections ADD COLUMN view_query TEXT`); } catch { /* exists */ }
  try { client.exec(`ALTER TABLE vaultbase_collections ADD COLUMN history_enabled INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }

  // Drop legacy single-table records (replaced by per-collection tables)
  client.exec(`DROP TABLE IF EXISTS vaultbase_records`);

  // v0.11: `vaultbase_users` is no longer the source of truth for auth
  // users — each auth collection has its own `vb_<name>` table with auth
  // columns inline. The CREATE block stays here only so v0.10 → v0.11
  // upgrades have a table to read from in `v0_11PrepAuthTables`. Once
  // every row is mirrored, `v0_11FinalizeAuthMigration` drops it.
  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_users (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0,
      totp_secret TEXT,
      totp_enabled INTEGER NOT NULL DEFAULT 0,
      is_anonymous INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_auth_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      code TEXT,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  try { client.exec(`ALTER TABLE vaultbase_auth_tokens ADD COLUMN code TEXT`); } catch { /* exists */ }
  try { client.exec(`ALTER TABLE vaultbase_auth_tokens ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_auth_tokens_user ON vaultbase_auth_tokens(user_id, purpose)`);
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_auth_tokens_code ON vaultbase_auth_tokens(code, purpose)`);

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_token_revocations (
      jti TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_token_revocations_exp ON vaultbase_token_revocations(expires_at)`);

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_mfa_recovery_lookup (
      hmac TEXT PRIMARY KEY,
      recovery_id TEXT NOT NULL
    )
  `);

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_mfa_recovery_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_mfa_recovery_codes_user ON vaultbase_mfa_recovery_codes(user_id, collection_id)`);

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_oauth_links (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      provider_email TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  client.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_vaultbase_oauth_links_provider ON vaultbase_oauth_links(provider, provider_user_id)`);
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_oauth_links_user ON vaultbase_oauth_links(user_id)`);

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_admin (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_reset_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  try { client.exec(`ALTER TABLE vaultbase_admin ADD COLUMN password_reset_at INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  try { client.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_vaultbase_admin_email ON vaultbase_admin(email)`); } catch { /* exists */ }

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_files (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      field_name TEXT NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // Logs are now stored as JSONL files (see core/file-logger.ts).
  // Drop legacy DB-backed logs table if upgrading from an older install.
  client.exec(`DROP TABLE IF EXISTS vaultbase_logs`);

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_hooks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      collection_name TEXT NOT NULL DEFAULT '',
      event TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  // Idempotent ADD COLUMN for existing DBs
  try { client.exec(`ALTER TABLE vaultbase_hooks ADD COLUMN name TEXT NOT NULL DEFAULT ''`); } catch { /* exists */ }

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_routes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      cron TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      mode TEXT NOT NULL DEFAULT 'inline',
      last_run_at INTEGER,
      next_run_at INTEGER,
      last_status TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  // Idempotent ALTER: pre-existing installs missing the mode column
  try { client.exec(`ALTER TABLE vaultbase_jobs ADD COLUMN mode TEXT NOT NULL DEFAULT 'inline'`); } catch { /* exists */ }

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_workers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      queue TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      concurrency INTEGER NOT NULL DEFAULT 1,
      retry_max INTEGER NOT NULL DEFAULT 3,
      retry_backoff TEXT NOT NULL DEFAULT 'exponential',
      retry_delay_ms INTEGER NOT NULL DEFAULT 1000,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_workers_queue ON vaultbase_workers(queue)`);

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_jobs_log (
      id TEXT PRIMARY KEY,
      queue TEXT NOT NULL,
      worker_id TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      unique_key TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'queued',
      error TEXT,
      scheduled_at INTEGER NOT NULL DEFAULT (unixepoch()),
      enqueued_at INTEGER NOT NULL DEFAULT (unixepoch()),
      started_at INTEGER,
      finished_at INTEGER
    )
  `);
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_jobs_log_status ON vaultbase_jobs_log(queue, status, scheduled_at)`);
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_jobs_log_unique ON vaultbase_jobs_log(unique_key, status)`);

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_record_history (
      id TEXT PRIMARY KEY,
      collection TEXT NOT NULL,
      record_id TEXT NOT NULL,
      op TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      actor_id TEXT,
      actor_type TEXT,
      at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_record_history_lookup ON vaultbase_record_history(collection, record_id, at)`);
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_record_history_at ON vaultbase_record_history(at)`);

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_audit_log (
      id TEXT PRIMARY KEY,
      actor_id TEXT,
      actor_email TEXT,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT,
      status INTEGER NOT NULL,
      ip TEXT,
      summary TEXT,
      at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_audit_log_actor ON vaultbase_audit_log(actor_id, at)`);
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_audit_log_at ON vaultbase_audit_log(at)`);
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_audit_log_action ON vaultbase_audit_log(action, at)`);

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_admin_sessions (
      jti TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL,
      admin_email TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      ip TEXT,
      user_agent TEXT
    )
  `);
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_admin_sessions_admin ON vaultbase_admin_sessions(admin_id)`);
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_admin_sessions_exp ON vaultbase_admin_sessions(expires_at)`);

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_login_failures (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      at INTEGER NOT NULL
    )
  `);
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_login_failures_key ON vaultbase_login_failures(key, at)`);
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_login_failures_at ON vaultbase_login_failures(at)`);

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_webhooks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '[]',
      secret TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      retry_max INTEGER NOT NULL DEFAULT 3,
      retry_backoff TEXT NOT NULL DEFAULT 'exponential',
      retry_delay_ms INTEGER NOT NULL DEFAULT 1000,
      timeout_ms INTEGER NOT NULL DEFAULT 30000,
      custom_headers TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_webhook_deliveries (
      id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL,
      event TEXT NOT NULL,
      payload TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      response_status INTEGER,
      response_body TEXT,
      error TEXT,
      scheduled_at INTEGER NOT NULL,
      delivered_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_webhook_deliveries_status ON vaultbase_webhook_deliveries(status, scheduled_at)`);
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_webhook_deliveries_webhook ON vaultbase_webhook_deliveries(webhook_id, created_at)`);

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_flag_segments (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      conditions TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_feature_flags (
      key TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'bool',
      enabled INTEGER NOT NULL DEFAULT 1,
      default_value TEXT NOT NULL DEFAULT 'false',
      variations TEXT NOT NULL DEFAULT '[]',
      rules TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_file_token_uses (
      jti TEXT PRIMARY KEY,
      used_at INTEGER NOT NULL,
      ip TEXT
    )
  `);
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_file_token_uses_used_at ON vaultbase_file_token_uses(used_at)`);

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_api_tokens (
      id               TEXT PRIMARY KEY,
      name             TEXT NOT NULL,
      scopes           TEXT NOT NULL DEFAULT '[]',
      created_by       TEXT NOT NULL,
      created_by_email TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      expires_at       INTEGER NOT NULL,
      revoked_at       INTEGER,
      last_used_at     INTEGER,
      last_used_ip     TEXT,
      last_used_ua     TEXT,
      use_count        INTEGER NOT NULL DEFAULT 0
    )
  `);
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_api_tokens_created_by ON vaultbase_api_tokens(created_by)`);
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_api_tokens_expires ON vaultbase_api_tokens(expires_at)`);

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_sql_queries (
      id                 TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      sql                TEXT NOT NULL,
      description        TEXT,
      owner_admin_id     TEXT NOT NULL,
      owner_admin_email  TEXT NOT NULL,
      created_at         INTEGER NOT NULL,
      updated_at         INTEGER NOT NULL,
      last_run_at        INTEGER,
      last_run_ms        INTEGER,
      last_row_count     INTEGER,
      last_error         TEXT
    )
  `);
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_sql_queries_owner ON vaultbase_sql_queries(owner_admin_id, updated_at DESC)`);

  // ── v0.11: auth users moved to per-collection `vb_<auth-col>` tables ──
  //
  // Old model: every auth user lived in shared `vaultbase_users` keyed by
  // `collection_id`. New model: each auth collection gets a real
  // `vb_<name>` table with auth columns inline. Migration: ALTER+COPY
  // first run (idempotent), then DROP `vaultbase_users` once every row
  // has a home in its per-collection table.
  v0_11PrepAuthTables(client);
  v0_11FinalizeAuthMigration(client);
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

/** Per-auth-collection table prep. Exported for the doctor CLI to dry-run. */
function v0_11PrepAuthTables(client: Database): void {
  // Skip entirely if vaultbase_users doesn't exist yet (fresh install).
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
      try { client.exec(`ALTER TABLE ${quoted} ADD COLUMN "${name}" ${sql}`); }
      catch { /* column exists */ }
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
      try { client.exec(`ALTER TABLE ${quoted} ADD COLUMN ${colName} ${sqlType}`); }
      catch { /* column exists */ }
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
