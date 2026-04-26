import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const collections = sqliteTable("vaultbase_collections", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  fields: text("fields").notNull().default("[]"),
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
  data: text("data").notNull().default("{}"),
  created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch())`),
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
  collection_name: text("collection_name").notNull().default(""),
  event: text("event").notNull(),
  code: text("code").notNull().default(""),
  enabled: integer("enabled").notNull().default(1),
  created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch())`),
});

export const settings = sqliteTable("vaultbase_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updated_at: integer("updated_at").notNull().default(sql`(unixepoch())`),
});

export const logs = sqliteTable("vaultbase_logs", {
  id: text("id").primaryKey(),
  method: text("method").notNull(),
  path: text("path").notNull(),
  status: integer("status").notNull(),
  duration_ms: integer("duration_ms").notNull(),
  ip: text("ip"),
  auth_id: text("auth_id"),
  auth_type: text("auth_type"),
  auth_email: text("auth_email"),
  created_at: integer("created_at").notNull().default(sql`(unixepoch())`),
});

export type Log = typeof logs.$inferSelect;
export type NewLog = typeof logs.$inferInsert;

export type Collection = typeof collections.$inferSelect;
export type NewCollection = typeof collections.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Admin = typeof admin.$inferSelect;
export type File = typeof files.$inferSelect;
