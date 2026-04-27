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
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_auth_tokens_user ON vaultbase_auth_tokens(user_id, purpose)`);
  client.exec(`CREATE INDEX IF NOT EXISTS idx_vaultbase_auth_tokens_code ON vaultbase_auth_tokens(code, purpose)`);

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
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

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
      last_run_at INTEGER,
      next_run_at INTEGER,
      last_status TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
}
