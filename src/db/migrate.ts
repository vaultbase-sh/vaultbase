import type { Database } from "bun:sqlite";
import { getDb } from "./client.ts";

export async function runMigrations() {
  const db = getDb();
  const client = (db as unknown as { $client: Database }).$client;

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_collections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      fields TEXT NOT NULL DEFAULT '[]',
      list_rule TEXT,
      view_rule TEXT,
      create_rule TEXT,
      update_rule TEXT,
      delete_rule TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // Drop legacy single-table records (replaced by per-collection tables)
  client.exec(`DROP TABLE IF EXISTS vaultbase_records`);

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_users (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL REFERENCES vaultbase_collections(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

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

  client.exec(`
    CREATE TABLE IF NOT EXISTS vaultbase_logs (
      id TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      ip TEXT,
      auth_id TEXT,
      auth_type TEXT,
      auth_email TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // Idempotent ADD COLUMN for existing DBs
  for (const col of ["auth_id", "auth_type", "auth_email"]) {
    try { client.exec(`ALTER TABLE vaultbase_logs ADD COLUMN ${col} TEXT`); } catch { /* already exists */ }
  }

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
      collection_name TEXT NOT NULL DEFAULT '',
      event TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
}
