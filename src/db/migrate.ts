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

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_users (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL REFERENCES vaultbase_collections(id) ON DELETE CASCADE,
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
  try { client.exec(`ALTER TABLE vaultbase_users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  try { client.exec(`ALTER TABLE vaultbase_users ADD COLUMN totp_secret TEXT`); } catch { /* exists */ }
  try { client.exec(`ALTER TABLE vaultbase_users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  try { client.exec(`ALTER TABLE vaultbase_users ADD COLUMN is_anonymous INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }

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
}
