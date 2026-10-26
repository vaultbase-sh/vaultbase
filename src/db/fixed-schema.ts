/**
 * The fixed tables in creation order, and their indexes. The columns come
 * from the drizzle declarations in schema.ts (see ddl.ts); only what
 * drizzle's sqlite-core cannot express is listed here: the indexes, with
 * their column expressions and partial predicates, in the words the
 * database has always seen.
 */
import * as s from "./schema.ts";
import type { IndexSpec } from "./ddl.ts";

export const FIXED_TABLES = [
  s.collections,
  s.authTokens,
  s.tokenRevocations,
  s.mfaRecoveryLookup,
  s.mfaRecoveryCodes,
  s.oauthLinks,
  s.admin,
  s.files,
  s.settings,
  s.hooks,
  s.routes,
  s.jobs,
  s.workers,
  s.jobsLog,
  s.recordHistory,
  s.auditLog,
  s.adminSessions,
  s.loginFailures,
  s.webhooks,
  s.webhookDeliveries,
  s.flagSegments,
  s.featureFlags,
  s.fileTokenUses,
  s.apiTokens,
  s.sqlQueries,
  s.migrations,
  s.install,
] as const;

const ix = (name: string, table: string, columns: string[], extra: Partial<IndexSpec> = {}): IndexSpec => ({ name, table, columns, ...extra });

export const FIXED_INDEXES: IndexSpec[] = [
  ix("idx_vaultbase_auth_tokens_user", "vaultbase_auth_tokens", ["user_id", "purpose"]),
  ix("idx_vaultbase_auth_tokens_code", "vaultbase_auth_tokens", ["code", "purpose"]),
  ix("idx_vaultbase_token_revocations_exp", "vaultbase_token_revocations", ["expires_at"]),
  ix("idx_vaultbase_mfa_recovery_codes_user", "vaultbase_mfa_recovery_codes", ["user_id", "collection_id"]),
  ix("idx_vaultbase_oauth_links_provider", "vaultbase_oauth_links", ["provider", "provider_user_id"], { unique: true }),
  ix("idx_vaultbase_oauth_links_user", "vaultbase_oauth_links", ["user_id"]),
  ix("idx_vaultbase_admin_email", "vaultbase_admin", ["email"], { unique: true }),
  ix("idx_vaultbase_files_filename", "vaultbase_files", ["filename"]),
  ix("idx_vaultbase_files_record", "vaultbase_files", ["collection_id", "record_id", "field_name"]),
  ix("idx_vaultbase_workers_queue", "vaultbase_workers", ["queue"]),
  // Where each hook / route / job / worker's code lives (code-files.ts): one row per file.
  ...["vaultbase_hooks", "vaultbase_routes", "vaultbase_jobs", "vaultbase_workers"].map((t) =>
    ix(`idx_${t}_file_path`, t, ["file_path"], { unique: true, where: "file_path IS NOT NULL" })),
  ix("idx_vaultbase_jobs_log_status", "vaultbase_jobs_log", ["queue", "status", "scheduled_at"]),
  ix("idx_vaultbase_jobs_log_unique", "vaultbase_jobs_log", ["unique_key", "status"]),
  // One queued-or-running job per unique key (queues.ts enqueue). Existing
  // duplicates are cleared first (ddl.ts ensureFixedSchema).
  ix("idx_vaultbase_jobs_log_unique_active", "vaultbase_jobs_log", ["unique_key"], {
    unique: true, where: "unique_key IS NOT NULL AND status IN ('queued', 'running')",
  }),
  ix("idx_vaultbase_record_history_lookup", "vaultbase_record_history", ["collection", "record_id", "at"]),
  ix("idx_vaultbase_record_history_at", "vaultbase_record_history", ["at"]),
  ix("idx_vaultbase_audit_log_actor", "vaultbase_audit_log", ["actor_id", "at"]),
  ix("idx_vaultbase_audit_log_at", "vaultbase_audit_log", ["at"]),
  ix("idx_vaultbase_audit_log_action", "vaultbase_audit_log", ["action", "at"]),
  ix("idx_vaultbase_admin_sessions_admin", "vaultbase_admin_sessions", ["admin_id"]),
  ix("idx_vaultbase_admin_sessions_exp", "vaultbase_admin_sessions", ["expires_at"]),
  ix("idx_vaultbase_login_failures_key", "vaultbase_login_failures", ["key", "at"]),
  ix("idx_vaultbase_login_failures_at", "vaultbase_login_failures", ["at"]),
  ix("idx_vaultbase_webhook_deliveries_status", "vaultbase_webhook_deliveries", ["status", "scheduled_at"]),
  ix("idx_vaultbase_webhook_deliveries_webhook", "vaultbase_webhook_deliveries", ["webhook_id", "created_at"]),
  ix("idx_vaultbase_file_token_uses_used_at", "vaultbase_file_token_uses", ["used_at"]),
  ix("idx_vaultbase_api_tokens_created_by", "vaultbase_api_tokens", ["created_by"]),
  ix("idx_vaultbase_api_tokens_expires", "vaultbase_api_tokens", ["expires_at"]),
  ix("idx_vaultbase_sql_queries_owner", "vaultbase_sql_queries", ["owner_admin_id", "updated_at DESC"]),
];
