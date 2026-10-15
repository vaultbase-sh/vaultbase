-- index idx_vaultbase_admin_email
CREATE UNIQUE INDEX idx_vaultbase_admin_email ON vaultbase_admin(email);

-- index idx_vaultbase_admin_sessions_admin
CREATE INDEX idx_vaultbase_admin_sessions_admin ON vaultbase_admin_sessions(admin_id);

-- index idx_vaultbase_admin_sessions_exp
CREATE INDEX idx_vaultbase_admin_sessions_exp ON vaultbase_admin_sessions(expires_at);

-- index idx_vaultbase_api_tokens_created_by
CREATE INDEX idx_vaultbase_api_tokens_created_by ON vaultbase_api_tokens(created_by);

-- index idx_vaultbase_api_tokens_expires
CREATE INDEX idx_vaultbase_api_tokens_expires ON vaultbase_api_tokens(expires_at);

-- index idx_vaultbase_audit_log_action
CREATE INDEX idx_vaultbase_audit_log_action ON vaultbase_audit_log(action, at);

-- index idx_vaultbase_audit_log_actor
CREATE INDEX idx_vaultbase_audit_log_actor ON vaultbase_audit_log(actor_id, at);

-- index idx_vaultbase_audit_log_at
CREATE INDEX idx_vaultbase_audit_log_at ON vaultbase_audit_log(at);

-- index idx_vaultbase_auth_tokens_code
CREATE INDEX idx_vaultbase_auth_tokens_code ON vaultbase_auth_tokens(code, purpose);

-- index idx_vaultbase_auth_tokens_user
CREATE INDEX idx_vaultbase_auth_tokens_user ON vaultbase_auth_tokens(user_id, purpose);

-- index idx_vaultbase_file_token_uses_used_at
CREATE INDEX idx_vaultbase_file_token_uses_used_at ON vaultbase_file_token_uses(used_at);

-- index idx_vaultbase_files_filename
CREATE INDEX idx_vaultbase_files_filename ON vaultbase_files(filename);

-- index idx_vaultbase_files_record
CREATE INDEX idx_vaultbase_files_record ON vaultbase_files(collection_id, record_id, field_name);

-- index idx_vaultbase_hooks_file_path
CREATE UNIQUE INDEX idx_vaultbase_hooks_file_path ON vaultbase_hooks(file_path) WHERE file_path IS NOT NULL;

-- index idx_vaultbase_jobs_file_path
CREATE UNIQUE INDEX idx_vaultbase_jobs_file_path ON vaultbase_jobs(file_path) WHERE file_path IS NOT NULL;

-- index idx_vaultbase_jobs_log_status
CREATE INDEX idx_vaultbase_jobs_log_status ON vaultbase_jobs_log(queue, status, scheduled_at);

-- index idx_vaultbase_jobs_log_unique
CREATE INDEX idx_vaultbase_jobs_log_unique ON vaultbase_jobs_log(unique_key, status);

-- index idx_vaultbase_login_failures_at
CREATE INDEX idx_vaultbase_login_failures_at ON vaultbase_login_failures(at);

-- index idx_vaultbase_login_failures_key
CREATE INDEX idx_vaultbase_login_failures_key ON vaultbase_login_failures(key, at);

-- index idx_vaultbase_mfa_recovery_codes_user
CREATE INDEX idx_vaultbase_mfa_recovery_codes_user ON vaultbase_mfa_recovery_codes(user_id, collection_id);

-- index idx_vaultbase_oauth_links_provider
CREATE UNIQUE INDEX idx_vaultbase_oauth_links_provider ON vaultbase_oauth_links(provider, provider_user_id);

-- index idx_vaultbase_oauth_links_user
CREATE INDEX idx_vaultbase_oauth_links_user ON vaultbase_oauth_links(user_id);

-- index idx_vaultbase_record_history_at
CREATE INDEX idx_vaultbase_record_history_at ON vaultbase_record_history(at);

-- index idx_vaultbase_record_history_lookup
CREATE INDEX idx_vaultbase_record_history_lookup ON vaultbase_record_history(collection, record_id, at);

-- index idx_vaultbase_routes_file_path
CREATE UNIQUE INDEX idx_vaultbase_routes_file_path ON vaultbase_routes(file_path) WHERE file_path IS NOT NULL;

-- index idx_vaultbase_sql_queries_owner
CREATE INDEX idx_vaultbase_sql_queries_owner ON vaultbase_sql_queries(owner_admin_id, updated_at DESC);

-- index idx_vaultbase_token_revocations_exp
CREATE INDEX idx_vaultbase_token_revocations_exp ON vaultbase_token_revocations(expires_at);

-- index idx_vaultbase_webhook_deliveries_status
CREATE INDEX idx_vaultbase_webhook_deliveries_status ON vaultbase_webhook_deliveries(status, scheduled_at);

-- index idx_vaultbase_webhook_deliveries_webhook
CREATE INDEX idx_vaultbase_webhook_deliveries_webhook ON vaultbase_webhook_deliveries(webhook_id, created_at);

-- index idx_vaultbase_workers_file_path
CREATE UNIQUE INDEX idx_vaultbase_workers_file_path ON vaultbase_workers(file_path) WHERE file_path IS NOT NULL;

-- index idx_vaultbase_workers_queue
CREATE INDEX idx_vaultbase_workers_queue ON vaultbase_workers(queue);

-- table vaultbase_admin
CREATE TABLE vaultbase_admin (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_reset_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

-- table vaultbase_admin_sessions
CREATE TABLE vaultbase_admin_sessions (
      jti TEXT PRIMARY KEY,
      admin_id TEXT NOT NULL,
      admin_email TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      ip TEXT,
      user_agent TEXT
    );

-- table vaultbase_api_tokens
CREATE TABLE vaultbase_api_tokens (
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
    );

-- table vaultbase_audit_log
CREATE TABLE vaultbase_audit_log (
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
    );

-- table vaultbase_auth_tokens
CREATE TABLE vaultbase_auth_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      code TEXT,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    , attempts INTEGER NOT NULL DEFAULT 0, payload TEXT);

-- table vaultbase_collections
CREATE TABLE vaultbase_collections (
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
    , history_enabled INTEGER NOT NULL DEFAULT 0);

-- table vaultbase_feature_flags
CREATE TABLE vaultbase_feature_flags (
      key TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'bool',
      enabled INTEGER NOT NULL DEFAULT 1,
      default_value TEXT NOT NULL DEFAULT 'false',
      variations TEXT NOT NULL DEFAULT '[]',
      rules TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

-- table vaultbase_file_token_uses
CREATE TABLE vaultbase_file_token_uses (
      jti TEXT PRIMARY KEY,
      used_at INTEGER NOT NULL,
      ip TEXT
    );

-- table vaultbase_files
CREATE TABLE vaultbase_files (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      field_name TEXT NOT NULL,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

-- table vaultbase_flag_segments
CREATE TABLE vaultbase_flag_segments (
      name TEXT PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      conditions TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

-- table vaultbase_hooks
CREATE TABLE vaultbase_hooks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      collection_name TEXT NOT NULL DEFAULT '',
      event TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    , origin TEXT NOT NULL DEFAULT 'inline', file_path TEXT, file_error TEXT);

-- table vaultbase_jobs
CREATE TABLE vaultbase_jobs (
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
    , origin TEXT NOT NULL DEFAULT 'inline', file_path TEXT, file_error TEXT);

-- table vaultbase_jobs_log
CREATE TABLE vaultbase_jobs_log (
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
    , retry_max INTEGER, retry_backoff TEXT, retry_delay_ms INTEGER);

-- table vaultbase_login_failures
CREATE TABLE vaultbase_login_failures (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL,
      at INTEGER NOT NULL
    );

-- table vaultbase_mfa_recovery_codes
CREATE TABLE vaultbase_mfa_recovery_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      used_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

-- table vaultbase_mfa_recovery_lookup
CREATE TABLE vaultbase_mfa_recovery_lookup (
      hmac TEXT PRIMARY KEY,
      recovery_id TEXT NOT NULL
    );

-- table vaultbase_oauth_links
CREATE TABLE vaultbase_oauth_links (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      collection_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      provider_email TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

-- table vaultbase_record_history
CREATE TABLE vaultbase_record_history (
      id TEXT PRIMARY KEY,
      collection TEXT NOT NULL,
      record_id TEXT NOT NULL,
      op TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      actor_id TEXT,
      actor_type TEXT,
      at INTEGER NOT NULL DEFAULT (unixepoch())
    );

-- table vaultbase_routes
CREATE TABLE vaultbase_routes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      code TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    , require_auth INTEGER NOT NULL DEFAULT 0, origin TEXT NOT NULL DEFAULT 'inline', file_path TEXT, file_error TEXT);

-- table vaultbase_settings
CREATE TABLE vaultbase_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

-- table vaultbase_sql_queries
CREATE TABLE vaultbase_sql_queries (
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
    );

-- table vaultbase_token_revocations
CREATE TABLE vaultbase_token_revocations (
      jti TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

-- table vaultbase_webhook_deliveries
CREATE TABLE vaultbase_webhook_deliveries (
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
    );

-- table vaultbase_webhooks
CREATE TABLE vaultbase_webhooks (
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
    );

-- table vaultbase_workers
CREATE TABLE vaultbase_workers (
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
    , origin TEXT NOT NULL DEFAULT 'inline', file_path TEXT, file_error TEXT);

