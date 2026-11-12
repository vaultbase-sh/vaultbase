/**
 * The settings keys Vaultbase reads. `PATCH /admin/settings` stores whatever
 * key it is given, so a typo (`auth.password.min_length` for
 * `password.min_length`) answered 200 and changed nothing. A key that isn't
 * here now gets a `Vaultbase-Warning`; a later release refuses it.
 *
 * No imports: api/settings.ts uses this, and most modules import that.
 * setting-keys.test.ts checks the lists below against the modules that own
 * them and against every key the server and the admin read or send.
 */

const AUTH_FEATURES = ["otp", "mfa", "anonymous", "impersonation"];
const TOKEN_KINDS = ["admin", "user", "anonymous", "impersonate", "refresh", "file"];
const EMAIL_KINDS = ["verify", "reset", "email_change", "invite", "otp"];

const EXACT = new Set<string>([
  "admin.sidebar.pinned",
  "api.openapi_public",
  "app.url",
  "audit.retention_days",
  "auth.lockout.duration_seconds", "auth.lockout.max_attempts", "auth.session.max_seconds",
  ...AUTH_FEATURES.map((f) => `auth.${f}.enabled`),
  ...TOKEN_KINDS.map((k) => `auth.${k}.window_seconds`),
  "backups.cron", "backups.enabled", "backups.files", "backups.keep",
  "backups.last_error", "backups.last_run_at", "backups.next_run",
  "backups.s3.access_key_id", "backups.s3.bucket", "backups.s3.enabled", "backups.s3.endpoint",
  "backups.s3.prefix", "backups.s3.region", "backups.s3.secret_access_key",
  "cors.credentials", "cors.headers", "cors.max_age", "cors.methods", "cors.origins",
  "email.transport",
  ...EMAIL_KINDS.flatMap((k) => [`email.${k}.subject`, `email.${k}.body`]),
  "files.max_upload_size", "files.orphan_cleanup",
  "flags.public_evaluate",
  "hooks.timeout_ms", "hooks.after_timeout_ms", "hooks.http.allow", "hooks.http.deny",
  "jobs.timeout_ms", "queues.timeout_ms", "routes.timeout_ms",
  "maintenance.retention_days",
  "maintenance_mode.background", "maintenance_mode.enabled", "maintenance_mode.level",
  "maintenance_mode.message", "maintenance_mode.routes", "maintenance_mode.until",
  "metrics.enabled", "metrics.token",
  "oauth2.allowed_redirect_uris",
  "password.hibp_check", "password.min_length", "password.require_digit",
  "password.require_lower", "password.require_symbol", "password.require_upper",
  "rate_limit.enabled", "rate_limit.max", "rate_limit.rules", "rate_limit.window_ms",
  "s3.access_key_id", "s3.bucket", "s3.endpoint", "s3.public_url", "s3.region", "s3.secret_access_key",
  "security.allowed_origins", "security.trusted_proxies",
  "smtp.enabled", "smtp.from", "smtp.host", "smtp.pass", "smtp.port", "smtp.secure", "smtp.user",
  "storage.driver",
  "update_check.checked_at", "update_check.enabled", "update_check.error", "update_check.latest_version",
]);

/** Keys with a name in them that the server can't list: a provider, a theme knob, an admin's id. */
const FAMILIES: RegExp[] = [
  // Sign-in providers, the built-in ones and those an extension registers.
  /^oauth2\.[A-Za-z0-9_-]+\.[a-z0-9_]+$/,
  // Push providers, likewise.
  /^notifications\.providers\.[A-Za-z0-9_-]+\.[a-z0-9_]+$/,
  // A storage driver an extension registers reads `storage.<name>.*`.
  /^storage\.[A-Za-z0-9_-]+\.[a-z0-9_.]+$/,
  // The admin's theme colours; the admin UI owns the list.
  /^theme\.[a-z0-9_]+$/,
  // One admin's favourite pages.
  /^admin\.favorites\.[A-Za-z0-9_-]+$/,
  // Markers the server writes for one-time migrations.
  /^_migrations\.[A-Za-z0-9_.]+$/,
];

const registered: Array<string | RegExp> = [];

/**
 * Declare settings keys an extension reads (an email transport's API key, a
 * provider's own options), so setting them isn't reported as unknown.
 */
export function registerSettingKeys(...keys: Array<string | RegExp>): () => void {
  registered.push(...keys);
  return () => {
    for (const k of keys) {
      const i = registered.indexOf(k);
      if (i >= 0) registered.splice(i, 1);
    }
  };
}

/** Whether something reads `key`. */
export function isKnownSettingKey(key: string): boolean {
  if (EXACT.has(key)) return true;
  if (FAMILIES.some((re) => re.test(key))) return true;
  return registered.some((k) => (typeof k === "string" ? k === key : k.test(key)));
}

/** For the test that keeps these in step with their owners. */
export const _SETTING_KEY_LISTS = { AUTH_FEATURES, TOKEN_KINDS, EMAIL_KINDS, EXACT };
