/**
 * MCP Phase 2 — admin-write tools.
 *
 * Tools that mutate the deployment's configuration: schema management,
 * hooks/routes/jobs CRUD, flag mgmt, webhook test, settings, raw SQL,
 * data seeding. All gated by `mcp:admin` (or `admin`) scope, except the
 * raw-SQL tool which requires `mcp:sql`.
 *
 * Every mutation flows through the existing core APIs so collection
 * caches, audit log, prepared-statement caches, and rule recompilation
 * Just Work — MCP is purely a different transport for the same actions.
 */

import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm/sql";
import { getDb, getRawClient } from "../db/client.ts";
import { db } from "../db/index.ts";
import { hooks, routes, jobs, webhooks } from "../db/schema.ts";
import {
  createCollection,
  deleteCollection,
  parseFields,
  updateCollection,
  getCollection,
  type FieldDef,
} from "../core/collections.ts";
import {
  upsertFlag,
  deleteFlag,
  evaluate as evaluateFlag,
  type UpsertInput,
} from "../core/flags.ts";
import { dispatchEvent } from "../core/webhooks.ts";
import { runJob, validateCron, invalidateJobsCache } from "../core/jobs.ts";
import { invalidateRoutesCache, ROUTE_METHODS } from "../core/routes.ts";
import { invalidateHookCache } from "../core/hooks.ts";
import { getSetting, setSetting, getAllSettingsMasked, shouldEncryptSettingKey, SECRET_SETTING_MASK } from "../api/settings.ts";
import { createRecord } from "../core/records.ts";
import { ToolRegistry, asJsonText } from "./tools.ts";
import { hasScope } from "../core/api-tokens.ts";
import { recordAuditEvent } from "../core/audit-log.ts";
import { detectMutation, runSql } from "../core/sql-runner.ts";
import { codeFilesDir, createCodeFile, deleteCodeFile, updateCodeFile } from "../core/code-files.ts";

export function registerAdminWriteTools(reg: ToolRegistry): void {

  // ── collections: create / alter / delete ───────────────────────────────

  reg.register({
    requiredScope: "mcp:admin",
    definition: {
      name: "vaultbase.create_collection",
      description: "Create a new collection (base/auth/view). Pass fields as a JSON-shaped FieldDef[] array. Optional rules: list/view/create/update/delete. Returns the created collection row.",
      inputSchema: {
        type: "object",
        properties: {
          name:        { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]{0,62}$", description: "SQL-safe identifier; will form `vb_<name>` table" },
          type:        { type: "string", enum: ["base", "auth", "view"] },
          fields:      { type: "array", items: { type: "object" }, description: "FieldDef[]; see /reference/field-types" },
          view_query:  { type: "string", description: "Required + only allowed for type='view' — SELECT statement" },
          list_rule:   { type: ["string", "null"], description: "null = public; \"\" = admin only; expression otherwise" },
          view_rule:   { type: ["string", "null"] },
          create_rule: { type: ["string", "null"] },
          update_rule: { type: ["string", "null"] },
          delete_rule: { type: ["string", "null"] },
          history_enabled: { type: "boolean" },
        },
        required: ["name", "type", "fields"],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      const fields = (args.fields ?? []) as FieldDef[];
      if (!Array.isArray(fields)) throw new Error("fields must be a FieldDef array");
      const input: Parameters<typeof createCollection>[0] = {
        name: String(args.name ?? ""),
        type: (args.type ?? "base") as "base" | "auth" | "view",
        fields: JSON.stringify(fields),
      };
      if (typeof args.view_query  === "string") input.view_query  = args.view_query;
      if ("list_rule" in args)   input.list_rule   = args.list_rule as string | null;
      if ("view_rule" in args)   input.view_rule   = args.view_rule as string | null;
      if ("create_rule" in args) input.create_rule = args.create_rule as string | null;
      if ("update_rule" in args) input.update_rule = args.update_rule as string | null;
      if ("delete_rule" in args) input.delete_rule = args.delete_rule as string | null;
      if (args.history_enabled === true) input.history_enabled = 1;
      const col = await createCollection(input);
      return asJsonText(col);
    },
  });

  reg.register({
    requiredScope: "mcp:admin",
    definition: {
      name: "vaultbase.alter_collection",
      description: "Update a collection: rename, alter rules, replace the field set. Field changes ALTER TABLE the underlying SQL table — risky on populated collections, validate the change in dev first.",
      inputSchema: {
        type: "object",
        properties: {
          id_or_name: { type: "string", description: "Collection id or name" },
          name:       { type: "string", description: "New name (SQL-safe)" },
          fields:     { type: "array", items: { type: "object" }, description: "Replacement FieldDef[]" },
          list_rule:   { type: ["string", "null"] },
          view_rule:   { type: ["string", "null"] },
          create_rule: { type: ["string", "null"] },
          update_rule: { type: ["string", "null"] },
          delete_rule: { type: ["string", "null"] },
          history_enabled: { type: "boolean" },
        },
        required: ["id_or_name"],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      const id = String(args.id_or_name ?? "");
      const col = await getCollection(id);
      if (!col) throw new Error(`Collection '${id}' not found`);
      const patch: Parameters<typeof updateCollection>[1] = {};
      if (typeof args.name === "string") patch.name = args.name;
      if (Array.isArray(args.fields)) patch.fields = JSON.stringify(args.fields);
      if ("list_rule" in args)   patch.list_rule   = args.list_rule as string | null;
      if ("view_rule" in args)   patch.view_rule   = args.view_rule as string | null;
      if ("create_rule" in args) patch.create_rule = args.create_rule as string | null;
      if ("update_rule" in args) patch.update_rule = args.update_rule as string | null;
      if ("delete_rule" in args) patch.delete_rule = args.delete_rule as string | null;
      if (typeof args.history_enabled === "boolean") patch.history_enabled = args.history_enabled ? 1 : 0;
      const updated = await updateCollection(col.id, patch);
      return asJsonText(updated);
    },
  });

  reg.register({
    requiredScope: "mcp:admin",
    definition: {
      name: "vaultbase.delete_collection",
      description: "Drop a collection — drops the underlying vb_<name> table. Cascade rules on referencing relation fields fire as configured. Irreversible.",
      inputSchema: {
        type: "object",
        properties: { id_or_name: { type: "string" } },
        required: ["id_or_name"],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      const id = String(args.id_or_name ?? "");
      const col = await getCollection(id);
      if (!col) throw new Error(`Collection '${id}' not found`);
      await deleteCollection(col.id);
      return asJsonText({ deleted: true, name: col.name, id: col.id });
    },
  });

  // ── hooks: list / create / update / delete ─────────────────────────────

  reg.register({
    requiredScope: "mcp:read",
    definition: {
      name: "vaultbase.list_hooks",
      description: "List every server-side JS hook (before/after × CRUD). Returns id, name, collection, event, enabled flag, and the source code.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    handler: async () => asJsonText(await getDb().select().from(hooks)),
  });

  reg.register({
    requiredScope: "mcp:admin",
    definition: {
      name: "vaultbase.create_hook",
      description: "Register a new JS hook. Code is admin-trusted and runs in-process via `new AsyncFunction('ctx', code)` — has access to the full helper standard library (db, fs, http, mails, flags, webhooks). Hook lifecycle events are camelCase (beforeCreate / afterCreate / …).",
      inputSchema: {
        type: "object",
        properties: {
          name:            { type: "string" },
          collection_name: { type: "string", description: "Collection this hook fires for; '' for global" },
          event:           { type: "string", enum: ["beforeCreate", "afterCreate", "beforeUpdate", "afterUpdate", "beforeDelete", "afterDelete"] },
          code:            { type: "string", description: "Hook body — receives a single `ctx` object" },
          enabled:         { type: "boolean" },
        },
        required: ["name", "event", "code"],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      const id = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      // Normalise snake_case → camelCase so older LLM hint memory still works.
      const eventRaw = String(args.event ?? "");
      const event = eventRaw.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      const allowed = ["beforeCreate", "afterCreate", "beforeUpdate", "afterUpdate", "beforeDelete", "afterDelete"];
      if (!allowed.includes(event)) {
        throw new Error(`Invalid event '${eventRaw}'. Allowed: ${allowed.join(", ")}`);
      }
      if (codeFilesDir()) {
        const row = await createCodeFile("hook", {
          name: String(args.name ?? ""), collection_name: String(args.collection_name ?? ""), event, enabled: args.enabled === false ? 0 : 1,
        }, String(args.code ?? ""));
        return asJsonText({ created: true, id: row.id, event, file: row.file_path });
      }
      await getDb().insert(hooks).values({
        id,
        name: String(args.name ?? ""),
        collection_name: String(args.collection_name ?? ""),
        event,
        code: String(args.code ?? ""),
        enabled: args.enabled === false ? 0 : 1,
        created_at: now,
        updated_at: now,
      });
      invalidateHookCache();
      return asJsonText({ created: true, id, event });
    },
  });

  reg.register({
    requiredScope: "mcp:admin",
    definition: {
      name: "vaultbase.update_hook",
      description: "Patch an existing hook by id.",
      inputSchema: {
        type: "object",
        properties: {
          id:              { type: "string" },
          name:            { type: "string" },
          collection_name: { type: "string" },
          event:           { type: "string" },
          code:            { type: "string" },
          enabled:         { type: "boolean" },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      const patch: Record<string, unknown> = { updated_at: Math.floor(Date.now() / 1000) };
      for (const k of ["name", "collection_name", "code"] as const) {
        if (typeof args[k] === "string") patch[k] = args[k];
      }
      if (typeof args.event === "string") {
        patch.event = args.event.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      }
      if (typeof args.enabled === "boolean") patch.enabled = args.enabled ? 1 : 0;
      const current = (await getDb().select().from(hooks).where(eq(hooks.id, String(args.id))).limit(1))[0];
      if (current?.origin === "file") {
        // `code` replaces the whole file; the other fields are written into it.
        const { updated_at: _u, code, ...settings } = patch;
        const row = await updateCodeFile("hook", current, settings, code as string | undefined);
        return asJsonText({ updated: true, id: args.id, file: row.file_path });
      }
      await getDb().update(hooks).set(patch).where(eq(hooks.id, String(args.id)));
      invalidateHookCache();
      return asJsonText({ updated: true, id: args.id });
    },
  });

  reg.register({
    requiredScope: "mcp:admin",
    definition: {
      name: "vaultbase.delete_hook",
      description: "Delete a hook by id.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      const current = (await getDb().select().from(hooks).where(eq(hooks.id, String(args.id))).limit(1))[0];
      if (current?.origin === "file") {
        await deleteCodeFile(current);
        return asJsonText({ deleted: true, id: args.id, file: current.file_path });
      }
      await getDb().delete(hooks).where(eq(hooks.id, String(args.id)));
      invalidateHookCache();
      return asJsonText({ deleted: true, id: args.id });
    },
  });

  // ── routes (custom HTTP) ──────────────────────────────────────────────

  reg.register({
    requiredScope: "mcp:read",
    definition: {
      name: "vaultbase.list_routes",
      description: "List custom HTTP routes admins have authored (mounted under /api/v1/custom/<path>).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    handler: async () => asJsonText(await getDb().select().from(routes)),
  });

  reg.register({
    requiredScope: "mcp:admin",
    definition: {
      name: "vaultbase.create_route",
      description: "Author a new custom HTTP route. Mounted at /api/v1/custom/<path>. Code receives ctx (req/params/query/body/auth/helpers/set).",
      inputSchema: {
        type: "object",
        properties: {
          name:    { type: "string" },
          method:  { type: "string", enum: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
          path:    { type: "string", description: "Inner path, e.g. /hello or /users/:id" },
          code:    { type: "string", description: "Body — receives `ctx`" },
          enabled: { type: "boolean" },
        },
        required: ["method", "path", "code"],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      const id = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      // Mirror REST POST /admin/routes: uppercase method, validate, then
      // invalidate the runtime cache so the route is live immediately.
      const method = String(args.method ?? "GET").toUpperCase();
      if (!ROUTE_METHODS.includes(method as typeof ROUTE_METHODS[number])) {
        throw new Error(`Invalid method: ${method}. Allowed: ${ROUTE_METHODS.join(", ")}`);
      }
      const rawPath = String(args.path ?? "");
      const path = rawPath.startsWith("/") ? rawPath : "/" + rawPath;
      if (path.includes("..")) throw new Error("path cannot contain '..'");
      if (codeFilesDir()) {
        const row = await createCodeFile("route", {
          name: String(args.name ?? ""), method, path, enabled: args.enabled === false ? 0 : 1,
        }, String(args.code ?? ""));
        return asJsonText({ created: true, id: row.id, method, path, file: row.file_path });
      }
      await getDb().insert(routes).values({
        id,
        name:    String(args.name ?? ""),
        method,
        path,
        code:    String(args.code ?? ""),
        enabled: args.enabled === false ? 0 : 1,
        created_at: now,
        updated_at: now,
      });
      invalidateRoutesCache();
      return asJsonText({ created: true, id, method, path });
    },
  });

  reg.register({
    requiredScope: "mcp:admin",
    definition: {
      name: "vaultbase.delete_route",
      description: "Delete a custom route by id.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      const current = (await getDb().select().from(routes).where(eq(routes.id, String(args.id))).limit(1))[0];
      if (current?.origin === "file") {
        await deleteCodeFile(current);
        return asJsonText({ deleted: true, id: args.id, file: current.file_path });
      }
      await getDb().delete(routes).where(eq(routes.id, String(args.id)));
      invalidateRoutesCache();
      return asJsonText({ deleted: true, id: args.id });
    },
  });

  // ── jobs (cron) ────────────────────────────────────────────────────────

  reg.register({
    requiredScope: "mcp:read",
    definition: {
      name: "vaultbase.list_jobs",
      description: "List cron jobs (UTC schedule + admin-authored body).",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    handler: async () => asJsonText(await getDb().select().from(jobs)),
  });

  reg.register({
    requiredScope: "mcp:admin",
    definition: {
      name: "vaultbase.create_job",
      description: "Author a new cron job. cron is a 5-field UTC expression. mode 'inline' runs the body in the cron tick; 'worker:<queue>' enqueues onto a queue worker.",
      inputSchema: {
        type: "object",
        properties: {
          name:    { type: "string" },
          cron:    { type: "string", description: "5-field UTC cron expression" },
          code:    { type: "string", description: "Body — receives `ctx`" },
          mode:    { type: "string", enum: ["inline", "worker"], default: "inline" },
          enabled: { type: "boolean" },
        },
        required: ["name", "cron", "code"],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      const cronExpr = String(args.cron ?? "");
      const cronErr = validateCron(cronExpr);
      if (cronErr) throw new Error(`invalid cron: ${cronErr}`);
      const id = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      if (codeFilesDir()) {
        const row = await createCodeFile("job", {
          name: String(args.name ?? ""), cron: cronExpr, mode: args.mode === "worker" ? "worker:default" : "inline",
          enabled: args.enabled === false ? 0 : 1,
        }, String(args.code ?? ""));
        return asJsonText({ created: true, id: row.id, file: row.file_path });
      }
      await getDb().insert(jobs).values({
        id,
        name:    String(args.name ?? ""),
        cron:    cronExpr,
        code:    String(args.code ?? ""),
        mode:    args.mode === "worker" ? "worker:default" : "inline",
        enabled: args.enabled === false ? 0 : 1,
        created_at: now,
        updated_at: now,
      });
      invalidateJobsCache();
      return asJsonText({ created: true, id });
    },
  });

  reg.register({
    requiredScope: "mcp:admin",
    definition: {
      name: "vaultbase.run_job_now",
      description: "Run a cron job immediately, regardless of its schedule. Useful for debugging / one-shot scripted ops.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      const r = await runJob(String(args.id));
      return asJsonText(r);
    },
  });

  reg.register({
    requiredScope: "mcp:admin",
    definition: {
      name: "vaultbase.delete_job",
      description: "Delete a cron job by id.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      const current = (await getDb().select().from(jobs).where(eq(jobs.id, String(args.id))).limit(1))[0];
      if (current?.origin === "file") {
        await deleteCodeFile(current);
        return asJsonText({ deleted: true, id: args.id, file: current.file_path });
      }
      await getDb().delete(jobs).where(eq(jobs.id, String(args.id)));
      invalidateJobsCache();
      return asJsonText({ deleted: true, id: args.id });
    },
  });

  // ── flags ──────────────────────────────────────────────────────────────

  reg.register({
    requiredScope: "mcp:read",
    definition: {
      name: "vaultbase.evaluate_flag",
      description: "Evaluate a feature flag against a context object. Returns the resolved value (bool/string/number/json) plus the rule that won.",
      inputSchema: {
        type: "object",
        properties: {
          key:     { type: "string" },
          context: { type: "object", additionalProperties: true, description: "Targeting context, e.g. { userId, email, plan, country }" },
        },
        required: ["key"],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      const r = await evaluateFlag(String(args.key), (args.context ?? {}) as Record<string, unknown>);
      return asJsonText(r);
    },
  });

  reg.register({
    requiredScope: "mcp:admin",
    definition: {
      name: "vaultbase.update_flag",
      description: "Upsert a feature flag — type, default value, rules, variations. Existing flag at this key is replaced wholesale.",
      inputSchema: {
        type: "object",
        properties: {
          key:           { type: "string" },
          description:   { type: "string" },
          type:          { type: "string", enum: ["bool", "string", "number", "json"] },
          enabled:       { type: "boolean", description: "Master kill-switch" },
          default_value: { description: "JSON-encoded scalar matching `type`" },
          variations:    { type: "array",  description: "Multivariate variation list" },
          rules:         { type: "array",  description: "Ordered evaluation rules" },
        },
        required: ["key"],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      const input: UpsertInput = { key: String(args.key) } as UpsertInput;
      if (typeof args.description === "string") (input as { description: string }).description = args.description;
      if (typeof args.type === "string") (input as { type: string }).type = args.type;
      if (typeof args.enabled === "boolean") (input as { enabled: boolean }).enabled = args.enabled;
      if ("default_value" in args) (input as { default_value: unknown }).default_value = args.default_value;
      if (Array.isArray(args.variations)) (input as { variations: unknown[] }).variations = args.variations;
      if (Array.isArray(args.rules)) (input as { rules: unknown[] }).rules = args.rules;
      const r = await upsertFlag(input);
      return asJsonText(r);
    },
  });

  reg.register({
    requiredScope: "mcp:admin",
    definition: {
      name: "vaultbase.delete_flag",
      description: "Delete a feature flag by key.",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      await deleteFlag(String(args.key));
      return asJsonText({ deleted: true, key: args.key });
    },
  });

  // ── webhooks: list + dispatch test event ───────────────────────────────

  reg.register({
    requiredScope: "mcp:read",
    definition: {
      name: "vaultbase.list_webhooks",
      description: "List configured webhooks (URL, events, retry config, secret). Secret values are NOT redacted — treat the response as sensitive.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    handler: async () => asJsonText(await getDb().select().from(webhooks)),
  });

  reg.register({
    requiredScope: "mcp:write",
    definition: {
      name: "vaultbase.dispatch_webhook_event",
      description: "Fire a custom webhook event. Subscribers matching the event pattern receive an HMAC-signed POST. Use to test integrations without creating a real record.",
      inputSchema: {
        type: "object",
        properties: {
          event:   { type: "string", description: "Event label, e.g. 'billing.invoice_paid'" },
          payload: { type: "object", additionalProperties: true },
        },
        required: ["event"],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      const r = await dispatchEvent({
        event: String(args.event),
        data: (args.payload ?? {}) as Record<string, unknown>,
      });
      return asJsonText(r);
    },
  });

  // ── settings ───────────────────────────────────────────────────────────

  // Settings tools require mcp:admin (not mcp:read). Secret-valued settings
  // (smtp.password, oauth2.<provider>.client_secret, FCM service account, …)
  // read as SECRET_SETTING_MASK here, as in the admin API; they can be
  // written but not read back.
  reg.register({
    requiredScope: "mcp:admin",
    definition: {
      name: "vaultbase.list_settings",
      description: "List every setting key/value. Secret values (passwords, client secrets, keys, tokens) are masked — requires mcp:admin scope.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    handler: async () => asJsonText(getAllSettingsMasked()),
  });

  reg.register({
    requiredScope: "mcp:admin",
    definition: {
      name: "vaultbase.get_setting",
      description: "Read a single setting by key. Secret values are masked — requires mcp:admin scope.",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      const key = String(args.key);
      const v = getSetting(key, "");
      return asJsonText({ key: args.key, value: shouldEncryptSettingKey(key) && v !== "" ? SECRET_SETTING_MASK : v });
    },
  });

  reg.register({
    requiredScope: "mcp:admin",
    definition: {
      name: "vaultbase.update_setting",
      description: "Write a setting key. Encryption-at-rest applies automatically for known sensitive keys (smtp.password, oauth2.<provider>.client_secret, etc).",
      inputSchema: {
        type: "object",
        properties: {
          key:   { type: "string" },
          value: { type: "string" },
        },
        required: ["key", "value"],
        additionalProperties: false,
      },
    },
    handler: async (args) => {
      const key = String(args.key);
      // A masked value read back from list/get_setting: keep the stored one.
      if (shouldEncryptSettingKey(key) && String(args.value) === SECRET_SETTING_MASK) {
        return asJsonText({ updated: false, key: args.key, reason: "masked value; stored secret kept" });
      }
      await setSetting(key, String(args.value));
      return asJsonText({ updated: true, key: args.key });
    },
  });

  // ── raw SQL (read-only by default) ─────────────────────────────────────

  reg.register({
    requiredScope: "mcp:sql",
    definition: {
      name: "vaultbase.run_sql",
      description: "Run a raw SQL query against the live SQLite DB. Read-only by default (a separate read-only connection, 5 s limit). Write/DDL queries require `allow_write: true` AND the mcp:admin scope, and bypass every safety net except the audit log (RBAC, validation, hooks). Avoid unless absolutely necessary; use the typed tools instead. Bound result set: 100 rows.\n\nSchema convention: every collection (base + auth) has a `vb_<name>` table. Auth collections additionally have inline columns for `email`, `password_hash`, `email_verified`, `totp_secret`, `totp_enabled`, `is_anonymous`, `password_reset_at`. Inserting auth users via raw SQL bypasses password hashing + email-verification flows — prefer `POST /api/v1/auth/<col>/register` (or the existing typed CRUD path) for login-capable users.",
      inputSchema: {
        type: "object",
        properties: {
          query:  { type: "string", description: "SQL — typically a SELECT" },
          params: { type: "array", description: "Bound parameters (positional)" },
          allow_write: { type: "boolean", description: "Permit non-SELECT statements. Default false." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      const q = String(args.query ?? "").trim();
      if (!q) throw new Error("query is required");
      const params = (Array.isArray(args.params) ? args.params : []) as Array<string | number | bigint | boolean | null | Uint8Array>;
      const write = args.allow_write === true;
      // Every call is audited: the tool can read any table (password hashes
      // included) and, with allow_write, change anything.
      const audit = (status: number, summary: string) => recordAuditEvent({
        actor: { id: ctx.adminId, email: ctx.adminEmail },
        method: "MCP",
        path: "vaultbase.run_sql",
        action: write ? "mcp.sql.write" : "mcp.sql.read",
        target: ctx.tokenName,
        status,
        summary: `${summary} | ${q}`,
      });
      if (write) {
        // `allow_write` is the caller's own flag, so on its own it was no
        // control at all: any `mcp:sql` token could rewrite the database.
        // Writes take the admin scope as well.
        if (!hasScope(ctx.scopes, "mcp:admin")) {
          await audit(403, "refused: allow_write needs mcp:admin");
          throw new Error("allow_write requires the mcp:admin (or admin) scope; mcp:sql alone is read-only");
        }
        const r = await db.run(q, params);
        await audit(200, `changes=${r.changes}`);
        return asJsonText({ changes: r.changes, lastInsertRowid: String(r.lastInsertRowid) });
      }
      if (!/^\s*(WITH|SELECT|EXPLAIN|PRAGMA)\b/i.test(q)) {
        await audit(400, "refused: not a read");
        throw new Error("non-SELECT requires allow_write: true (and the mcp:admin scope); prefer the typed tools");
      }
      // Reads go through the admin SQL runner: a separate read-only
      // connection with query_only on (so a PRAGMA can't change the server's
      // own connection) and the same time budget.
      const file = db.name === "sqlite" ? getRawClient().filename : "";
      if (db.name === "sqlite" && (!file || file === ":memory:")) {
        // An in-memory database (tests) has no file a second connection can
        // open: keyword-check and read it in place.
        const bad = detectMutation(q);
        if (bad) throw new Error(`'${bad}' is blocked without allow_write: true`);
        // query_only makes SQLite itself refuse writes, whatever the keyword
        // scan missed.
        await db.exec("PRAGMA query_only = ON");
        let all: unknown[];
        try { all = await db.all<unknown>(q, params); } finally { await db.exec("PRAGMA query_only = OFF"); }
        await audit(200, `rows=${all.length}`);
        return asJsonText({ rowCount: all.length, truncatedTo: Math.min(all.length, 100), rows: all.slice(0, 100) });
      }
      const res = await runSql({ sql: q, params, dbPath: file, mode: "readonly" });
      if (!res.ok) {
        await audit(400, `error: ${res.error ?? ""}`);
        throw new Error(res.error ?? "query failed");
      }
      await audit(200, `rows=${res.rowCount}`);
      const rows = res.rows.slice(0, 100).map((r) => Object.fromEntries(res.columns.map((c, i) => [c, r[i]])));
      return asJsonText({ rowCount: res.rowCount, truncatedTo: rows.length, rows });
    },
  });

  // ── seed (factory-style data gen) ──────────────────────────────────────

  reg.register({
    requiredScope: "mcp:write",
    definition: {
      name: "vaultbase.seed",
      description: "Generate fake records for a collection. Per-field-type defaults: text → Lorem-ipsum, number → bounded random, bool → coin flip, email → fake address, date/autodate → recent random, geoPoint → random world coords, select → random from values, relation → random existing target. Hard cap: 1000 records per call.",
      inputSchema: {
        type: "object",
        properties: {
          collection: { type: "string" },
          count:      { type: "integer", minimum: 1, maximum: 1000 },
          overrides:  { type: "object", additionalProperties: true, description: "Per-field literal values applied to every seeded record" },
        },
        required: ["collection", "count"],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      const slug = String(args.collection ?? "");
      const count = Math.min(1000, Math.max(1, Number(args.count) || 0));
      const col = await getCollection(slug);
      if (!col) throw new Error(`Collection '${slug}' not found`);
      const overrides = (args.overrides ?? {}) as Record<string, unknown>;
      const fields = parseFields(col.fields);
      let created = 0;
      const errors: string[] = [];
      for (let i = 0; i < count; i++) {
        const data: Record<string, unknown> = {};
        for (const f of fields) {
          if (f.system || f.implicit || f.type === "autodate") continue;
          if (f.name in overrides) { data[f.name] = overrides[f.name]; continue; }
          data[f.name] = generateFakeValue(f, i);
        }
        try {
          await createRecord(slug, data, { id: ctx.adminId, type: "admin", email: ctx.adminEmail });
          created++;
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
          if (errors.length > 5) break;
        }
      }
      return asJsonText({ created, requested: count, errors: errors.slice(0, 5) });
    },
  });

  // Suppress unused — sql is exported for potential future use here.
  void sql;
}

// ── Fake-value generator ───────────────────────────────────────────────

const LOREM = [
  "lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "elit",
  "sed", "do", "eiusmod", "tempor", "incididunt", "labore", "magna", "aliqua",
];

function pick<T>(arr: readonly T[]): T { return arr[Math.floor(Math.random() * arr.length)] as T; }

function generateFakeValue(f: FieldDef, idx: number): unknown {
  switch (f.type) {
    case "text":
    case "editor": {
      const min = (f.options?.min as number | undefined) ?? 3;
      const max = (f.options?.max as number | undefined) ?? 30;
      const wordCount = Math.max(1, Math.min(15, Math.floor((min + max) / 2 / 6)));
      const words = Array.from({ length: wordCount }, () => pick(LOREM));
      return words.join(" ").replace(/^./, (c) => c.toUpperCase());
    }
    case "number": {
      const min = (f.options?.min as number | undefined) ?? 0;
      const max = (f.options?.max as number | undefined) ?? 1000;
      return Math.floor(min + Math.random() * (max - min));
    }
    case "bool":
      return Math.random() < 0.5;
    case "email":
      return `user${idx}_${Math.random().toString(36).slice(2, 8)}@example.com`;
    case "url":
      return `https://example.com/${Math.random().toString(36).slice(2, 10)}`;
    case "color":
      return `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}`;
    case "date":
    case "autodate": {
      const now = Math.floor(Date.now() / 1000);
      return now - Math.floor(Math.random() * 90 * 86400); // last 90d
    }
    case "select": {
      const values = (f.options?.values as string[] | undefined) ?? [];
      if (values.length === 0) return "";
      if (f.options?.multiple) {
        const n = 1 + Math.floor(Math.random() * Math.min(3, values.length));
        const shuffled = [...values].sort(() => Math.random() - 0.5);
        return shuffled.slice(0, n);
      }
      return pick(values);
    }
    case "geoPoint":
      return {
        lat: Math.random() * 180 - 90,
        lng: Math.random() * 360 - 180,
      };
    case "vector": {
      const dims = (f.options?.dimensions as number | undefined) ?? 8;
      return Array.from({ length: dims }, () => Math.random() * 2 - 1);
    }
    case "json":
      return { idx, sample: pick(LOREM) };
    case "relation":
    case "file":
      return ""; // best-effort — relations need lookup, files need uploads
    case "password":
      return "FakeSeedPwd!2025";
    default:
      return pick(LOREM);
  }
}
