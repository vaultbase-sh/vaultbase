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
  created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch())`),
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
  expires_at: integer("expires_at").notNull(),
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
  last_run_at: integer("last_run_at"),
  next_run_at: integer("next_run_at"),
  last_status: text("last_status"),       // "ok" | "error"
  last_error: text("last_error"),
  created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch())`),
});

export const settings = sqliteTable("vaultbase_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch())`),
});

export type Collection = typeof collections.$inferSelect;
export type NewCollection = typeof collections.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Admin = typeof admin.$inferSelect;
export type File = typeof files.$inferSelect;
