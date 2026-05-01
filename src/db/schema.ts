import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const collections = sqliteTable("vaultbase_collections", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  type: text("type").notNull().default("base"),
  fields: text("fields").notNull().default("[]"),
  view_query: text("view_query"),
  list_rule: text("list_rule"),
  view_rule: text("view_rule"),
  create_rule: text("create_rule"),
  update_rule: text("update_rule"),
  delete_rule: text("delete_rule"),
  /** When 1, every record write produces a `vaultbase_record_history` row. */
  history_enabled: integer("history_enabled").notNull().default(0),
  created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch())`),
});

/**
 * Append-only audit + restore log of record writes for collections that have
 * `history_enabled=1`. Snapshot is the post-write record state on
 * create/update, and the pre-delete state on delete.
 */
export const recordHistory = sqliteTable("vaultbase_record_history", {
  id: text("id").primaryKey(),
  collection: text("collection").notNull(),
  record_id: text("record_id").notNull(),
  /** "create" | "update" | "delete" */
  op: text("op").notNull(),
  /** JSON-encoded record snapshot (post-write for create/update; pre-delete for delete). */
  snapshot: text("snapshot").notNull(),
  /** Caller id, or null for unauthenticated / cron / hook contexts. */
  actor_id: text("actor_id"),
  /** "user" | "admin" | null. */
  actor_type: text("actor_type"),
  /** Unix-seconds timestamp of the write. */
  at: integer("at").notNull().default(sql`(unixepoch())`),
});

export const users = sqliteTable("vaultbase_users", {
  id: text("id").primaryKey(),
  collection_id: text("collection_id")
    .notNull()
    .references(() => collections.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  password_hash: text("password_hash").notNull(),
  email_verified: integer("email_verified").notNull().default(0),
  totp_secret: text("totp_secret"),
  totp_enabled: integer("totp_enabled").notNull().default(0),
  is_anonymous: integer("is_anonymous").notNull().default(0),
  data: text("data").notNull().default("{}"),
  created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch())`),
});

export const authTokens = sqliteTable("vaultbase_auth_tokens", {
  id: text("id").primaryKey(),
  user_id: text("user_id").notNull(),
  collection_id: text("collection_id").notNull(),
  purpose: text("purpose").notNull(),
  /** Short numeric code for OTP flow; nullable for token-only purposes. */
  code: text("code"),
  /** Failed attempts for OTP/MFA brute-force protection. */
  attempts: integer("attempts").notNull().default(0),
  expires_at: integer("expires_at").notNull(),
  used_at: integer("used_at"),
  created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
});

/** JWT revocation list. Tokens carrying a `jti` listed here are rejected. */
export const tokenRevocations = sqliteTable("vaultbase_token_revocations", {
  jti: text("jti").primaryKey(),
  expires_at: integer("expires_at").notNull(),
  revoked_at: integer("revoked_at").notNull().default(sql`(unixepoch())`),
});

/**
 * Active admin sessions, written when a JWT is issued and trimmed when it
 * expires. Drives the **Settings → Security → Sessions** view + per-jti
 * revoke. Distinct from `vaultbase_token_revocations` (which only records
 * negatives — this table records positives).
 */
export const adminSessions = sqliteTable("vaultbase_admin_sessions", {
  jti: text("jti").primaryKey(),
  admin_id: text("admin_id").notNull(),
  admin_email: text("admin_email").notNull(),
  issued_at: integer("issued_at").notNull(),
  expires_at: integer("expires_at").notNull(),
  /** Best-effort, derived from X-Forwarded-For only when peer is in TRUSTED_PROXIES. */
  ip: text("ip"),
  user_agent: text("user_agent"),
});

/**
 * Failed login attempts — used by the brute-force lockout machinery. One row
 * per attempt; trimmed when older than `auth.lockout.duration_seconds`.
 */
export const loginFailures = sqliteTable("vaultbase_login_failures", {
  id: text("id").primaryKey(),
  /** "user:<email>" or "admin:<email>" or "ip:<ip>". */
  key: text("key").notNull(),
  at: integer("at").notNull(),
});

/** HMAC-keyed lookup for MFA recovery codes (no per-attempt argon2 fan-out). */
export const mfaRecoveryLookup = sqliteTable("vaultbase_mfa_recovery_lookup", {
  hmac: text("hmac").primaryKey(),
  recovery_id: text("recovery_id").notNull(),
});

export const mfaRecoveryCodes = sqliteTable("vaultbase_mfa_recovery_codes", {
  id: text("id").primaryKey(),
  user_id: text("user_id").notNull(),
  collection_id: text("collection_id").notNull(),
  code_hash: text("code_hash").notNull(),
  used_at: integer("used_at"),
  created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
});

export const oauthLinks = sqliteTable("vaultbase_oauth_links", {
  id: text("id").primaryKey(),
  user_id: text("user_id").notNull(),
  collection_id: text("collection_id").notNull(),
  provider: text("provider").notNull(),
  provider_user_id: text("provider_user_id").notNull(),
  provider_email: text("provider_email"),
  created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
});

export const admin = sqliteTable("vaultbase_admin", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  password_hash: text("password_hash").notNull(),
  /**
   * Tokens issued before this timestamp are rejected. Bumped on password reset
   * or admin-driven force-logout.
   */
  password_reset_at: integer("password_reset_at").notNull().default(0),
  created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
});

export const files = sqliteTable("vaultbase_files", {
  id: text("id").primaryKey(),
  collection_id: text("collection_id").notNull(),
  record_id: text("record_id").notNull(),
  field_name: text("field_name").notNull(),
  filename: text("filename").notNull(),
  original_name: text("original_name").notNull(),
  mime_type: text("mime_type").notNull(),
  size: integer("size").notNull(),
  created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
});

export const hooks = sqliteTable("vaultbase_hooks", {
  id: text("id").primaryKey(),
  name: text("name").notNull().default(""),
  collection_name: text("collection_name").notNull().default(""),
  event: text("event").notNull(),
  code: text("code").notNull().default(""),
  enabled: integer("enabled").notNull().default(1),
  created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch())`),
});

export const routes = sqliteTable("vaultbase_routes", {
  id: text("id").primaryKey(),
  name: text("name").notNull().default(""),
  method: text("method").notNull(),
  path: text("path").notNull(),
  code: text("code").notNull().default(""),
  enabled: integer("enabled").notNull().default(1),
  created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch())`),
});

export const jobs = sqliteTable("vaultbase_jobs", {
  id: text("id").primaryKey(),
  name: text("name").notNull().default(""),
  cron: text("cron").notNull(),
  code: text("code").notNull().default(""),
  enabled: integer("enabled").notNull().default(1),
  /**
   * "inline" (default): cron tick runs the job's code in-process.
   * "worker:<queue>": cron tick enqueues onto the named queue; a worker
   * consumes it asynchronously. Heavy work leaves the request runtime.
   */
  mode: text("mode").notNull().default("inline"),
  last_run_at: integer("last_run_at"),
  next_run_at: integer("next_run_at"),
  last_status: text("last_status"),       // "ok" | "error"
  last_error: text("last_error"),
  created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch())`),
});

/**
 * Worker definitions. A worker compiles user-supplied JS that pulls jobs
 * from a named queue and processes them. Multiple workers can share a
 * queue (concurrency adds across workers).
 */
export const workers = sqliteTable("vaultbase_workers", {
  id: text("id").primaryKey(),
  name: text("name").notNull().default(""),
  queue: text("queue").notNull(),
  code: text("code").notNull().default(""),
  enabled: integer("enabled").notNull().default(1),
  /** Max in-flight jobs this worker will process at once. */
  concurrency: integer("concurrency").notNull().default(1),
  /** Per-job retry budget — applied when the job's enqueue opts don't override. */
  retry_max: integer("retry_max").notNull().default(3),
  /** "exponential" (1s,2s,4s,…) or "fixed" (uses retry_delay_ms each time) */
  retry_backoff: text("retry_backoff").notNull().default("exponential"),
  /** Used as base for exponential / fixed delay between retries, in ms. */
  retry_delay_ms: integer("retry_delay_ms").notNull().default(1000),
  created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch())`),
});

/**
 * Append-only log of every job enqueued. Tracks lifecycle: queued →
 * running → succeeded / failed / dead. The actual queue primitives live
 * in-memory (Phase 1) or Redis (future Phase 2); this table is the
 * audit trail and admin dashboard data source.
 */
export const jobsLog = sqliteTable("vaultbase_jobs_log", {
  id: text("id").primaryKey(),
  queue: text("queue").notNull(),
  worker_id: text("worker_id"),
  /** JSON-encoded payload as enqueued. */
  payload: text("payload").notNull().default("{}"),
  /** Unique-key dedup (skip enqueue if a non-finished job has the same key). */
  unique_key: text("unique_key"),
  attempt: integer("attempt").notNull().default(1),
  status: text("status").notNull().default("queued"),  // queued | running | succeeded | failed | dead
  error: text("error"),
  /** Earliest time the job is allowed to run. Used for delayed jobs + retry backoff. */
  scheduled_at: integer("scheduled_at").notNull().default(sql`(unixepoch())`),
  enqueued_at: integer("enqueued_at").notNull().default(sql`(unixepoch())`),
  started_at: integer("started_at"),
  finished_at: integer("finished_at"),
});

export const settings = sqliteTable("vaultbase_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch())`),
});

/**
 * Append-only audit log of state-changing admin API calls. One row per
 * mutating request to /api/admin/* — captures who did what, when, and a
 * minimal summary. Never UPDATEd, never DELETEd through application code.
 *
 * Compliance value: SOC 2-curious shops typically need a "who did what"
 * trail; debugging value: "which admin deleted that collection three days
 * ago" lookups go from hard to one query.
 */
export const auditLog = sqliteTable("vaultbase_audit_log", {
  id: text("id").primaryKey(),
  /** Admin id from the JWT — null only on unauthenticated paths (rare for /admin). */
  actor_id: text("actor_id"),
  /** Email cached at the time of the action — survives admin row deletion. */
  actor_email: text("actor_email"),
  /** HTTP method on the admin endpoint. */
  method: text("method").notNull(),
  /** URL path (without query string) — e.g. "/api/admin/collections". */
  path: text("path").notNull(),
  /** Logical action label, e.g. "collection.create" / "settings.update". */
  action: text("action").notNull(),
  /** Best-effort target identifier (collection name, admin id, file id, ...). */
  target: text("target"),
  /** HTTP status code returned. */
  status: integer("status").notNull(),
  /** Source IP, reading X-Forwarded-For only when peer is in TRUSTED_PROXIES. */
  ip: text("ip"),
  /** Optional human-readable summary or short JSON of changed fields. */
  summary: text("summary"),
  at: integer("at").notNull().default(sql`(unixepoch())`),
});

/**
 * Feature flags. One row per flag key. `rules` and `variations` are JSON
 * blobs evaluated by `core/flags.ts`. The `default_value` is also a JSON-
 * encoded scalar so a single column carries bool/string/number/json types.
 */
export const featureFlags = sqliteTable("vaultbase_feature_flags", {
  key: text("key").primaryKey(),
  description: text("description").notNull().default(""),
  /** "bool" | "string" | "number" | "json" */
  type: text("type").notNull().default("bool"),
  /** Master kill switch — when 0, evaluation always returns `default_value`. */
  enabled: integer("enabled").notNull().default(1),
  /** JSON-encoded scalar matching `type`. */
  default_value: text("default_value").notNull().default("false"),
  /** JSON: array of named variations for multivariate flags. */
  variations: text("variations").notNull().default("[]"),
  /** JSON: ordered array of evaluation rules. */
  rules: text("rules").notNull().default("[]"),
  created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch())`),
});

/**
 * Reusable named predicates referenced from flag rules. Lets multiple
 * flags share a definition like "internal team" or "EU customers" without
 * duplicating conditions across rules.
 */
/**
 * Outbound webhooks — fire on record events + custom dispatch from hooks.
 * One row per registered subscription. Deliveries live in
 * `vaultbase_webhook_deliveries` for retry + audit.
 */
export const webhooks = sqliteTable("vaultbase_webhooks", {
  id: text("id").primaryKey(),
  name: text("name").notNull().default(""),
  url: text("url").notNull(),
  /** JSON array of event patterns: "<collection>.<verb>" or "*" or "<collection>.*". */
  events: text("events").notNull().default("[]"),
  /** HMAC-SHA-256 signing key — sent in X-Vaultbase-Signature. */
  secret: text("secret").notNull(),
  enabled: integer("enabled").notNull().default(1),
  retry_max: integer("retry_max").notNull().default(3),
  /** "exponential" (1s, 2s, 4s, …) or "fixed" (retry_delay_ms each time). */
  retry_backoff: text("retry_backoff").notNull().default("exponential"),
  retry_delay_ms: integer("retry_delay_ms").notNull().default(1000),
  timeout_ms: integer("timeout_ms").notNull().default(30000),
  /** JSON map of extra request headers (Authorization, X-API-Key, etc.). */
  custom_headers: text("custom_headers").notNull().default("{}"),
  created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch())`),
});

/**
 * Append-only-ish delivery log. Rows progress pending → succeeded / failed
 * → dead. The dispatcher claims next-due `pending` rows. Older entries
 * can be GCed by hand when storage gets tight.
 */
export const webhookDeliveries = sqliteTable("vaultbase_webhook_deliveries", {
  id: text("id").primaryKey(),
  webhook_id: text("webhook_id").notNull(),
  event: text("event").notNull(),
  /** JSON-encoded full delivery payload (record, etc.). */
  payload: text("payload").notNull(),
  attempt: integer("attempt").notNull().default(1),
  /** "pending" | "succeeded" | "failed" | "dead" */
  status: text("status").notNull().default("pending"),
  response_status: integer("response_status"),
  response_body: text("response_body"),
  error: text("error"),
  /** Earliest time the delivery is allowed to fire (used for retry backoff). */
  scheduled_at: integer("scheduled_at").notNull(),
  delivered_at: integer("delivered_at"),
  created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
});

export const flagSegments = sqliteTable("vaultbase_flag_segments", {
  name: text("name").primaryKey(),
  description: text("description").notNull().default(""),
  /** JSON: same Condition tree as rule.when. */
  conditions: text("conditions").notNull().default("{}"),
  created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch())`),
});

export type Collection = typeof collections.$inferSelect;
export type NewCollection = typeof collections.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Admin = typeof admin.$inferSelect;
export type File = typeof files.$inferSelect;
